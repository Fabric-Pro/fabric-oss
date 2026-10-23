import { ORPCError } from "@orpc/server";
import {
	confirmRecipientBrand,
	getRecipientBrand,
	normalizeRecipientBrandFields,
	RECIPIENT_BRAND_MAX_COLORS,
	RECIPIENT_BRAND_MAX_NAME_LENGTH,
	RecipientBrandValidationError,
} from "@repo/database";
import {
	type NormalizeLogoFailureCode,
	normalizeWebsiteUrl,
} from "@repo/integrations/website-brand";
import { BRAND_ASSET_REJECTION_CODES } from "@repo/utils/brand-assets";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireGlossyOrProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";
import {
	deleteRecipientBrandObjects,
	deleteUnsavedRecipientLogo,
	listRecipientLogoPendingKeys,
	loadRecipientBrandProject,
	promoteRecipientLogo,
	recipientLogoPendingKey,
} from "../../lib/recipient-brand";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

type Promotion =
	| { ok: true; key: string; hash: string }
	| { ok: false; code: NormalizeLogoFailureCode };

/**
 * Step 1 for an editor's upload or fetch: promote the pending object a token
 * names through the shared pipeline (`promoteRecipientLogo`). A pending
 * object belongs to this one confirmation, so a refused one is deleted here.
 */
async function promotePendingLogo(
	projectId: string,
	token: string,
): Promise<Promotion> {
	// Built from the gated project and a token-shaped value only: a key, a
	// path, `..`, or another project's object cannot be named here.
	const pendingKey = recipientLogoPendingKey(projectId, token);
	const promotion = await promoteRecipientLogo(projectId, pendingKey);
	if (promotion.outcome === "missing") {
		// Never issued for this project, already consumed, or cleaned up
		// after another editor's confirmation.
		throw new ORPCError("BAD_REQUEST", {
			message: "The logo upload was not found. Upload or fetch it again.",
		});
	}
	if (promotion.outcome === "rejected") {
		await deleteRecipientBrandObjects(projectId, [pendingKey]);
		return { ok: false, code: promotion.code };
	}
	return { ok: true, key: promotion.key, hash: promotion.hash };
}

/**
 * Confirm the project's recipient brand (Fizzy #2589).
 *
 * The editor sends the whole brand plus the `version` they read. A new logo
 * is named by the token a fetch or an upload returned, and is promoted in
 * three ordered steps so storage and database never disagree:
 *   1. normalize the pending object and copy it to a new immutable key;
 *   2. the version compare-and-set that records that key;
 *   3. on `applied`, delete the superseded logo and every pending object —
 *      each belongs to a flow that read an older version and can now only
 *      conflict; on `conflict`, delete the object this attempt promoted, so
 *      one editor cannot confirm over another's change without seeing it; on
 *      an error, delete it only when the stored row does not point at it.
 * Step 3 is best-effort: a leftover object is unreferenced, stays under the
 * project prefix, and goes when the project does.
 *
 * AUTHORIZATION: `requireGlossyOrProposalArtifactEnabled` first (GLOSSY_EDITION
 * and PROPOSAL_ARTIFACT both off → NOT_FOUND for every caller), then
 * `requireProjectPermission(DOCUMENT_UPDATE)`, then the shared recipient
 * brand write gate: `canEditProject` and a `member` row in the project's
 * owning organization, so a project guest editor is FORBIDDEN.
 */
