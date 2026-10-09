/**
 * `proposalAnalysisWorkflow` (Fizzy #2801): one bounded review activity, and
 * when it gives up the workflow records the run FAILED itself, with the code
 * the failure carries. The Main document is never part of it: the child
 * workflow that started it has already completed.
 *
 * Harness convention (see `supplied-context-wiring.test.ts`): mock the
 * activity surface and drive the workflow body as a plain async function.
 */

import {
	ActivityFailure,
	ApplicationFailure,
	TimeoutFailure,
} from "@temporalio/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	proxies: [] as Array<Record<string, unknown>>,
	activities: {
		runProposalAnalysis: vi.fn(),
		failProposalAnalysisRun: vi.fn(),
	},
}));

vi.mock("@temporalio/workflow", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@temporalio/workflow")>();
	return {
		...actual,
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		proxyActivities: vi.fn((options: Record<string, unknown>) => {
			h.proxies.push(options);
			return h.activities;
		}),
	};
});

import { PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE } from "../../task-queues";
import { proposalAnalysisWorkflow } from "../proposal-analysis";

const INPUT = {
	runId: "analysis-1",
	organizationId: "org-1",
	projectId: "project-1",
	documentId: "doc-1",
	userId: "user-1",
	planEligible: true,
};

const FAIL_INPUT = {
	runId: "analysis-1",
	organizationId: "org-1",
	projectId: "project-1",
	documentId: "doc-1",
	userId: "user-1",
};

function activityFailure(cause: Error): ActivityFailure {
	return new ActivityFailure(
		"Activity task failed",
		"runProposalAnalysis",
		"1",
		"NON_RETRYABLE_FAILURE",
		"worker@example.com",
		cause,
	);
}

beforeEach(() => {
	h.activities.runProposalAnalysis.mockReset();
	h.activities.failProposalAnalysisRun.mockReset();
	h.activities.failProposalAnalysisRun.mockResolvedValue({
		outcome: "written",
	});
});

describe("proposalAnalysisWorkflow", () => {
	it("passes its ids to the review and reports the findings it stored", async () => {
		h.activities.runProposalAnalysis.mockResolvedValue({
			outcome: "completed",
			findingCount: 3,
		});

		const result = await proposalAnalysisWorkflow(INPUT);

		expect(h.activities.runProposalAnalysis).toHaveBeenCalledWith(INPUT);
		expect(result).toEqual({ status: "COMPLETE", findingCount: 3 });
		expect(h.activities.failProposalAnalysisRun).not.toHaveBeenCalled();
	});

	it("leaves a run that already finished alone", async () => {
		h.activities.runProposalAnalysis.mockResolvedValue({
			outcome: "superseded",
			findingCount: 0,
		});

		const result = await proposalAnalysisWorkflow(INPUT);

		expect(result.status).toBe("SUPERSEDED");
		expect(h.activities.failProposalAnalysisRun).not.toHaveBeenCalled();
	});

	it.each([
		[
			"no AI provider is configured",
			activityFailure(
				ApplicationFailure.nonRetryable(
					"No AI provider is configured.",
					"AI_PROVIDER_NOT_CONFIGURED",
				),
			),
			"AI_PROVIDER_NOT_CONFIGURED",
		],
		[
			"the resolver's own refusal reaches the workflow",
			activityFailure(
				ApplicationFailure.nonRetryable(
					"No AI provider configured",
					"AIProviderNotConfiguredError",
				),
			),
			"AI_PROVIDER_NOT_CONFIGURED",
		],
		[
			"the pinned prompt cannot be rendered",
			activityFailure(
				ApplicationFailure.nonRetryable(
					"The internal analysis prompt could not be prepared.",
					"PROMPT_RENDER_FAILED",
				),
			),
			"PROMPT_RENDER_FAILED",
		],
		[
			"retries are exhausted on a provider error",
			activityFailure(
				ApplicationFailure.retryable("Upstream 503", "Error"),
			),
			"MODEL_ERROR",
		],
		[
			"the last attempt runs out of time",
			activityFailure(
				new TimeoutFailure(
					"Activity timed out",
					undefined,
					"START_TO_CLOSE",
				),
			),
			"TIMED_OUT",
		],
	] as const)(
		"records the run FAILED when %s",
		async (_case, failure, errorCode) => {
			h.activities.runProposalAnalysis.mockRejectedValue(failure);

			const result = await proposalAnalysisWorkflow(INPUT);

			expect(result).toEqual({
				status: "FAILED",
				findingCount: 0,
				errorCode,
			});
			expect(h.activities.failProposalAnalysisRun).toHaveBeenCalledWith({
				...FAIL_INPUT,
				errorCode,
			});
		},
	);

	it("does not fail itself when even the FAILED write gives up", async () => {
		h.activities.runProposalAnalysis.mockRejectedValue(
			activityFailure(new Error("boom")),
		);
		h.activities.failProposalAnalysisRun.mockRejectedValue(
			new Error("database unavailable"),
		);

		const result = await proposalAnalysisWorkflow(INPUT);

		expect(result.status).toBe("FAILED");
		expect(result.errorCode).toBe("MODEL_ERROR");
	});
});

describe("proposalAnalysisWorkflow — activity options", () => {
	type Proxy = {
		taskQueue?: string;
		heartbeatTimeout?: string;
		startToCloseTimeout?: string;
		retry?: { maximumAttempts?: number; nonRetryableErrorTypes?: string[] };
	};
	const proxies = () => h.proxies as Proxy[];

	it("runs the review on the generation queue, bounded, heartbeating, refusing to retry a verdict", () => {
		const review = proxies().find((proxy) => proxy.heartbeatTimeout);
		expect(review?.taskQueue).toBe(
			PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
		);
		expect(review?.retry?.maximumAttempts).toBe(3);
		expect(review?.retry?.nonRetryableErrorTypes).toEqual(
			expect.arrayContaining([
				"AIProviderNotConfiguredError",
				"AI_PROVIDER_NOT_CONFIGURED",
				"PROMPT_RENDER_FAILED",
			]),
		);
	});

	it("gives the FAILED write its own, longer retry window", () => {
		const failWrite = proxies().find((proxy) => !proxy.heartbeatTimeout);
		expect(failWrite?.taskQueue).toBe(
			PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
		);
		expect(failWrite?.retry?.maximumAttempts).toBeGreaterThan(
			proxies().find((proxy) => proxy.heartbeatTimeout)?.retry
				?.maximumAttempts ?? 0,
		);
	});
});
