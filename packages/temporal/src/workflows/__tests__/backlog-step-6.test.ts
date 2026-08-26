/**
 * Tests for Fizzy #1412 PR3 Step 6 dispatch from the backlog workflows.
 *
 * Mirror-body style: re-implement the Step 6 body locally and pin the
 * contracts against a `vi.fn()` activity. Same precedent as PR2's
 * `step-6-operation-result.test.ts`. Replay determinism is enforced
 * separately by the implicit replay-validation matrix.
 *
 * What this pins for the BACKLOG callers specifically:
 *
 *   1. `operationKey` is derived from `workflowInfo().workflowId` (the
 *      stable server-side `backlog-analysis-${projectId}-${Date.now()}`
 *      / `backlog-apply-${projectId}-${Date.now()}` id, NOT something
 *      Temporal generates per-run). Stable across retries.
 *
 *   2. **Analysis success** → outcome "success", summary uses the
 *      activity's `proposal.summary` or falls back to the change-count
 *      sentence.
 *
 *   3. **Apply success / partial** outcome is derived from
 *      `progress.errors.length === 0` (i.e. the SAME predicate as the
 *      workflow's returned `success` field). This guarantees the
 *      persisted chat row agrees with the workflow output.
 *
 *   4. `conversationId === undefined` short-circuit — activity not
 *      called. Preserves today's transient behaviour for any caller
 *      that doesn't lazy-create a backlog conversation.
 *
 *   5. **isTerminal guard** in failure branches — mirrors PR2 direct-
 *      chat (Codex round-1 fix #1). Skips Step 6 for retryable
 *      `ApplicationFailure` to avoid stale "failure" rows.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/backlog-step-6.test.ts
 */

import { describe, expect, it, vi } from "vitest";

type OperationOutcome = "success" | "failure" | "partial" | "cancelled";

interface PostOperationResultInput {
	readonly conversationId: string;
	readonly userId: string;
	readonly organizationId?: string | null;
	readonly operationKey: string;
	readonly outcome: OperationOutcome;
	readonly operationLabel: string;
	readonly summary: string;
}

interface PostOperationResultOutput {
	readonly posted: boolean;
	readonly messageId?: string;
	readonly deduplicated?: boolean;
	readonly reason?: string;
}

type PostOperationResultActivity = (
	input: PostOperationResultInput,
) => Promise<PostOperationResultOutput>;

const SUCCESS_RESPONSE: PostOperationResultOutput = {
	posted: true,
	messageId: "msg-backlog-1",
	deduplicated: false,
};

function makeActivity(
	override?: PostOperationResultOutput,
): ReturnType<typeof vi.fn> {
	return vi.fn().mockResolvedValue(override ?? SUCCESS_RESPONSE);
}

function asActivity(fn: ReturnType<typeof vi.fn>): PostOperationResultActivity {
	return fn as unknown as PostOperationResultActivity;
}

// =============================================================================
// Mirror — `backlogContextAnalysisWorkflow` Step 6 (success branch)
// =============================================================================

interface ContextAnalysisSuccessInput {
	workflowId: string;
	userId: string;
	organizationId?: string | null;
	conversationId?: string;
	proposalSummary?: string;
	proposalChangeCount: number;
}

async function runStep6ContextAnalysisSuccess(
	input: ContextAnalysisSuccessInput,
	activity: PostOperationResultActivity,
): Promise<PostOperationResultOutput | "skipped"> {
	if (!input.conversationId) {
		return "skipped";
	}
	return await activity({
		conversationId: input.conversationId,
		userId: input.userId,
		organizationId: input.organizationId ?? null,
		operationKey: `${input.workflowId}-result`,
		outcome: "success",
		operationLabel: "Backlog analysis",
		summary:
			input.proposalSummary ||
			`Analysis complete. ${input.proposalChangeCount} change(s) proposed.`,
	});
}

