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
	LOGO_MAX_INPUT_BYTES,
	type NormalizeLogoFailureCode,
	normalizeLogo,
	normalizeWebsiteUrl,
} from "@repo/integrations/website-brand";
import { getStorageProvider } from "@repo/storage";
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
	listRecipientLogoPendingKeys,
	loadRecipientBrandProject,
	newRecipientLogoCurrentKey,
	recipientBrandBucket,
	recipientLogoPendingKey,
} from "../../lib/recipient-brand";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const LOGO_REJECTION_CODES = [
	"too_large",
	"unsupported",
] as const satisfies readonly NormalizeLogoFailureCode[];

type Promotion =
	| { ok: true; key: string }
	| { ok: false; code: NormalizeLogoFailureCode };

function storageFailure(): ORPCError<"INTERNAL_SERVER_ERROR", unknown> {
	return new ORPCError("INTERNAL_SERVER_ERROR", {
		message: "Could not save the logo",
	});
}

/**
 * KTD23 step 1: normalize the pending object a token names and copy it to a
 * new immutable `current/{promotionId}.png`. Nothing references the new
 * object yet, so any failure here changes nothing.
 *
 * The bytes are untrusted whichever way they arrived — an editor's upload or
 * a website fetch — so both go through the same hardened pipeline, which
 * refuses anything that is not a raster PNG, JPEG, GIF or WebP (an SVG or an
 * HTML page uploaded as `image/png` included) and re-encodes the rest.
 */
async function promotePendingLogo(
	projectId: string,
	token: string,
): Promise<Promotion> {
	// Built from the gated project and a token-shaped value only: a key, a
	// path, `..`, or another project's object cannot be named here.
	const pendingKey = recipientLogoPendingKey(projectId, token);
	const storage = getStorageProvider();
	const bucket = recipientBrandBucket();

	let metadata: Awaited<ReturnType<typeof storage.getFileMetadata>>;
	try {
		metadata = await storage.getFileMetadata(pendingKey, { bucket });
	} catch {
		throw storageFailure();
	}
	if (!metadata) {
		// Never issued for this project, already consumed, or cleaned up
		// after another editor's confirmation.
		throw new ORPCError("BAD_REQUEST", {
			message: "The logo upload was not found. Upload or fetch it again.",
		});
	}

	let normalized: Awaited<ReturnType<typeof normalizeLogo>>;
	if (metadata.size > LOGO_MAX_INPUT_BYTES) {
		normalized = { ok: false, code: "too_large" };
	} else {
		let bytes: Buffer;
		try {
			bytes = (await storage.downloadFile(pendingKey, { bucket })).data;
		} catch {
			throw storageFailure();
		}
		normalized = await normalizeLogo(bytes);
	}
	if (!normalized.ok) {
		await deleteRecipientBrandObjects(projectId, [pendingKey]);
		return { ok: false, code: normalized.code };
	}

	const key = newRecipientLogoCurrentKey(projectId);
	try {
		await storage.uploadFile(key, normalized.png, {
			bucket,
			contentType: "image/png",
		});
	} catch {
		throw storageFailure();
	}
	return { ok: true, key };
}

/**
 * Confirm the project's recipient brand (Fizzy #2589, R32, R33, KTD23).
 *
 * The editor sends the whole brand plus the `version` they read. A new logo
 * is named by the token a fetch or an upload returned, and is promoted in
 * three ordered steps so storage and database never disagree:
 *   1. normalize the pending object and copy it to a new immutable key;
 *   2. the version compare-and-set that records that key;
 *   3. on `applied`, delete the superseded logo and every pending object —
 *      each belongs to a flow that read an older version and can now only
 *      conflict; on `conflict`, delete the object this attempt promoted, so
 *      one editor cannot confirm over another's change without seeing it.
 * Step 3 is best-effort: a leftover object is unreferenced, stays under the
 * project prefix, and goes when the project does.
 *
 * AUTHORIZATION: `requireGlossyOrProposalArtifactEnabled` first (GLOSSY_EDITION
 * and PROPOSAL_ARTIFACT both off → NOT_FOUND for every caller), then
 * `requireProjectPermission(DOCUMENT_UPDATE)`, then the shared
 * recipient brand gate including `canEditProject` (an invited guest editor
 * passes it).
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
				code: z.enum(LOGO_REJECTION_CODES),
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
		const current = await getRecipientBrand(projectId);
		if ((current?.version ?? 0) !== expectedVersion) {
			return { outcome: "conflict" as const };
		}

		let logoKey: string | null = null;
		let promotedKey: string | null = null;
		if (input.logo.action === "keep") {
			// Unchanged by construction: the compare-and-set applies only at
			// the version this row was read at.
			logoKey = current?.logoKey ?? null;
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
			promotedKey = promotion.key;
		}

		let result: Awaited<ReturnType<typeof confirmRecipientBrand>>;
		try {
			result = await confirmRecipientBrand({
				projectId,
				expectedVersion,
				...fields,
				logoKey,
				updatedById: context.user.id,
				organizationId,
			});
		} catch (error) {
			if (promotedKey) {
				await deleteRecipientBrandObjects(projectId, [promotedKey]);
			}
			throw error;
		}

		if (result.outcome === "conflict") {
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
