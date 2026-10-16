import { ORPCError } from "@orpc/client";
import {
	type ClaimRerunConflictReason,
	claimRerun,
	failAnalysisRun,
	ProposalArtifactTenantError,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import {
	findBoundProposalPrompt,
	proposalPromptNotBoundMessage,
} from "@repo/temporal/proposal-artifact-prompts";
import {
	PROPOSAL_ANALYSIS_ERROR_MESSAGES,
	PROPOSAL_PROMPT_NOT_BOUND,
	type ProposalAnalysisWorkflowInput,
} from "@repo/temporal/proposal-artifact-types";
import { PROPOSAL_INTERNAL_ANALYSIS_AGENT_KEY } from "@repo/utils/prompt-action-catalog";
import { documentProseHash } from "@repo/utils/proposal-artifact/section-hash";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { checkRateLimit } from "../../../../lib/rate-limit";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadProposalArtifactDocument } from "../../lib/proposal-artifact-access";
import { requireProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";

/**
 * Re-runs per organization per window. Each one is a model call billed to
 * the organization, so the bound is the organization's, not one member's.
 */
export const PROPOSAL_ANALYSIS_RERUN_RATE_LIMIT = {
	limit: 20,
	windowMs: 60 * 60_000,
} as const;

function proposalAnalysisRerunRateLimitKey(organizationId: string): string {
	return `proposal-analysis-rerun:org:${organizationId}`;
}

/**
 * The queue the analysis workflow runs on: the generation child starts it
 * without naming one, so it inherits the generation workflow's queue, which
 * the API starts generations on (`dispatch-document-generation.ts`).
 */
const PROPOSAL_ANALYSIS_WORKFLOW_TASK_QUEUE = "project-documents";

const CONFLICT_MESSAGES: Record<ClaimRerunConflictReason, string> = {
	DOCUMENT_GENERATING:
		"The Proposal is being generated; re-run the analysis once it finishes.",
	ANALYSIS_IN_PROGRESS: "An analysis of this Proposal is already running.",
};

/**
 * Re-run the Internal Analysis of a Proposal over its current content
 * (Fizzy #2946), without regenerating it. The re-run checks the current text
 * against the sources of the last generation; regenerating picks up new
 * sources.
 *
 * In order, after access:
 *  1. an organization-keyed rate limit (TOO_MANY_REQUESTS);
 *  2. the analysis prompt bound for this member and the owning organization
 *     is pinned; none bound is PRECONDITION_FAILED with
 *     `PROPOSAL_PROMPT_NOT_BOUND`, and no run is recorded;
 *  3. an atomic claim records the run, or answers CONFLICT with
 *     `DOCUMENT_GENERATING` or `ANALYSIS_IN_PROGRESS` and records none;
 *  4. the existing analysis workflow starts under the run's key, carrying
 *     the request's correlation id. A start that fails marks the run FAILED,
 *     except when Temporal says the workflow already exists: then it is
 *     running and the run is left as it is.
 *
 * AUTHORIZATION: `requireProposalArtifactEnabled` first (gate off → NOT_FOUND
 * for every caller), then `requireProjectPermission(DOCUMENT_UPDATE)`, then
 * `loadProposalArtifactDocument` (document in project, project access, edit
 * access, membership of the owning organization, a Proposal).
 */
export const rerunProposalAnalysisProcedure = tenantProtectedProcedure
	.use(requireProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/analysis/rerun",
		tags: ["Projects", "Proposal artifact"],
		summary: "Re-run the Internal Analysis",
		description:
			"Starts a new Internal Analysis of a Proposal's current content against the sources of its last generation. Answers CONFLICT while the Proposal generates or an analysis runs. Organization members with edit access only.",
	})
	.input(z.object({ projectId: z.string(), documentId: z.string() }))
	.output(z.object({ runId: z.string() }))
	.handler(async ({ input, context }) => {
		const { document, organizationId } = await loadProposalArtifactDocument(
			{
				projectId: input.projectId,
				documentId: input.documentId,
				userId: context.user.id,
				write: true,
			},
		);

		const rateLimit = await checkRateLimit(
			proposalAnalysisRerunRateLimitKey(organizationId),
			PROPOSAL_ANALYSIS_RERUN_RATE_LIMIT.limit,
			PROPOSAL_ANALYSIS_RERUN_RATE_LIMIT.windowMs,
		);
		if (!rateLimit.allowed) {
			if (rateLimit.statusCode === 503) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "Rate limit service temporarily unavailable",
				});
			}
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `Too many analysis re-runs in this organization. Please try again in ${rateLimit.resetInSeconds} seconds.`,
				data: { retryAfter: rateLimit.resetInSeconds },
			});
		}

		const prompt = await findBoundProposalPrompt({
			userId: context.user.id,
			organizationId,
			projectId: input.projectId,
			action: PROPOSAL_INTERNAL_ANALYSIS_AGENT_KEY,
		});
		if (!prompt) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message: proposalPromptNotBoundMessage(
					PROPOSAL_INTERNAL_ANALYSIS_AGENT_KEY,
				),
				data: { code: PROPOSAL_PROMPT_NOT_BOUND },
			});
		}

		let claim: Awaited<ReturnType<typeof claimRerun>>;
		try {
			claim = await claimRerun({
				organizationId,
				projectId: input.projectId,
				documentId: document.id,
				promptVersionId: prompt.promptVersionId,
				computeProseHash: documentProseHash,
			});
		} catch (error) {
			if (error instanceof ProposalArtifactTenantError) {
				// The access check read the same rows; reaching this means the
				// document moved or went away in between.
				throw new ORPCError("NOT_FOUND", {
					message: "Document not found",
				});
			}
			throw error;
		}
		if (claim.outcome === "conflict") {
			throw new ORPCError("CONFLICT", {
				message: CONFLICT_MESSAGES[claim.reason],
				data: { code: claim.reason },
			});
		}

		const { run } = claim;
		const workflowInput: ProposalAnalysisWorkflowInput = {
			runId: run.analysisId,
			organizationId,
			projectId: input.projectId,
			documentId: document.id,
			userId: context.user.id,
			// A member asked for it in the product, as for a regeneration.
			planEligible: true,
		};
		try {
			const client = await getTemporalClient();
			await client.workflow.start(
				"proposalAnalysisWorkflow",
				withCorrelationMemo({
					taskQueue: PROPOSAL_ANALYSIS_WORKFLOW_TASK_QUEUE,
					workflowId: run.runKey,
					// One workflow per run key, ever: a retried start of the
					// same claim is refused rather than starting a second run.
					workflowIdConflictPolicy: "FAIL",
					workflowIdReusePolicy: "REJECT_DUPLICATE",
					args: [workflowInput],
				}),
			);
		} catch (error) {
			if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
				logger.error(
					{
						event: "proposal_analysis.rerun_start_failed",
						organizationId,
						projectId: input.projectId,
						documentId: document.id,
						runId: run.analysisId,
						errorName:
							error instanceof Error ? error.name : "unknown",
					},
					"The analysis re-run could not be started",
				);
				try {
					await failAnalysisRun({
						analysisId: run.analysisId,
						errorCode: "START_FAILED",
						errorMessage:
							PROPOSAL_ANALYSIS_ERROR_MESSAGES.START_FAILED,
					});
				} catch {
					// The run stays PENDING until the shared timeout; then the
					// read reports it timed out and the next claim marks it
					// FAILED, so it cannot block re-runs for good.
					logger.error(
						{
							event: "proposal_analysis.rerun_fail_write_failed",
							organizationId,
							runId: run.analysisId,
						},
						"The unstarted analysis re-run could not be marked failed",
					);
				}
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "The analysis could not be started.",
				});
			}
			// Already started under this run's key: it is running. Leave the
			// run as it is and answer as for a start.
		}

		recordAuditFromRequest(context, {
			action: "project.document_analysis.rerun_started",
			category: "project",
			outcome: "success",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_document",
				id: document.id,
				name: null,
			},
			metadata: {
				runId: run.analysisId,
				sourceRunId: run.sourceRunId,
				promptVersionId: prompt.promptVersionId,
				timedOutRunCount: run.timedOutRunIds.length,
			},
		});

		return { runId: run.analysisId };
	});