// =============================================================================
// Mirror — `backlogContextAnalysisWorkflow` Step 6 (failure branch)
// =============================================================================

interface ContextAnalysisFailureInput {
	workflowId: string;
	userId: string;
	organizationId?: string | null;
	conversationId?: string;
	errorMessage: string;
	/**
	 * Mirrors `!(error instanceof ApplicationFailure) || error.nonRetryable === true`.
	 * Defaults to `true` (today the workflow only throws nonRetryable, so
	 * everything that reaches the catch is terminal).
	 */
	isTerminal?: boolean;
	/**
	 * Code-reviewer #2 fix — mirror the workflow's
	 * `error.type === "BACKLOG_ANALYSIS_CANCELLED"` sniff. When `true`,
	 * the workflow posts `outcome: "cancelled"` instead of `"failure"`.
	 */
	isCancellation?: boolean;
}

async function runStep6ContextAnalysisFailure(
	input: ContextAnalysisFailureInput,
	activity: PostOperationResultActivity,
): Promise<PostOperationResultOutput | "skipped"> {
	if (!input.conversationId) {
		return "skipped";
	}
	const isTerminal = input.isTerminal ?? true;
	if (!isTerminal) {
		return "skipped";
	}
	const outcome: "failure" | "cancelled" = input.isCancellation
		? "cancelled"
		: "failure";
	return await activity({
		conversationId: input.conversationId,
		userId: input.userId,
		organizationId: input.organizationId ?? null,
		operationKey: `${input.workflowId}-result`,
		outcome,
		operationLabel: "Backlog analysis",
		summary: input.errorMessage,
	});
}

// =============================================================================
// Mirror — `backlogApplyChangesWorkflow` Step 6 (failure / cancellation branch)
// =============================================================================

interface ApplyFailureInput {
	workflowId: string;
	userId: string;
	organizationId?: string | null;
	conversationId?: string;
	errorMessage: string;
	isTerminal?: boolean;
	/** Mirrors `error.type === "BACKLOG_APPLY_CANCELLED"`. */
	isCancellation?: boolean;
}

async function runStep6ApplyFailure(
	input: ApplyFailureInput,
	activity: PostOperationResultActivity,
): Promise<PostOperationResultOutput | "skipped"> {
	if (!input.conversationId) {
		return "skipped";
	}
	const isTerminal = input.isTerminal ?? true;
	if (!isTerminal) {
		return "skipped";
	}
	const outcome: "failure" | "cancelled" = input.isCancellation
		? "cancelled"
		: "failure";
	return await activity({
		conversationId: input.conversationId,
		userId: input.userId,
		organizationId: input.organizationId ?? null,
		operationKey: `${input.workflowId}-result`,
		outcome,
		operationLabel: "Backlog apply",
		summary: input.errorMessage,
	});
}

// =============================================================================
// Mirror — `backlogApplyChangesWorkflow` Step 6 (success-with-errors branch)
// =============================================================================

interface ApplySuccessInput {
	workflowId: string;
	userId: string;
	organizationId?: string | null;
	conversationId?: string;
	appliedCount: number;
	syncedToPMCount: number;
	syncToPM: boolean;
	errorsCount: number;
}

async function runStep6ApplySuccess(
	input: ApplySuccessInput,
	activity: PostOperationResultActivity,
): Promise<PostOperationResultOutput | "skipped"> {
	if (!input.conversationId) {
		return "skipped";
	}
	// Codex PR3 round-1 fix #6 — outcome trichotomy.
	//   success: zero errors (regardless of applied count)
	//   failure: zero applied AND some errors (full-rate failure)
	//   partial: mixed (some applied, some failed)
	const persistedOutcome: "success" | "partial" | "failure" =
		input.errorsCount === 0
			? "success"
			: input.appliedCount === 0
				? "failure"
				: "partial";
	const summaryParts: string[] = [];
	summaryParts.push(
		`${input.appliedCount} change(s) applied${
			input.syncToPM ? `, ${input.syncedToPMCount} synced to PM tool` : ""
		}.`,
	);
	if (input.errorsCount > 0) {
		summaryParts.push(`${input.errorsCount} error(s) during apply.`);
	}
	return await activity({
		conversationId: input.conversationId,
		userId: input.userId,
		organizationId: input.organizationId ?? null,
		operationKey: `${input.workflowId}-result`,
		outcome: persistedOutcome,
		operationLabel: "Backlog apply",
		summary: summaryParts.join(" "),
	});
}