export const updateRecipientBrandProcedure = tenantProtectedProcedure
	.use(requireGlossyOrProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "PUT",
		path: "/projects/{projectId}/recipient-brand",
		tags: ["Projects", "Glossy"],
		summary: "Confirm the recipient brand",
		description:
			"Save the recipient brand if nobody changed it since `expectedVersion` was read; otherwise report a conflict.",
	})
	.input(
		z.object({
			projectId: z.string(),
			/** The version `recipientBrand.get` returned; 0 when there was none. */
			expectedVersion: z.number().int().min(0),
			name: z.string().max(RECIPIENT_BRAND_MAX_NAME_LENGTH).nullable(),
			website: z.string().max(2048).nullable(),
			colors: z
				.array(z.string().regex(HEX_COLOR))
				.max(RECIPIENT_BRAND_MAX_COLORS),
			logo: z.discriminatedUnion("action", [
				z.object({ action: z.literal("keep") }),
				z.object({ action: z.literal("remove") }),
				z.object({
					action: z.literal("replace"),
					/** The token a fetch or an upload URL returned. */
					token: z.string().max(128),
				}),
			]),
		}),
	)
	.output(
		z.discriminatedUnion("outcome", [
			z.object({
				outcome: z.literal("applied"),
				version: z.number().int(),
			}),
			z.object({ outcome: z.literal("conflict") }),
			z.object({
				outcome: z.literal("logoRejected"),
				code: z.enum(BRAND_ASSET_REJECTION_CODES),
			}),
		]),
	)
	.handler(async ({ input, context }) => {
		const { projectId, expectedVersion } = input;
		const { organizationId } = await loadRecipientBrandProject({
			projectId,
			userId: context.user.id,
			write: true,
		});

		// Everything the compare-and-set will validate, validated BEFORE a
		// logo is promoted, so a typo cannot leave an orphaned object behind.
		const website = input.website?.trim()
			? normalizeWebsiteUrl(input.website)
			: null;
		if (input.website?.trim() && !website) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Enter the recipient's public website, like example.com",
			});
		}
		let fields: ReturnType<typeof normalizeRecipientBrandFields>;
		try {
			fields = normalizeRecipientBrandFields(projectId, {
				name: input.name,
				website,
				colors: input.colors,
			});
		} catch (error) {
			if (error instanceof RecipientBrandValidationError) {
				throw new ORPCError("BAD_REQUEST", {
					message: "The recipient brand is not valid",
					data: { code: error.code },
				});
			}
			throw error;
		}

		// An early answer for the common stale case: someone confirmed since
		// this editor read. The compare-and-set below stays the authority;
		// this only spares a promotion that could not win.
		const row = await getRecipientBrand(projectId);
		// A row left behind in another organization is no recipient brand,
		// and its logo is never kept into this one.
		const current = row?.organizationId === organizationId ? row : null;
		if ((current?.version ?? 0) !== expectedVersion) {
			return { outcome: "conflict" as const };
		}

		let logoKey: string | null = null;
		let logoHash: string | null = null;
		let promotedKey: string | null = null;
		if (input.logo.action === "keep") {
			// Unchanged by construction: the compare-and-set applies only at
			// the version this row was read at. The hash goes with the logo,
			// so a later website fetch of the same logo reads as the same.
			logoKey = current?.logoKey ?? null;
			logoHash = current?.logoHash ?? null;
		} else if (input.logo.action === "replace") {
			const promotion = await promotePendingLogo(
				projectId,
				input.logo.token,
			);
			if (!promotion.ok) {
				return {
					outcome: "logoRejected" as const,
					code: promotion.code,
				};
			}
			logoKey = promotion.key;
			logoHash = promotion.hash;
			promotedKey = promotion.key;
		}

		let result: Awaited<ReturnType<typeof confirmRecipientBrand>>;
		try {
			result = await confirmRecipientBrand({
				projectId,
				expectedVersion,
				...fields,
				logoKey,
				logoHash,
				updatedById: context.user.id,
				organizationId,
			});
		} catch (error) {
			await deleteUnsavedRecipientLogo(projectId, promotedKey);
			throw error;
		}

		// `stale` answers only a confirmation that names a suggestion, which
		// this save never does; it is a conflict here all the same.
		if (result.outcome !== "applied") {
			if (promotedKey) {
				await deleteRecipientBrandObjects(projectId, [promotedKey]);
			}
			return { outcome: "conflict" as const };
		}

		const superseded = await listRecipientLogoPendingKeys(projectId);
		if (result.previousLogoKey && result.previousLogoKey !== logoKey) {
			superseded.push(result.previousLogoKey);
		}
		await deleteRecipientBrandObjects(projectId, superseded);

		// Field names only: a recipient's name is the kind of client detail
		// an audit reader has no need for.
		const changedFields = [
			(current?.name ?? null) !== fields.name && "name",
			(current?.website ?? null) !== fields.website && "website",
			(current?.colors ?? []).join(",") !== fields.colors.join(",") &&
				"colors",
			(current?.logoKey ?? null) !== logoKey && "logo",
		].filter((field): field is string => typeof field === "string");
		recordAuditFromRequest(context, {
			action: "project.recipient_brand.updated",
			category: "project",
			organizationId,
			projectId,
			resource: { type: "project", id: projectId, name: null },
			metadata: { version: result.version, changedFields },
		});

		return { outcome: "applied" as const, version: result.version };
	});
