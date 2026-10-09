import { ORPCError } from "@orpc/client";
import {
	canEditProject,
	db,
	hasProjectAccess,
	isOrganizationMember,
} from "@repo/database";
import { assertProposalArtifactEnabled } from "./proposal-artifact-feature";

/**
 * Who may read and change a Proposal's Internal Analysis and Style
 * (Fizzy #2801): members of the organization that owns the project, and
 * nobody else.
 *
 * Both hold internal material — review findings about the client's own
 * proposal, and the vendor's styling choices — so a project role is not
 * enough. A project guest can hold any role, EDITOR included, and their tie
 * to the project says nothing about whether they belong to the organization
 * that wrote the review (see "Project guest" in CONCEPTS.md). The bar is a
 * `member` row in the OWNING organization, checked live on every call, with
 * the organization resolved from the project row and never from the session
 * or the input.
 *
 * The rows are read with that owning organization in `where`, the way the
 * company-context and Glossy procedures read their organization-only rows.
 * The tables are also organization-only in the tenant client and in RLS;
 * those stay a backstop for any other reader.
 */

/**
 * Machine-readable discriminator on the guest refusal, the same code
 * `request-cli-connection` carries: the caller does reach the project, so a
 * plain access refusal would be a lie they could not act on.
 */
export const ORGANIZATION_MEMBERSHIP_REQUIRED_CODE =
	"ORGANIZATION_MEMBERSHIP_REQUIRED";

/** Only a Proposal has an Internal Analysis and a Style. */
const PROPOSAL_DOCUMENT_TYPE = "PROPOSAL";

interface ProposalArtifactDocumentAccess {
	document: { id: string; type: string; content: string };
	/** The project's owning organization: the one every query runs in. */
	organizationId: string;
}

/**
 * The gate every Proposal artifact procedure runs after
 * `requireProjectPermission`, in NOT_FOUND-before-FORBIDDEN order:
 *   1. the rollout gate for the owning organization (NOT_FOUND when off);
 *   2. a trashed project, or one outside any organization, is NOT_FOUND;
 *   3. the document must belong to this project (NOT_FOUND, worded as an id
 *      that names nothing, so another project's document id tells the caller
 *      nothing);
 *   4. `hasProjectAccess`, the project reach the Glossy document procedures
 *      require (FORBIDDEN otherwise);
 *   5. writes also need `canEditProject` (FORBIDDEN otherwise);
 *   6. membership of the owning organization (FORBIDDEN with
 *      {@link ORGANIZATION_MEMBERSHIP_REQUIRED_CODE}), asked before anything
 *      about the analysis or style is read;
 *   7. the document must be a Proposal (BAD_REQUEST).
 */
export async function loadProposalArtifactDocument(args: {
	projectId: string;
	documentId: string;
	userId: string;
	write: boolean;
}): Promise<ProposalArtifactDocumentAccess> {
	const organizationId = await assertProposalArtifactEnabled(args.projectId);

	const project = await db.project.findUnique({
		where: { id: args.projectId },
		select: { organizationId: true, deletedAt: true },
	});
	if (
		!project ||
		project.deletedAt ||
		project.organizationId !== organizationId
	) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}

	const document = await db.projectDocument.findFirst({
		where: { id: args.documentId, projectId: args.projectId },
		select: { id: true, type: true, content: true },
	});
	if (!document) {
		throw new ORPCError("NOT_FOUND", { message: "Document not found" });
	}

	if (!(await hasProjectAccess(args.projectId, args.userId))) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have access to this project",
		});
	}

	if (args.write && !(await canEditProject(args.projectId, args.userId))) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have permission to edit this project",
		});
	}

	if (!(await isOrganizationMember(args.userId, organizationId))) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"Only members of this project's organization can see the Internal Analysis and Style.",
			data: { code: ORGANIZATION_MEMBERSHIP_REQUIRED_CODE },
		});
	}

	if (document.type !== PROPOSAL_DOCUMENT_TYPE) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Only a Proposal has an Internal Analysis and Style.",
		});
	}

	return { document, organizationId };
}
