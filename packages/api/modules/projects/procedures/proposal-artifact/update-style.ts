import { ORPCError } from "@orpc/server";
import {
	DocumentStyleConflictError,
	DocumentStyleValidationError,
	PROPOSAL_STYLE_MAX_ACCENT_COLORS,
	PROPOSAL_STYLE_MAX_DIRECTION_LENGTH,
	ProposalArtifactTenantError,
	upsertDocumentStyle,
} from "@repo/database";
import {
	ARTIFACT_BRAND_SOURCES,
	ARTIFACT_COVER_STYLES,
} from "@repo/utils/artifact-brand-theme";
import { HEX_COLOR_PATTERN } from "@repo/utils/brand-colors";
import { z } from "zod";
import {
	type RecordAuditFromRequestInput,
	recordAuditFromRequest,
} from "../../../../lib/audit";
import { assertProjectPermission } from "../../../../orpc/middleware/require-permission";
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
	brandSource: z.enum(ARTIFACT_BRAND_SOURCES).optional(),
	coverStyle: z.enum(ARTIFACT_COVER_STYLES).nullable().optional(),
	expectedUpdatedAt: z.date().nullable().optional(),
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
	/**
	 * Whether Fabric adds diagrams after each generation. Left out, the
	 * stored value is kept, so an older client's save never resets it.
	 */
	autoVisuals: z.boolean().optional(),
});

/**
 * Save the Style of a Proposal (Fizzy #2801), replacing every field given;
 * a missing `autoVisuals` keeps the stored switch. The
 * saved settings shape the NEXT generation's visuals; nothing already
 * generated is re-rendered. The recipient brand is the project's and keeps
 * its own procedures (`projects.recipientBrand.*`).
 *
 * Validated twice: the input schema answers a malformed request with
 * BAD_REQUEST before anything is read, and the query re-validates whatever
 * reaches it, which this maps to BAD_REQUEST as well.
 *
 * All transports record the existing project.updated action with field names
 * only, so shared client/company visual selection is visible without logging
 * brand guidance or client content.
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
			"Replaces the style direction, primary colour and up to three accent colours a Proposal's next generation uses for its visuals and, when given, whether diagrams are added automatically (left out, the stored setting is kept). Organization members with edit access only.",
	})
	.input(updateProposalStyleInputSchema)
	.output(proposalStyleSchema)
	.handler(async ({ input, context }) =>
		updateProposalStyleCommand(
			{
				userId: context.user.id,
				organizationId: (
					await loadProposalArtifactDocument({
						...input,
						userId: context.user.id,
						write: true,
					})
				).organizationId,
			},
			input,
			(event) => recordAuditFromRequest(context, event),
		),
	);

/** One live authorization and persistence path for Portal and external transports. */
export async function updateProposalStyleCommand(
	actor: { userId: string; organizationId: string },
	input: z.infer<typeof updateProposalStyleInputSchema>,
	audit: (event: RecordAuditFromRequestInput) => unknown,
) {
	const permission = await assertProjectPermission(
		input.projectId,
		actor.userId,
		Permissions.DOCUMENT_UPDATE,
	);
	if (permission.organizationId !== actor.organizationId) {
		throw new ORPCError("NOT_FOUND", { message: "Document not found" });
	}
	const { document, organizationId } = await loadProposalArtifactDocument({
		projectId: input.projectId,
		documentId: input.documentId,
		userId: actor.userId,
		write: true,
	});
	try {
		const style = await upsertDocumentStyle({
			...input,
			documentId: document.id,
			organizationId,
			updatedById: actor.userId,
		});
		await audit({
			action: "project.updated",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: { type: "project", id: input.projectId, name: null },
			metadata: {
				operation: "proposal_style.updated",
				documentId: document.id,
				changedFields: [
					"styleDirection",
					"primaryColor",
					"accentColors",
					"autoVisuals",
					"brandSource",
					"coverStyle",
				].filter((field) => Object.hasOwn(input, field)),
			},
		});
		return presentProposalStyle(style);
	} catch (error) {
		if (error instanceof DocumentStyleConflictError) {
			throw new ORPCError("CONFLICT", { message: error.message });
		}
		if (error instanceof DocumentStyleValidationError) {
			throw new ORPCError("BAD_REQUEST", {
				message: "The style is not valid",
				data: { code: error.code },
			});
		}
		if (error instanceof ProposalArtifactTenantError) {
			throw new ORPCError("NOT_FOUND", { message: "Document not found" });
		}
		throw error;
	}
}
