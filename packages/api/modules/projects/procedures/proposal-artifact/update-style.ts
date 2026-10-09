import { ORPCError } from "@orpc/client";
import {
	DocumentStyleValidationError,
	PROPOSAL_STYLE_MAX_ACCENT_COLORS,
	PROPOSAL_STYLE_MAX_DIRECTION_LENGTH,
	ProposalArtifactTenantError,
	upsertDocumentStyle,
} from "@repo/database";
import { HEX_COLOR_PATTERN } from "@repo/utils/brand-colors";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadProposalArtifactDocument } from "../../lib/proposal-artifact-access";
import { requireProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";
import { presentProposalStyle, proposalStyleSchema } from "./get-style";

/** `#rrggbb`, either case; the query stores it lowercase. */
const hexColorSchema = z
	.string()
	.trim()
	.regex(HEX_COLOR_PATTERN, { message: "Colours must be #rrggbb" });

export const updateProposalStyleInputSchema = z.object({
	projectId: z.string(),
	documentId: z.string(),
	/** Trimmed; empty clears it. */
	styleDirection: z
		.string()
		.trim()
		.max(PROPOSAL_STYLE_MAX_DIRECTION_LENGTH)
		.nullable(),
	primaryColor: hexColorSchema.nullable(),
	accentColors: z.array(hexColorSchema).max(PROPOSAL_STYLE_MAX_ACCENT_COLORS),
});

/**
 * Save the Style of a Proposal (Fizzy #2801), replacing every field. The
 * saved settings shape the NEXT generation's visuals; nothing already
 * generated is re-rendered. The recipient brand is the project's and keeps
 * its own procedures (`projects.recipientBrand.*`).
 *
 * Validated twice: the input schema answers a malformed request with
 * BAD_REQUEST before anything is read, and the query re-validates whatever
 * reaches it, which this maps to BAD_REQUEST as well.
 *
 * No audit row, deliberately: a style direction and three colours are
 * document presentation, not a security-relevant change — no permission,
 * credential or data boundary moves — and the closed `AUDIT_ACTIONS`
 * taxonomy has no action for a document's presentation settings.
 *
 * AUTHORIZATION: `requireProposalArtifactEnabled` first (gate off → NOT_FOUND
 * for every caller), then `requireProjectPermission(DOCUMENT_UPDATE)`, then
 * `loadProposalArtifactDocument` (document in project, project access, edit
 * access, membership of the owning organization, a Proposal).
 */
export const updateProposalStyleProcedure = tenantProtectedProcedure
	.use(requireProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "PUT",
		path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/style",
		tags: ["Projects", "Proposal artifact"],
		summary: "Save the Proposal style",
		description:
			"Replaces the style direction, primary colour and up to three accent colours a Proposal's next generation uses for its visuals. Organization members with edit access only.",
	})
	.input(updateProposalStyleInputSchema)
	.output(proposalStyleSchema)
	.handler(async ({ input, context }) => {
		const { document, organizationId } = await loadProposalArtifactDocument(
			{
				projectId: input.projectId,
				documentId: input.documentId,
				userId: context.user.id,
				write: true,
			},
		);

		try {
			const style = await upsertDocumentStyle({
				documentId: document.id,
				projectId: input.projectId,
				organizationId,
				styleDirection: input.styleDirection,
				primaryColor: input.primaryColor,
				accentColors: input.accentColors,
				updatedById: context.user.id,
			});
			return presentProposalStyle(style);
		} catch (error) {
			if (error instanceof DocumentStyleValidationError) {
				throw new ORPCError("BAD_REQUEST", {
					message: "The style is not valid",
					data: { code: error.code },
				});
			}
			if (error instanceof ProposalArtifactTenantError) {
				// The access check above read the same rows; reaching this
				// means the document moved or went away in between.
				throw new ORPCError("NOT_FOUND", {
					message: "Document not found",
				});
			}
			throw error;
		}
	});
