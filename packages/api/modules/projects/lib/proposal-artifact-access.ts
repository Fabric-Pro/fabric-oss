import { ORPCError } from "@orpc/client";
import {
	canEditProject,
	db,
	hasProjectAccess,
	isOrganizationMember,
	isProposalClientDocument,
	isProposalInternalReader,
	PROPOSAL_DOCUMENT_TYPE,
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
 *   6. the internal predicate, `isProposalInternalReader` (Fizzy #2946):
 *      the decision the tabs, the page and the worker share, asked before
 *      anything about the analysis or style is read. When it fails, the
 *      refusal names the reason: no membership of the owning organization
 *      is FORBIDDEN with {@link ORGANIZATION_MEMBERSHIP_REQUIRED_CODE}, a
 *      document that is not a Proposal is BAD_REQUEST, and anything else
 *      (the gate turned off since step 1) is NOT_FOUND.
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

	if (
		!(await isProposalInternalReader({
			organizationId,
			documentType: document.type,
			userId: args.userId,
		}))
	) {
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
		throw new ORPCError("NOT_FOUND", {
			message: "The Proposal artifact is not enabled",
		});
	}

	return { document, organizationId };
}

/** A finding a member answers, and the run it belongs to (Fizzy #2946). */
export interface ProposalFindingTarget {
	run: {
		id: string;
		/** The run's document prose hash; null on runs written before it. */
		proseHash: string | null;
		/** A re-run's source run; null for a generation run. */
		sourceRunId: string | null;
	};
	finding: {
		id: string;
		title: string;
		/** Null on findings written before keys existed. */
		stableKey: string | null;
		sectionKey: string | null;
		sectionHash: string | null;
	};
}

/**
 * The finding `findingId` of run `runId`, only when that run is a run of the
 * document in its owning organization and the finding is one of that run's;
 * NOT_FOUND otherwise, worded the same whichever id named nothing, so a
 * finding or run id from another document or organization tells the caller
 * nothing. Call it after {@link loadProposalArtifactDocument}, with the
 * document and organization that returned.
 */
export async function loadProposalFinding(args: {
	organizationId: string;
	documentId: string;
	runId: string;
	findingId: string;
}): Promise<ProposalFindingTarget> {
	const run = await db.projectDocumentAnalysis.findFirst({
		where: {
			id: args.runId,
			documentId: args.documentId,
			organizationId: args.organizationId,
		},
		select: { id: true, proseHash: true, sourceRunId: true },
	});
	const finding = run
		? await db.projectDocumentFinding.findFirst({
				where: {
					id: args.findingId,
					analysisId: run.id,
					organizationId: args.organizationId,
				},
				select: {
					id: true,
					title: true,
					stableKey: true,
					sectionKey: true,
					sectionHash: true,
				},
			})
		: null;
	if (!run || !finding) {
		throw new ORPCError("NOT_FOUND", { message: "Finding not found" });
	}
	return { run, finding };
}

interface ProposalClientDocumentAccess {
	document: { id: string; type: string };
	/** The project's owning organization: the one every query runs in. */
	organizationId: string;
}

/**
 * One refusal for every way the client-document loader can fail, so the
 * order of its checks tells a caller nothing: a caller without access to
 * the project cannot learn whether an id names one of its documents, a
 * Business Case, or a Proposal whose gate is off.
 */
function clientDocumentNotFound(): ORPCError<"NOT_FOUND", unknown> {
	return new ORPCError("NOT_FOUND", { message: "Document not found" });
}

/**
 * The loader for what a Proposal in artifact mode shows its client (Fizzy
 * #2946): the shared theme and the exports, read by members and project
 * guests alike. Run after `requireProjectPermission`.
 *
 * It differs from {@link loadProposalArtifactDocument} on purpose. That
 * loader guards internal material, so it requires a `member` row in the
 * owning organization and tells a guest why they were refused. This one
 * guards a document every reader of the project may see, so it asks for no
 * membership, and it answers NOT_FOUND to every failure, with one message:
 * nothing it holds is worth telling a caller who cannot read it that it
 * exists. In order:
 *   1. the owning organization comes from the Project row; a trashed
 *      project, or one outside any organization, is refused;
 *   2. the document must belong to this project;
 *   3. `hasProjectAccess`, the project reach a guest holds through an
 *      accepted project membership;
 *   4. the client-document predicate, `isProposalClientDocument`: the
 *      PROPOSAL_ARTIFACT gate on for the owning organization, and a Proposal.
 *
 * It never reads the document's content; callers that need it read it in
 * the organization this returns.
 */
export async function loadProposalClientDocument(args: {
	projectId: string;
	documentId: string;
	userId: string;
}): Promise<ProposalClientDocumentAccess> {
	const project = await db.project.findUnique({
		where: { id: args.projectId },
		select: { organizationId: true, deletedAt: true },
	});
	const organizationId = project?.organizationId;
	if (!project || project.deletedAt || !organizationId) {
		throw clientDocumentNotFound();
	}

	const document = await db.projectDocument.findFirst({
		where: { id: args.documentId, projectId: args.projectId },
		select: { id: true, type: true },
	});
	if (!document) {
		throw clientDocumentNotFound();
	}

	if (!(await hasProjectAccess(args.projectId, args.userId))) {
		throw clientDocumentNotFound();
	}

	if (
		!(await isProposalClientDocument({
			organizationId,
			documentType: document.type,
		}))
	) {
		throw clientDocumentNotFound();
	}

	return {
		document: { id: document.id, type: document.type },
		organizationId,
	};
}
