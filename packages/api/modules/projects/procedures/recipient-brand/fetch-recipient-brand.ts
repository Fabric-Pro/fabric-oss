import { ORPCError } from "@orpc/server";
import {
	fetchWebsiteBrand,
	normalizeWebsiteUrl,
	WEBSITE_BRAND_FAILURE_CODES,
	WEBSITE_BRAND_RATE_LIMIT,
	websiteBrandRateLimitKey,
} from "@repo/integrations/website-brand";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { checkRateLimit } from "../../../../lib/rate-limit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	loadRecipientBrandProject,
	newRecipientLogoToken,
	recipientBrandBucket,
	recipientLogoPendingKey,
	signRecipientLogoRead,
} from "../../lib/recipient-brand";
import { requireGlossyEnabled } from "../../lib/glossy-feature";

/**
 * Propose a recipient brand from the recipient's own website (Fizzy #2589,
 * R33, R34, KTD22, KTD23).
 *
 * The extractor is SSRF-safe and deterministic; this procedure adds the parts
 * it leaves to its caller: the per-user rate limit (checked BEFORE any
 * outbound request), a new tokened pending object for the logo it found, and
 * the audit record. Nothing is saved to the project — the editor confirms,
 * edits or discards the proposal through `recipientBrand.update`.
 *
 * A failure is an answer, not an error (R34, AE9): a fixed code and whatever
 * colors were found, so the form falls back to manual entry. It never carries
 * a host, resolver message or upstream text.
 *
 * AUTHORIZATION: `requireGlossyEnabled` first (gate off → NOT_FOUND for every
 * caller), then `requireProjectPermission(DOCUMENT_UPDATE)`, then the shared
 * recipient brand gate including `canEditProject`.
 */
export const fetchRecipientBrandProcedure = tenantProtectedProcedure
	.use(requireGlossyEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/recipient-brand/fetch",
		tags: ["Projects", "Glossy"],
		summary: "Fetch a recipient brand from a website",
		description:
			"Fetch a logo and brand colors from the recipient's website as a proposal to confirm; nothing is saved.",
	})
	.input(
		z.object({
			projectId: z.string(),
			website: z.string().trim().min(1).max(2048),
		}),
	)
	.output(
		z.discriminatedUnion("outcome", [
			z.object({
				outcome: z.literal("fetched"),
				/** The website as it will be stored: `https://host`. */
				website: z.string(),
				/** Names the pending logo on confirmation. */
				token: z.string(),
				logoUrl: z.string(),
				colors: z.array(z.string()),
			}),
			z.object({
				outcome: z.literal("failed"),
				code: z.enum(WEBSITE_BRAND_FAILURE_CODES),
				colors: z.array(z.string()),
			}),
		]),
	)
	.handler(async ({ input, context, signal }) => {
		const { organizationId } = await loadRecipientBrandProject({
			projectId: input.projectId,
			userId: context.user.id,
			write: true,
		});

		const rateLimit = await checkRateLimit(
			websiteBrandRateLimitKey(context.user.id),
			WEBSITE_BRAND_RATE_LIMIT.limit,
			WEBSITE_BRAND_RATE_LIMIT.windowMs,
		);
		if (!rateLimit.allowed) {
			if (rateLimit.statusCode === 503) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "Rate limit service temporarily unavailable",
				});
			}
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `Too many website lookups. Please try again in ${rateLimit.resetInSeconds} seconds.`,
			});
		}

		const website = normalizeWebsiteUrl(input.website);
		const result = await fetchWebsiteBrand(input.website, { signal });

		// Every outbound attempt is recorded — host and fixed code only, never
		// page content. Recorded before the logo is stored so a storage
		// failure below cannot lose the record of the request we made.
		recordAuditFromRequest(context, {
			action: "project.recipient_brand.fetched",
			category: "project",
			outcome: result.ok ? "success" : "failure",
			organizationId,
			projectId: input.projectId,
			resource: { type: "project", id: input.projectId, name: null },
			metadata: {
				host: website ? new URL(website).hostname : null,
				code: result.ok ? "ok" : result.code,
			},
		});

		// The extractor parses the input exactly as `normalizeWebsiteUrl`
		// does, so a success always has a website; the second test only
		// narrows the type.
		if (!result.ok || !website) {
			return {
				outcome: "failed" as const,
				code: result.ok ? ("blocked" as const) : result.code,
				colors: result.colors,
			};
		}

		const token = newRecipientLogoToken();
		const pendingKey = recipientLogoPendingKey(input.projectId, token);
		try {
			await getStorageProvider().uploadFile(pendingKey, result.logoPng, {
				bucket: recipientBrandBucket(),
				contentType: "image/png",
			});
		} catch {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Could not store the fetched logo",
			});
		}

		return {
			outcome: "fetched" as const,
			website,
			token,
			logoUrl: await signRecipientLogoRead(pendingKey),
			colors: result.colors,
		};
	});