// =============================================================================
// Tests — context analysis
// =============================================================================

describe("Step 6 — backlogContextAnalysisWorkflow (success branch)", () => {
	it("passes operationKey = `${workflowId}-result` (stable across retries)", async () => {
		const activity = makeActivity();
		await runStep6ContextAnalysisSuccess(
			{
				workflowId: "backlog-analysis-proj1-1700000000000",
				userId: "user-1",
				conversationId: "conv-1",
				proposalSummary: "Updated 5 features.",
				proposalChangeCount: 5,
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				operationKey: "backlog-analysis-proj1-1700000000000-result",
			}),
		);
	});

	it("uses proposal.summary as primary summary", async () => {
		const activity = makeActivity();
		await runStep6ContextAnalysisSuccess(
			{
				workflowId: "wf-1",
				userId: "user-1",
				conversationId: "conv-1",
				proposalSummary: "Found 3 missing acceptance criteria.",
				proposalChangeCount: 3,
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: "Found 3 missing acceptance criteria.",
				outcome: "success",
				operationLabel: "Backlog analysis",
			}),
		);
	});

	it("falls back to change-count sentence when proposal.summary is empty", async () => {
		const activity = makeActivity();
		await runStep6ContextAnalysisSuccess(
			{
				workflowId: "wf-2",
				userId: "user-1",
				conversationId: "conv-1",
				proposalSummary: "",
				proposalChangeCount: 7,
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: "Analysis complete. 7 change(s) proposed.",
			}),
		);
	});

	it("skips entirely when conversationId is undefined (transient surface)", async () => {
		const activity = makeActivity();
		const result = await runStep6ContextAnalysisSuccess(
			{
				workflowId: "wf-3",
				userId: "user-1",
				// no conversationId
				proposalSummary: "anything",
				proposalChangeCount: 1,
			},
			asActivity(activity),
		);
		expect(result).toBe("skipped");
		expect(activity).not.toHaveBeenCalled();
	});

	it("normalises absent organizationId to null", async () => {
		const activity = makeActivity();
		await runStep6ContextAnalysisSuccess(
			{
				workflowId: "wf-4",
				userId: "user-1",
				conversationId: "conv-personal",
				// no organizationId
				proposalSummary: "ok",
				proposalChangeCount: 1,
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: null }),
		);
	});
});

