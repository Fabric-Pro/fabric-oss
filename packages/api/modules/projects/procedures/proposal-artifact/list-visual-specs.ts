import { listProposalVisualSpecSummaries } from "@repo/database";
import { VISUAL_ORIGINS } from "@repo/utils/proposal-artifact/visual-identity";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadProposalClientDocument } from "../../lib/proposal-artifact-access";
import { requireProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";

/**
 * One stored visual as a client may know it. An object schema drops any key
 * it does not name, so the spec, its hash and its author never reach the
 * wire even if the read selected them.
 */
const visualSpecSummarySchema = z.object({
	visualId: z.string(),
	sourceHash: z.string(),
	kind: z.string(),
	origin: z.enum(VISUAL_ORIGINS),
});

/**
 * The generated visuals of a Proposal in artifact mode (Fizzy #2946): per
 * stored spec, the visual id, the fence body's source hash, the kind and
 * whether the visuals step or Edit with instructions made it. The editor
 * classifies each diagram fence against these, so it can tell a generated
 * diagram from one a person changed. Members and project guests read the
 * same rows; the specs themselves stay on the server. A read, so no audit
 * row.
 *
 * AUTHORIZATION: `requireProposalArtifactEnabled` first (gate off → NOT_FOUND
 * for every caller), then `requireProjectPermission(DOCUMENT_READ)`, then
 * `loadProposalClientDocument` (document in project, project access, a
 * Proposal with the gate on for the owning organization; NOT_FOUND for every
 * failure). No membership of the owning organization is required. Rows are
 * read for the document the loader returned, inside the project it checked.
 */
export const listProposalVisualSpecsProcedure = tenantProtectedProcedure
	.use(requireProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/visual-specs",
		tags: ["Projects", "Proposal artifact"],
		summary: "List a Proposal's generated visuals",
		description:
			"The id, source hash, kind and origin of each generated diagram stored for a Proposal, never its spec. Readable by anyone with access to the project.",
	})
	.input(z.object({ projectId: z.string(), documentId: z.string() }))
	.output(z.object({ specs: z.array(visualSpecSummarySchema) }))
	.handler(async ({ input, context }) => {
		const { document, organizationId } = await loadProposalClientDocument({
			projectId: input.projectId,
			documentId: input.documentId,
			userId: context.user.id,
		});

		const rows = await listProposalVisualSpecSummaries({
			organizationId,
			projectId: input.projectId,
			documentId: document.id,
		});
		return {
			specs: rows.map((row) => ({
				visualId: row.visualId,
				sourceHash: row.sourceHash,
				kind: row.kind,
				origin: row.origin,
			})),
		};
	});
