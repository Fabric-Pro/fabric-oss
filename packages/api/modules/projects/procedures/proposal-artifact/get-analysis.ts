import {
	computeDocumentContentHash,
	getLatestAnalysisForDocument,
	PROPOSAL_ANALYSIS_STATUSES,
	PROPOSAL_FINDING_SEVERITIES,
	PROPOSAL_FINDING_TYPES,
	type ProposalAnalysisView,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadProposalArtifactDocument } from "../../lib/proposal-artifact-access";
import { requireProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";

/**
 * How long a PENDING or RUNNING run may go without an update before the read
 * reports it as timed out. The analysis activity bumps `updatedAt` on every
 * attempt, so this measures silence, not total runtime.
 */
export const PROPOSAL_ANALYSIS_TIMEOUT_MS = 20 * 60 * 1000;

const IN_FLIGHT_STATUSES = new Set(["PENDING", "RUNNING"]);

const findingSchema = z.object({
	id: z.string(),
	severity: z.enum(PROPOSAL_FINDING_SEVERITIES),
	type: z.enum(PROPOSAL_FINDING_TYPES),
	title: z.string(),
	detail: z.string(),
	recommendation: z.string().nullable(),
	/** The Main section the finding is about, when it names one. */
	sectionHeading: z.string().nullable(),
	position: z.number().int(),
});

const analysisSchema = z.object({
	id: z.string(),
	status: z.enum(PROPOSAL_ANALYSIS_STATUSES),
	/** The document's content changed since this run analyzed it. */
	isStale: z.boolean(),
	/** PENDING or RUNNING with no update for twenty minutes. */
	timedOut: z.boolean(),
	/** The document version the run analyzed; null when it had none. */
	documentVersion: z.number().int().nullable(),
	contextCount: z.number().int(),
	model: z.string().nullable(),
	/** A fixed code; the page maps it to translated copy. */
	errorCode: z.string().nullable(),
	/** The fixed message stored with the code. */
	errorMessage: z.string().nullable(),
	startedAt: z.date().nullable(),
	completedAt: z.date().nullable(),
	createdAt: z.date(),
	updatedAt: z.date(),
	/** In the order the run produced them. */
	findings: z.array(findingSchema),
});

/**
 * The read-time labels on a stored run. Staleness compares the hash stored
 * with the run against the hash of the document's current content, computed
 * the same way, so an edit, a Reject or a newer generation needs no write to
 * the run. The embed-owned `contentHash` column on the document is not used:
 * it lags, or stays null, whenever embedding does.
 */
export function analysisReadLabels(
	run: Pick<ProposalAnalysisView, "status" | "contentHash" | "updatedAt">,
	currentContent: string,
	now: Date,
): { isStale: boolean; timedOut: boolean } {
	return {
		isStale: run.contentHash !== computeDocumentContentHash(currentContent),
		timedOut:
			IN_FLIGHT_STATUSES.has(run.status) &&
			now.getTime() - run.updatedAt.getTime() >
				PROPOSAL_ANALYSIS_TIMEOUT_MS,
	};
}

/**
 * The Internal Analysis of a Proposal (Fizzy #2801): the document's newest
 * run, its findings, and whether it is stale or timed out. Null before the
 * first run.
 *
 * Internal review material, so only members of the project's owning
 * organization read it; a project guest is refused whatever their project
 * role. The response is built field by field: the analyzed Main body and the
 * source context stored with the run never leave the server, and neither do
 * the run's tenant columns or its workflow key.
 *
 * AUTHORIZATION: `requireProposalArtifactEnabled` first (gate off → NOT_FOUND
 * for every caller), then `requireProjectPermission(DOCUMENT_READ)`, then
 * `loadProposalArtifactDocument` (document in project, project access,
 * membership of the owning organization, a Proposal).
 */
export const getProposalAnalysisProcedure = tenantProtectedProcedure
	.use(requireProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/analysis",
		tags: ["Projects", "Proposal artifact"],
		summary: "Get the Internal Analysis",
		description:
			"The newest Internal Analysis run of a Proposal, with its findings and whether it is stale or timed out. Organization members only.",
	})
	.input(z.object({ projectId: z.string(), documentId: z.string() }))
	.output(analysisSchema.nullable())
	.handler(async ({ input, context }) => {
		const { document, organizationId } = await loadProposalArtifactDocument(
			{
				projectId: input.projectId,
				documentId: input.documentId,
				userId: context.user.id,
				write: false,
			},
		);

		const run = await getLatestAnalysisForDocument({
			documentId: document.id,
			organizationId,
		});
		if (!run) {
			return null;
		}

		return {
			id: run.id,
			status: run.status,
			...analysisReadLabels(run, document.content, new Date()),
			documentVersion: run.documentVersion,
			contextCount: run.contextCount,
			model: run.model,
			errorCode: run.errorCode,
			errorMessage: run.errorMessage,
			startedAt: run.startedAt,
			completedAt: run.completedAt,
			createdAt: run.createdAt,
			updatedAt: run.updatedAt,
			findings: run.findings.map((finding) => ({
				id: finding.id,
				severity: finding.severity,
				type: finding.type,
				title: finding.title,
				detail: finding.detail,
				recommendation: finding.recommendation,
				sectionHeading: finding.sectionHeading,
				position: finding.position,
			})),
		};
	});