describe("Step 6 — backlogContextAnalysisWorkflow (failure branch)", () => {
	it("posts outcome 'failure' for terminal errors", async () => {
		const activity = makeActivity();
		await runStep6ContextAnalysisFailure(
			{
				workflowId: "wf-fail",
				userId: "user-1",
				conversationId: "conv-1",
				errorMessage: "LLM analysis exceeded budget",
				isTerminal: true,
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "failure",
				summary: "LLM analysis exceeded budget",
				operationLabel: "Backlog analysis",
			}),
		);
	});

	it("SKIPS for retryable failures (stale-row prevention, mirrors PR2 direct-chat)", async () => {
		const activity = makeActivity();
		const result = await runStep6ContextAnalysisFailure(
			{
				workflowId: "wf-retry",
				userId: "user-1",
				conversationId: "conv-1",
				errorMessage: "transient",
				isTerminal: false,
			},
			asActivity(activity),
		);
		expect(result).toBe("skipped");
		expect(activity).not.toHaveBeenCalled();
	});

	it("skips entirely when conversationId is undefined", async () => {
		const activity = makeActivity();
		const result = await runStep6ContextAnalysisFailure(
			{
				workflowId: "wf-no-conv",
				userId: "user-1",
				errorMessage: "boom",
			},
			asActivity(activity),
		);
		expect(result).toBe("skipped");
		expect(activity).not.toHaveBeenCalled();
	});

	// Code-reviewer #2 fix — cancellation outcome contract.
	it("posts outcome 'cancelled' (NOT 'failure') for `BACKLOG_ANALYSIS_CANCELLED` errors", async () => {
		const activity = makeActivity();
		await runStep6ContextAnalysisFailure(
			{
				workflowId: "wf-cancel",
				userId: "user-1",
				conversationId: "conv-1",
				errorMessage: "Cancelled by user",
				isTerminal: true,
				isCancellation: true,
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "cancelled",
				summary: "Cancelled by user",
				operationLabel: "Backlog analysis",
			}),
		);
	});
});

describe("Step 6 — backlogApplyChangesWorkflow (failure / cancellation branch)", () => {
	it("posts outcome 'failure' for non-cancellation terminal errors", async () => {
		const activity = makeActivity();
		await runStep6ApplyFailure(
			{
				workflowId: "apply-fail",
				userId: "user-1",
				conversationId: "conv-1",
				errorMessage: "Database write failed",
				isTerminal: true,
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "failure",
				summary: "Database write failed",
				operationLabel: "Backlog apply",
			}),
		);
	});

	it("posts outcome 'cancelled' for `BACKLOG_APPLY_CANCELLED` errors", async () => {
		const activity = makeActivity();
		await runStep6ApplyFailure(
			{
				workflowId: "apply-cancel",
				userId: "user-1",
				conversationId: "conv-1",
				errorMessage: "Apply cancelled by user",
				isTerminal: true,
				isCancellation: true,
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "cancelled",
				summary: "Apply cancelled by user",
				operationLabel: "Backlog apply",
			}),
		);
	});

	it("SKIPS for retryable apply failures (stale-row prevention)", async () => {
		const activity = makeActivity();
		const result = await runStep6ApplyFailure(
			{
				workflowId: "apply-retry",
				userId: "user-1",
				conversationId: "conv-1",
				errorMessage: "transient PM API outage",
				isTerminal: false,
			},
			asActivity(activity),
		);
		expect(result).toBe("skipped");
		expect(activity).not.toHaveBeenCalled();
	});

	it("skips entirely when conversationId is undefined (failure path)", async () => {
		const activity = makeActivity();
		const result = await runStep6ApplyFailure(
			{
				workflowId: "apply-no-conv",
				userId: "user-1",
				errorMessage: "boom",
			},
			asActivity(activity),
		);
		expect(result).toBe("skipped");
		expect(activity).not.toHaveBeenCalled();
	});
});

// =============================================================================
// Tests — apply changes
// =============================================================================

