import { type DocumentStyleView, getDocumentStyle } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadProposalArtifactDocument } from "../../lib/proposal-artifact-access";
import { requireProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";

export const proposalStyleSchema = z.object({
	/** Free-text direction for the visuals; null when none is set. */
	styleDirection: z.string().nullable(),
	/** Lowercase `#rrggbb`; null when none is set. */
	primaryColor: z.string().nullable(),
	/** Lowercase `#rrggbb`, at most three. */
	accentColors: z.array(z.string()),
	updatedAt: z.date(),
});

/** The stored style as the wire carries it, field by field. */
export function presentProposalStyle(
	style: DocumentStyleView,
): z.infer<typeof proposalStyleSchema> {
	return {
		styleDirection: style.styleDirection,
		primaryColor: style.primaryColor,
		accentColors: style.accentColors,
		updatedAt: style.updatedAt,
	};
}

/**
 * The Style of a Proposal (Fizzy #2801): the style direction and colours the
 * next generation's visuals use. Null until someone saves one. The recipient
 * brand is the project's and keeps its own procedures
 * (`projects.recipientBrand.*`).
 *
 * Organization members only, like the Internal Analysis beside it.
 *
 * AUTHORIZATION: `requireProposalArtifactEnabled` first (gate off → NOT_FOUND
 * for every caller), then `requireProjectPermission(DOCUMENT_READ)`, then
 * `loadProposalArtifactDocument` (document in project, project access,
 * membership of the owning organization, a Proposal).
 */
export const getProposalStyleProcedure = tenantProtectedProcedure
	.use(requireProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/style",
		tags: ["Projects", "Proposal artifact"],
		summary: "Get the Proposal style",
		description:
			"The style direction and colours a Proposal's next generation uses for its visuals. Organization members only.",
	})
	.input(z.object({ projectId: z.string(), documentId: z.string() }))
	.output(proposalStyleSchema.nullable())
	.handler(async ({ input, context }) => {
		const { document, organizationId } = await loadProposalArtifactDocument(
			{
				projectId: input.projectId,
				documentId: input.documentId,
				userId: context.user.id,
				write: false,
			},
		);

		const style = await getDocumentStyle({
			documentId: document.id,
			organizationId,
		});
		return style ? presentProposalStyle(style) : null;
	});
