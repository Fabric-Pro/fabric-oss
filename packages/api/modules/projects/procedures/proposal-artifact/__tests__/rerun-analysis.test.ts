/**
 * `projects.proposalArtifact.rerunAnalysis` (Fizzy #2946): a member re-runs
 * the Internal Analysis over the Proposal's current content. Rate limited per
 * organization, pinned to the analysis prompt bound for the member, claimed
 * atomically (CONFLICT and no run while a generation or another analysis is
 * in flight), and started as the existing analysis workflow under the run's
 * key.
 *
 * Access is covered in `access.test.ts`. The claim's atomicity — two claims
 * at once leave one run — is the database's, covered by the query's
 * integration test; here the claim is a mock answering as it would.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const temporal = vi.hoisted(() => ({
	start: vi.fn(),
	getTemporalClient: vi.fn(),
	findBoundProposalPrompt: vi.fn(),
	checkRateLimit: vi.fn(),
}));

vi.mock("@repo/database", async () =>
	(await import("./proposal-artifact-harness")).databaseModule(),
);
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./proposal-artifact-harness")).proceduresModule(),
);
vi.mock("@repo/temporal", () => ({
	getTemporalClient: temporal.getTemporalClient,
}));
vi.mock("@repo/temporal/proposal-artifact-prompts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	findBoundProposalPrompt: temporal.findBoundProposalPrompt,
}));
vi.mock("../../../../../lib/rate-limit", () => ({
	checkRateLimit: temporal.checkRateLimit,
}));

import { ProposalArtifactTenantError } from "@repo/database";
import { PROPOSAL_PROMPT_NOT_BOUND } from "@repo/temporal/proposal-artifact-types";
import { runWithCorrelationId } from "@repo/utils/correlation-id";
import { PROPOSAL_INTERNAL_ANALYSIS_AGENT_KEY } from "@repo/utils/prompt-action-catalog";
import { documentProseHash } from "@repo/utils/proposal-artifact/section-hash";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import {
	PROPOSAL_ANALYSIS_RERUN_RATE_LIMIT,
	rerunProposalAnalysisProcedure,
} from "../rerun-analysis";
import {
	auditRows,
	call,
	DOC_A,
	mocks,
	ORG_A,
	PROJECT_A,
	refusal,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const RUN_KEY = `proposal-analysis-rerun-${DOC_A}-run-9`;

function claimed(overrides: Record<string, unknown> = {}) {
	return {
		outcome: "claimed",
		run: {
			analysisId: "run-9",
			runKey: RUN_KEY,
			sourceRunId: "run-1",
			proseHash: "p1:prose",
			contentHash: "content-hash",
			documentVersion: 4,
			timedOutRunIds: [],
			...overrides,
		},
	};
}

function rerun(userId: string = USERS.editor) {
	return call(
		rerunProposalAnalysisProcedure,
		{ projectId: PROJECT_A, documentId: DOC_A },
		userId,
	) as Promise<{ runId: string }>;
}

beforeEach(() => {
	resetWorld();
	resetMocks();
	for (const mock of Object.values(temporal)) {
		mock.mockReset();
	}
	temporal.getTemporalClient.mockResolvedValue({
		workflow: { start: temporal.start },
	});
	temporal.start.mockResolvedValue({ firstExecutionRunId: "temporal-run" });
	temporal.findBoundProposalPrompt.mockResolvedValue({
		promptId: "prompt-1",
		versionNumber: 3,
		promptVersionId: "prompt-version-3",
	});
	temporal.checkRateLimit.mockResolvedValue({
		allowed: true,
		remaining: 19,
		resetInSeconds: 3600,
	});
	mocks.claimRerun.mockResolvedValue(claimed());
});

describe("rerunAnalysis", () => {
	it("claims a run pinned to the member's bound analysis prompt and starts the analysis workflow under its key", async () => {
		expect(await rerun()).toEqual({ runId: "run-9" });

		expect(temporal.findBoundProposalPrompt).toHaveBeenCalledWith({
			userId: USERS.editor,
			organizationId: ORG_A,
			projectId: PROJECT_A,
			action: PROPOSAL_INTERNAL_ANALYSIS_AGENT_KEY,
		});
		expect(mocks.claimRerun).toHaveBeenCalledWith({
			organizationId: ORG_A,
			projectId: PROJECT_A,
			documentId: DOC_A,
			promptVersionId: "prompt-version-3",
			computeProseHash: documentProseHash,
		});
		expect(temporal.start).toHaveBeenCalledWith(
			"proposalAnalysisWorkflow",
			{
				taskQueue: "project-documents",
				workflowId: RUN_KEY,
				workflowIdConflictPolicy: "FAIL",
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				args: [
					{
						runId: "run-9",
						organizationId: ORG_A,
						projectId: PROJECT_A,
						documentId: DOC_A,
						userId: USERS.editor,
						planEligible: true,
					},
				],
			},
		);
		expect(mocks.failAnalysisRun).not.toHaveBeenCalled();
	});

	it("carries the request's correlation id in the workflow memo", async () => {
		await runWithCorrelationId("corr-123", () => rerun());

		expect(temporal.start).toHaveBeenCalledWith(
			"proposalAnalysisWorkflow",
			expect.objectContaining({ memo: { correlationId: "corr-123" } }),
		);
	});

	it("limits re-runs per owning organization", async () => {
		await rerun();

		expect(temporal.checkRateLimit).toHaveBeenCalledWith(
			`proposal-analysis-rerun:org:${ORG_A}`,
			PROPOSAL_ANALYSIS_RERUN_RATE_LIMIT.limit,
			PROPOSAL_ANALYSIS_RERUN_RATE_LIMIT.windowMs,
		);
	});

	it("answers TOO_MANY_REQUESTS over the limit, with no run recorded", async () => {
		temporal.checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 120,
		});

		expect(await refusal(rerun())).toMatchObject({
			code: "TOO_MANY_REQUESTS",
			data: { retryAfter: 120 },
		});
		expect(mocks.claimRerun).not.toHaveBeenCalled();
		expect(temporal.start).not.toHaveBeenCalled();
	});

	it("answers SERVICE_UNAVAILABLE when the limiter is down", async () => {
		temporal.checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 60,
			statusCode: 503,
		});

		expect((await refusal(rerun())).code).toBe("SERVICE_UNAVAILABLE");
		expect(mocks.claimRerun).not.toHaveBeenCalled();
	});

	it("refuses with PROPOSAL_PROMPT_NOT_BOUND when no analysis prompt is bound, with no run recorded", async () => {
		temporal.findBoundProposalPrompt.mockResolvedValue(null);

		expect(await refusal(rerun())).toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { code: PROPOSAL_PROMPT_NOT_BOUND },
		});
		expect(mocks.claimRerun).not.toHaveBeenCalled();
		expect(temporal.start).not.toHaveBeenCalled();
	});

	it.each(["DOCUMENT_GENERATING", "ANALYSIS_IN_PROGRESS"] as const)(
		"answers CONFLICT with %s when the claim is refused, starting nothing",
		async (reason) => {
			mocks.claimRerun.mockResolvedValue({ outcome: "conflict", reason });

			expect(await refusal(rerun())).toMatchObject({
				code: "CONFLICT",
				data: { code: reason },
			});
			expect(temporal.start).not.toHaveBeenCalled();
			expect(auditRows()).toEqual([]);
		},
	);

	it("starts one run and answers CONFLICT to the second of two calls at once", async () => {
		mocks.claimRerun
			.mockResolvedValueOnce(claimed())
			.mockResolvedValueOnce({
				outcome: "conflict",
				reason: "ANALYSIS_IN_PROGRESS",
			});

		const [first, second] = await Promise.allSettled([rerun(), rerun()]);

		const outcomes = [first, second].map((result) =>
			result.status === "fulfilled"
				? "started"
				: (result.reason as { code?: string }).code,
		);
		expect(outcomes.sort()).toEqual(["CONFLICT", "started"]);
		expect(temporal.start).toHaveBeenCalledTimes(1);
	});

	it("marks the claimed run FAILED when the workflow cannot be started", async () => {
		temporal.start.mockRejectedValue(new Error("connect ECONNREFUSED"));

		const result = await refusal(rerun());

		expect(result.code).toBe("INTERNAL_SERVER_ERROR");
		expect(result.message).not.toContain("ECONNREFUSED");
		expect(mocks.failAnalysisRun).toHaveBeenCalledWith({
			analysisId: "run-9",
			errorCode: "START_FAILED",
			errorMessage: "The internal analysis could not be started.",
		});
		expect(auditRows()).toEqual([]);
	});

	it("marks the claimed run FAILED when no Temporal client is available", async () => {
		temporal.getTemporalClient.mockRejectedValue(new Error("no client"));

		expect((await refusal(rerun())).code).toBe("INTERNAL_SERVER_ERROR");
		expect(mocks.failAnalysisRun).toHaveBeenCalledWith(
			expect.objectContaining({ analysisId: "run-9" }),
		);
	});

	it("leaves the run alone when the workflow already exists under its key", async () => {
		temporal.start.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"Workflow execution already started",
				RUN_KEY,
				"proposalAnalysisWorkflow",
			),
		);

		expect(await rerun()).toEqual({ runId: "run-9" });
		expect(mocks.failAnalysisRun).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND when the claim finds the document gone or moved", async () => {
		mocks.claimRerun.mockRejectedValue(
			new ProposalArtifactTenantError(
				"The document belongs to another project",
			),
		);

		expect((await refusal(rerun())).code).toBe("NOT_FOUND");
		expect(temporal.start).not.toHaveBeenCalled();
	});

	it("records the new run, its source run and the prompt version", async () => {
		mocks.claimRerun.mockResolvedValue(
			claimed({ timedOutRunIds: ["run-7", "run-8"] }),
		);

		await rerun();

		const rows = auditRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: "project.document_analysis.rerun_started",
			category: "project",
			outcome: "success",
			organizationId: ORG_A,
			projectId: PROJECT_A,
			resource: { type: "project_document", id: DOC_A, name: null },
		});
		expect(rows[0].metadata).toEqual({
			runId: "run-9",
			sourceRunId: "run-1",
			promptVersionId: "prompt-version-3",
			timedOutRunCount: 2,
		});
	});
});