describe("Step 6 — backlogApplyChangesWorkflow (success branch)", () => {
	it("derives outcome 'success' when errorsCount === 0", async () => {
		const activity = makeActivity();
		await runStep6ApplySuccess(
			{
				workflowId: "backlog-apply-proj1-1700000000000",
				userId: "user-1",
				conversationId: "conv-1",
				appliedCount: 5,
				syncedToPMCount: 5,
				syncToPM: true,
				errorsCount: 0,
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "success",
				operationKey: "backlog-apply-proj1-1700000000000-result",
				operationLabel: "Backlog apply",
				summary: "5 change(s) applied, 5 synced to PM tool.",
			}),
		);
	});

	it("derives outcome 'partial' when SOME applied AND some errors (mixed)", async () => {
		const activity = makeActivity();
		await runStep6ApplySuccess(
			{
				workflowId: "wf-partial",
				userId: "user-1",
				conversationId: "conv-1",
				appliedCount: 5,
				syncedToPMCount: 3,
				syncToPM: true,
				errorsCount: 2,
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "partial",
				summary:
					"5 change(s) applied, 3 synced to PM tool. 2 error(s) during apply.",
			}),
		);
	});

	// Codex PR3 round-1 fix #6 — full-rate failure case.
	it("derives outcome 'failure' when appliedCount === 0 AND errorsCount > 0 (every change failed)", async () => {
		const activity = makeActivity();
		await runStep6ApplySuccess(
			{
				workflowId: "wf-full-fail",
				userId: "user-1",
				conversationId: "conv-1",
				appliedCount: 0,
				syncedToPMCount: 0,
				syncToPM: false,
				errorsCount: 3,
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "failure",
				summary: "0 change(s) applied. 3 error(s) during apply.",
			}),
		);
	});

	it("omits PM-sync clause from summary when syncToPM is false", async () => {
		const activity = makeActivity();
		await runStep6ApplySuccess(
			{
				workflowId: "wf-no-sync",
				userId: "user-1",
				conversationId: "conv-1",
				appliedCount: 4,
				syncedToPMCount: 0,
				syncToPM: false,
				errorsCount: 0,
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: "4 change(s) applied.",
			}),
		);
	});

	it("skips entirely when conversationId is undefined", async () => {
		const activity = makeActivity();
		const result = await runStep6ApplySuccess(
			{
				workflowId: "wf-skip",
				userId: "user-1",
				appliedCount: 1,
				syncedToPMCount: 0,
				syncToPM: false,
				errorsCount: 0,
			},
			asActivity(activity),
		);
		expect(result).toBe("skipped");
		expect(activity).not.toHaveBeenCalled();
	});
});

// =============================================================================
// Tests — idempotency: same workflowId → same operationKey
// =============================================================================

describe("Step 6 — backlog idempotency contract", () => {
	it("two analysis attempts with the same workflowId hit the same operationKey", async () => {
		const activity = makeActivity();
		const input: ContextAnalysisSuccessInput = {
			workflowId: "backlog-analysis-stable",
			userId: "user-1",
			conversationId: "conv-1",
			proposalSummary: "ok",
			proposalChangeCount: 1,
		};
		await runStep6ContextAnalysisSuccess(input, asActivity(activity));
		await runStep6ContextAnalysisSuccess(input, asActivity(activity));
		const calls = activity.mock.calls.map(
			(c) => c[0] as PostOperationResultInput,
		);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.operationKey).toBe(calls[1]?.operationKey);
		expect(calls[0]?.operationKey).toBe("backlog-analysis-stable-result");
	});

	it("apply and analysis workflows have DISTINCT operationKey shapes (different workflowIds)", async () => {
		const activity = makeActivity();
		await runStep6ContextAnalysisSuccess(
			{
				workflowId: "backlog-analysis-proj1-T1",
				userId: "user-1",
				conversationId: "conv-shared",
				proposalSummary: "ok",
				proposalChangeCount: 1,
			},
			asActivity(activity),
		);
		await runStep6ApplySuccess(
			{
				workflowId: "backlog-apply-proj1-T2",
				userId: "user-1",
				conversationId: "conv-shared",
				appliedCount: 1,
				syncedToPMCount: 0,
				syncToPM: false,
				errorsCount: 0,
			},
			asActivity(activity),
		);
		const calls = activity.mock.calls.map(
			(c) => c[0] as PostOperationResultInput,
		);
		// Both messages land in the same `conv-shared` (BacklogChat
		// reuses the lazy-created conversation across analyze+apply),
		// but the operationKey differs so dedup doesn't collide.
		expect(calls[0]?.conversationId).toBe("conv-shared");
		expect(calls[1]?.conversationId).toBe("conv-shared");
		expect(calls[0]?.operationKey).not.toBe(calls[1]?.operationKey);
	});
});
