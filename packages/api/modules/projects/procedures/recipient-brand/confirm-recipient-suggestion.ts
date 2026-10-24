import {
	confirmRecipientBrand,
	getRecipientBrand,
	getRecipientBrandSuggestion,
	type RecipientBrandSuggestionView,
	RecipientBrandValidationError,
	type RecipientBrandView,
} from "@repo/database";
import { BRAND_ASSET_REJECTION_CODES } from "@repo/utils/brand-assets";
import {
	effectiveBrandFetchAttempt,
	isRecipientSuggestedLogoKey,
	neutralizeBrandName,
} from "@repo/utils/proposal-artifact/brand-sources";
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
	RECIPIENT_SUGGESTION_FIELDS,
} from "../../lib/recipient-brand";

/**
 * The suggestion's result, when a member may still confirm a field of it:
 * the attempt SUCCEEDED as a reader sees it, it is the attempt the member
 * read (`requestId`), and its result is for the website the recipient brand
 * names now. Null otherwise. A newer fetch, a failed or cut-off re-fetch, or
 * a website changed since all make a click on an older read stale.
 */
function confirmableSuggestion(
	suggestion: RecipientBrandSuggestionView | null,
	brand: RecipientBrandView | null,
	requestId: string,
	now: Date,
): RecipientBrandSuggestionView | null {
	if (!suggestion || !brand?.website) {
		return null;
	}
	const { status } = effectiveBrandFetchAttempt(suggestion, now);
	return status === "SUCCEEDED" &&
		suggestion.requestId === requestId &&
		suggestion.resultWebsite === brand.website
		? suggestion
		: null;
}

/**
 * Apply ONE field of the project's recipient website fetch to the recipient
 * brand (Fizzy #2946): the Style tab's per-field Confirm.
 *
 * The value is copied on the server from the stored result, never taken from
 * the request, and every other field keeps what the row holds:
 *   - the name is neutralized again on the way in, whatever the suggestion
 *     row holds;
 *   - colours as the fetch stored them (lowercase `#rrggbb`, at most three);
 *   - the logo only when its key is one of this project's suggested logos,
 *     checked before storage is touched, then promoted through the same
 *     pipeline an upload goes through (normalize, copy to a new immutable
 *     `current/` key with its hash, then the compare-and-set). The suggested
 *     object stays: the suggestion still shows it.
 * A suggestion field with nothing in it is stale too: the confirmation never
 * clears a value a person set.
 *
 * Outcomes: `applied` (the superseded logo and every pending upload are
 * deleted, best effort, as after a recipient brand save); `conflict` when the
 * recipient brand moved since `expectedVersion` (the object this attempt
 * promoted is deleted); `stale` when the suggestion is no longer the one the
 * member read, for this website, holds no value for the field, its logo is
 * gone (a newer fetch replaced it), or the row it would write no longer
 * validates; `logoRejected` when the logo's bytes fail normalization. On any
 * other error the promoted object is deleted only when the stored row does
 * not point at it.
 *
 * AUTHORIZATION: `requireGlossyOrProposalArtifactEnabled` first (GLOSSY_EDITION
 * and PROPOSAL_ARTIFACT both off → NOT_FOUND for every caller), then
 * `requireProjectPermission(DOCUMENT_UPDATE)`, then the shared recipient
 * brand write gate: `canEditProject` and a `member` row in the owning
 * organization, so a project guest editor is FORBIDDEN. The suggestion is
 * read in that owning organization.
 */
