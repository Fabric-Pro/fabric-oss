import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	enabled: true,
	classify: vi.fn(),
	delay: vi.fn(),
	authority: vi.fn(),
	execute: vi.fn(),
	stepNonRetryableTypes: [] as string[],
}));
vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	patched: vi.fn(() => mocks.enabled),
	proxyActivities: (options: {
		retry?: { nonRetryableErrorTypes?: string[] };
	}) => ({
		classifyFailureActivity: mocks.classify,
		getRetryDelayActivity: mocks.delay,
		checkStepAuthorityActivity: mocks.authority,
		executeStep: (...args: unknown[]) => {
			mocks.stepNonRetryableTypes =
				options.retry?.nonRetryableErrorTypes ?? [];
			return mocks.execute(...args);
		},
	}),
	sleep: vi.fn(),
	workflowInfo: vi.fn(),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import {
	ActivityFailure,
	ApplicationFailure,
	RetryState,
} from "@temporalio/common";
import { patched } from "@temporalio/workflow";
import { classifyFailure } from "../../../activities/orchestrator/execution/recovery-manager";
import { buildWorkflowOutput } from "../phases/completion";
import { executeExecutionPhase } from "../phases/execution";
import { processStepResult } from "../step-processing";
import { createInitialState, type TaskStep } from "../types";

const refusal =
	"AI usage limit exceeded: example-limit (TOKENS, DAILY) — used 429 of 429";
function refusedStep() {
	return new ActivityFailure(
		"Activity task failed",
		"executeStep",
		"example",
		RetryState.NON_RETRYABLE_FAILURE,
		"example-worker",
		ApplicationFailure.create({
			type: "AiUsageLimitExceededError",
			message: refusal,
		}),
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.enabled = true;
	mocks.classify.mockResolvedValue({ type: "unknown", isRetryable: false });
});
it("classifies the refusal before numeric rate-limit heuristics", () => {
	expect(classifyFailure(new Error(refusal), {} as TaskStep)).toEqual({
		type: "usage_limit",
		message: refusal,
		isRetryable: false,
	});
});
it("aborts a non-critical failed step only with the marker", async () => {
	for (const enabled of [true, false]) {
		vi.clearAllMocks();
		mocks.enabled = enabled;
		const input = {
			executionId: "example-execution",
			userId: "example-user",
			organizationId: "example-org",
			message: "Plan",
			executionMode: "save_reuse" as const,
			history: [],
		};
		const state = createInitialState(input);
		const step = {
			id: "example-step",
			description: "Example",
			executor: "example-agent",
			riskLevel: "low",
			inputs: {},
		} as TaskStep;
		const result = await processStepResult({
			state,
			input,
			step,
			stepResult: { success: false, error: refusal },
			stepStartTime: Date.now(),
			modeConfig: {} as never,
			altkConfig: {} as never,
			taskPlan: { steps: [step] } as never,
			updateProgress: vi.fn(),
		});
		expect(result.shouldAbort).toBe(enabled);
		if (enabled) {
			expect(result.abortError).toBe(refusal);
			expect(mocks.classify).not.toHaveBeenCalled();
		} else {
			expect(mocks.classify).toHaveBeenCalled();
		}
		expect(patched).toHaveBeenCalledWith(
			"orch-plan-step-usage-limit-abort-v1",
		);
	}
});

it.each([false, true])(
	"phase preserves Temporal refusal sequential=%s",
	async (sequential) => {
		for (const enabled of [true, false]) {
			vi.clearAllMocks();
			mocks.enabled = enabled;
			mocks.authority.mockResolvedValue({ allowed: true });
			mocks.execute.mockRejectedValue(refusedStep());
			const input = {
				executionId: "example-execution",
				userId: "example-user",
				organizationId: "example-org",
				message: "Plan",
				executionMode: "save_reuse" as const,
				history: [],
			};
			const state = createInitialState(input);
			const step = {
				id: "example-step",
				description: "Example",
				executor: "example-agent",
				type: "generate",
				riskLevel: "low",
				inputs: {},
				status: "pending",
				requiresApproval: sequential,
				approvalId: sequential ? "example-approval" : undefined,
				order: 0,
				dependsOn: [],
			} as TaskStep;
			state.taskPlan = { id: "example-plan", steps: [step] } as never;
			const result = await executeExecutionPhase(
				state,
				input,
				{} as never,
				{} as never,
				vi.fn(),
				vi.fn(),
				() => false,
			);
			expect(result.success).toBe(!enabled);
			if (enabled) {
				expect(result.error).toBe(refusal);
				expect(mocks.execute).toHaveBeenCalledTimes(1);
				expect(mocks.stepNonRetryableTypes).toContain(
					"AiUsageLimitExceededError",
				);
				expect(
					buildWorkflowOutput(state, "failed", result.error).error,
				).toBe(result.error);
				expect(mocks.classify).not.toHaveBeenCalled();
			}
			expect(patched).toHaveBeenCalledWith(
				"orch-plan-step-usage-limit-abort-v1",
			);
		}
	},
);

it("stops recovery when a retry encounters a usage refusal", async () => {
	mocks.classify.mockResolvedValue({ type: "unknown", isRetryable: true });
	mocks.delay.mockResolvedValue(1);
	mocks.execute.mockRejectedValue(refusedStep());
	const input = {
		executionId: "example-execution",
		userId: "example-user",
		message: "Plan",
		executionMode: "save_reuse" as const,
		history: [],
	};
	const state = createInitialState(input);
	const step = {
		id: "example-step",
		description: "Example",
		executor: "example-agent",
		riskLevel: "low",
		inputs: {},
	} as TaskStep;
	state.taskPlan = { id: "example-plan", steps: [step] } as never;
	const result = await processStepResult({
		state,
		input,
		step,
		stepResult: { success: false, error: "Transient failure" },
		stepStartTime: Date.now(),
		modeConfig: {} as never,
		altkConfig: {} as never,
		taskPlan: state.taskPlan,
		updateProgress: vi.fn(),
	});
	expect(result).toMatchObject({ shouldAbort: true, abortError: refusal });
	expect(mocks.execute).toHaveBeenCalledTimes(1);
	expect(mocks.stepNonRetryableTypes).toContain("AiUsageLimitExceededError");
});