export const confirmRecipientSuggestionProcedure = tenantProtectedProcedure
	.use(requireGlossyOrProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/recipient-brand/confirm-suggestion",
		tags: ["Projects", "Glossy"],
		summary: "Confirm one field of the recipient brand suggestion",
		description:
			"Copy one field of the recipient website fetch into the recipient brand, if the fetch and the recipient brand are still the ones the caller read.",
	})
	.input(
		z.object({
			projectId: z.string(),
			/** The recipient brand version the caller read; 0 when there was none. */
			expectedVersion: z.number().int().min(0),
			/** The suggestion attempt the caller read. */
			requestId: z.string().min(1).max(128),
			field: z.enum(RECIPIENT_SUGGESTION_FIELDS),
		}),
	)
	.output(
		z.discriminatedUnion("outcome", [
			z.object({
				outcome: z.literal("applied"),
				version: z.number().int(),
			}),
			z.object({ outcome: z.literal("conflict") }),
			z.object({ outcome: z.literal("stale") }),
			z.object({
				outcome: z.literal("logoRejected"),
				code: z.enum(BRAND_ASSET_REJECTION_CODES),
			}),
		]),
	)
	.handler(async ({ input, context }) => {
		const { projectId, expectedVersion, field } = input;
		const { organizationId } = await loadRecipientBrandProject({
			projectId,
			userId: context.user.id,
			write: true,
		});

		const [row, storedSuggestion] = await Promise.all([
			getRecipientBrand(projectId),
			getRecipientBrandSuggestion({ projectId, organizationId }),
		]);
		// A row left behind in another organization is no recipient brand.
		const current = row?.organizationId === organizationId ? row : null;
		const suggestion = confirmableSuggestion(
			storedSuggestion,
			current,
			input.requestId,
			new Date(),
		);
		if (!current || !suggestion) {
			return { outcome: "stale" as const };
		}
		// An early answer for the common case; the compare-and-set below
		// stays the authority.
		if (current.version !== expectedVersion) {
			return { outcome: "conflict" as const };
		}

		let name = current.name;
		let colors = current.colors;
		let logoKey = current.logoKey;
		let logoHash = current.logoHash;
		let promotedKey: string | null = null;
		if (field === "name") {
			const suggested = neutralizeBrandName(suggestion.name);
			if (!suggested) {
				return { outcome: "stale" as const };
			}
			name = suggested;
		} else if (field === "colors") {
			if (suggestion.colors.length === 0) {
				return { outcome: "stale" as const };
			}
			colors = suggestion.colors;
		} else {
			// Stored data, not input, and still checked before any read: a
			// key outside this project's suggested logos names nothing here.
			if (!isRecipientSuggestedLogoKey(projectId, suggestion.logoKey)) {
				return { outcome: "stale" as const };
			}
			const promotion = await promoteRecipientLogo(
				projectId,
				suggestion.logoKey,
			);
			if (promotion.outcome === "missing") {
				// A newer fetch replaced the suggestion and its logo.
				return { outcome: "stale" as const };
			}
			if (promotion.outcome === "rejected") {
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
				name,
				website: current.website,
				colors,
				logoKey,
				logoHash,
				updatedById: context.user.id,
				organizationId,
				// Re-checked in the write's own transaction: a fetch that
				// replaced the suggestion since it was read makes this stale.
				suggestion: { requestId: input.requestId },
			});
		} catch (error) {
			if (error instanceof RecipientBrandValidationError) {
				// Nothing was written: a value stored before a rule tightened
				// (a website, a name) no longer passes it.
				if (promotedKey) {
					await deleteRecipientBrandObjects(projectId, [promotedKey]);
				}
				return { outcome: "stale" as const };
			}
			await deleteUnsavedRecipientLogo(projectId, promotedKey);
			throw error;
		}

		if (result.outcome !== "applied") {
			if (promotedKey) {
				await deleteRecipientBrandObjects(projectId, [promotedKey]);
			}
			return { outcome: result.outcome };
		}

		// Each pending upload belongs to a form that read an older version
		// and can now only conflict.
		const superseded = await listRecipientLogoPendingKeys(projectId);
		if (result.previousLogoKey && result.previousLogoKey !== logoKey) {
			superseded.push(result.previousLogoKey);
		}
		await deleteRecipientBrandObjects(projectId, superseded);

		// Field names only, as the recipient brand's own update records them.
		const changed =
			field === "name"
				? current.name !== name
				: field === "colors"
					? current.colors.join(",") !== colors.join(",")
					: current.logoKey !== logoKey;
		recordAuditFromRequest(context, {
			action: "project.recipient_brand.updated",
			category: "project",
			organizationId,
			projectId,
			resource: { type: "project", id: projectId, name: null },
			metadata: {
				version: result.version,
				changedFields: changed ? [field] : [],
			},
		});

		return { outcome: "applied" as const, version: result.version };
	});
