/**
 * Tests for the "Step 6" persistent operation-result
 * dispatch that lives in `orchestratorCompletionWorkflow` (this directory's
 * `completion.ts` § Step 6) and `directChatWorkflow`
 * (`packages/temporal/src/workflows/direct-chat.ts` success / failure path
 * § Step 6).
 *
 * # Why mirror-body tests instead of TestWorkflowEnvironment
 *
 * The Step 6 logic is structurally simple — an outcome-derivation tern, a
 * `conversationId` guard, and an activity call with a stable operationKey
 * — and the entire orchestrator completion workflow already exists in
 * production code (we don't want to dupe-encode 400 lines of the real
 * workflow). Following the precedent set by
 * `incident-lifecycle.test.ts` and `draft-project-cleanup-workflow.test.ts`,
 * we re-implement ONLY the Step 6 body as a small async function and pin
 * the contract against a `vi.fn()` activity callable. Spinning up
 * Temporalite for one assertion would be overkill and would pull the
 * binary into CI.
 *
 * Determinism / replay coverage is enforced separately by
 * `.github/workflows/temporal-replay-validation.yml` against production
 * workflow histories.
 *
 * # The Contracts Pinned Here
 *
 *   1. **Outcome derivation** for the orchestrator completion phase is the
 *      same `every → success / some → partial / none → failure` formula
 *      used by Steps 3 + 4 of `completion.ts`. If this ever diverges, both
 *      this test and the production code show the diff side-by-side and
 *      one of them is broken.
 *
 *   2. **`operationKey`** is `${executionId}-result` — STABLE across
 *      retries so `appendConversationMessage`'s idempotency check
 *      deduplicates. PR1 has unit tests for the dedup itself; here we
 *      pin the key shape passed BY the workflow.
 *
 *   3. **`conversationId` short-circuit** — when undefined, the activity
 *      MUST NOT be called. This protects today's Nexus / CopilotPage
 *      surface (no `AgentConversation` backing) from creating orphan
 *      rows.
 *
 *   4. **Failure summary forwarding** — direct-chat passes the raw error
 *      message; the pure formatter (PR1) masks stack-trace shapes and
 *      truncates to 2 000 chars, so the workflow doesn't need to
 *      sanitize.
 *
 *   5. **operationLabel choice** — direct-chat uses "Agent (direct)" when
 *      `instanceId` is set (the agent-template instance UX) and
 *      "Direct chat" otherwise. Orchestrator uses "Orchestrator
 *      (${executionMode})" only in iterative / save_reuse modes, else
 *      plain "Orchestrator".
 *
 * Run with:
 *   pnpm --filter @repo/temporal test src/workflows/orchestrator/phases/__tests__/step-6-operation-result.test.ts
 */

import { describe, expect, it, vi } from "vitest";

// Activity input/output shape — copied verbatim from
// `packages/temporal/src/activities/post-operation-result.ts`. Kept in test
// scope so a divergence is caught on code review (the activity file is
// short — easy to keep in sync). Local re-declaration follows the
// established pattern in `incident-lifecycle.test.ts`.
type OperationOutcome = "success" | "failure" | "partial" | "cancelled";

interface PostOperationResultInput {
	readonly conversationId: string;
	readonly userId: string;
	readonly organizationId?: string | null;
	readonly operationKey: string;
	readonly outcome: OperationOutcome;
	readonly operationLabel: string;
	readonly summary: string;
	readonly errorCode?: string;
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

// =============================================================================
// Mirror — `orchestratorCompletionWorkflow` Step 6
// =============================================================================

interface TaskPlanStep {
	id: string;
	description: string;
	status: string;
	executor?: string;
}

interface CompletionMirrorInput {
	executionId: string;
	userId: string;
	organizationId?: string | null;
	conversationId?: string;
	finalResponse: string;
	message: string;
	executionMode: string;
	taskPlanSteps: TaskPlanStep[];
	isIterativeMode: boolean;
}

/**
 * Re-implementation of the Step 6 body from `completion.ts`. Production
 * source lives next door in `../completion.ts` and the diff between the
 * two should fit on one screen during code review. The
 * `CancellationScope.nonCancellable` wrapper from production is omitted
 * here because the test environment is not a Temporal workflow sandbox;
 * the wrapper's effect (the activity completes even if cancelled) is
 * orthogonal to the contract we pin in this file.
 */
async function runStep6Orchestrator(
	input: CompletionMirrorInput,
	postOperationResultActivity: PostOperationResultActivity,
): Promise<PostOperationResultOutput | "skipped"> {
	const { conversationId, taskPlanSteps, executionId, executionMode } = input;

	if (!conversationId) {
		return "skipped";
	}

	const outcome: "success" | "partial" | "failure" = taskPlanSteps.every(
		(s) => s.status === "complete",
	)
		? "success"
		: taskPlanSteps.some((s) => s.status === "complete")
			? "partial"
			: "failure";

	const operationLabel =
		input.isIterativeMode || executionMode === "save_reuse"
			? `Orchestrator (${executionMode})`
			: "Orchestrator";

	return await postOperationResultActivity({
		conversationId,
		userId: input.userId,
		organizationId: input.organizationId ?? null,
		operationKey: `${executionId}-result`,
		outcome,
		operationLabel,
		summary: input.finalResponse || input.message,
	});
}

// =============================================================================
// Mirror — `directChatWorkflow` Step 6 (both paths)
// =============================================================================

interface DirectChatMirrorBase {
	executionId: string;
	userId: string;
	organizationId?: string | null;
	conversationId?: string;
	instanceId?: string;
	message: string;
}

interface DirectChatSuccessInput extends DirectChatMirrorBase {
	/**
	 * Mirrors `DirectChatActivityResult.success`. When `false`, the
	 * activity caught its own error internally and returned a falsy-
	 * success shape WITHOUT throwing (Copilot review fix #1). The
	 * workflow's success branch is then reached, but persisted outcome
	 * MUST be "failure" with `error` as the summary — not "success".
	 */
	resultSuccess?: boolean;
	responseText: string;
	error?: string;
}

interface DirectChatFailureInput extends DirectChatMirrorBase {
	errorMessage: string;
	/**
	 * Codex review fix #1 — mirrors the workflow's `isTerminal` guard.
	 * When `false` (i.e. the caught error is a retryable
	 * `ApplicationFailure`), the workflow MUST skip Step 6 so that a
	 * subsequent successful retry can post the real outcome without
	 * being dedup-blocked by a stale "failure" row at the same
	 * `operationKey`. Defaults to `true` so existing tests that don't
	 * pass the flag keep their original behaviour (post on failure).
	 */
	isTerminal?: boolean;
}

async function runStep6DirectChatSuccess(
	input: DirectChatSuccessInput,
	postOperationResultActivity: PostOperationResultActivity,
): Promise<PostOperationResultOutput | "skipped"> {
	if (!input.conversationId) {
		return "skipped";
	}
	// Copilot review fix #1 — outcome is derived from the activity's
	// own `success` flag, not from "did we throw". When
	// `executeDirectChatActivity` catches its own error internally and
	// returns `{ success: false, error }`, the workflow's success
	// branch is reached but the PERSISTED outcome must reflect what
	// the user actually saw (a failure surfaced by the SSE route's
	// `if (!result.success)` arm).
	const resultSuccess = input.resultSuccess ?? true;
	const outcome: "success" | "failure" = resultSuccess
		? "success"
		: "failure";
	const summary = resultSuccess
		? input.responseText || input.message
		: input.error || "Unknown error";
	return await postOperationResultActivity({
		conversationId: input.conversationId,
		userId: input.userId,
		organizationId: input.organizationId ?? null,
		operationKey: `${input.executionId}-result`,
		outcome,
		operationLabel: input.instanceId ? "Agent (direct)" : "Direct chat",
		summary,
	});
}

async function runStep6DirectChatFailure(
	input: DirectChatFailureInput,
	postOperationResultActivity: PostOperationResultActivity,
): Promise<PostOperationResultOutput | "skipped"> {
	if (!input.conversationId) {
		return "skipped";
	}
	// Codex review fix #1 — see `DirectChatFailureInput.isTerminal` doc.
	// Mirrors the workflow's `isTerminal = !(error instanceof
	// ApplicationFailure) || error.nonRetryable === true` guard.
	const isTerminal = input.isTerminal ?? true;
	if (!isTerminal) {
		return "skipped";
	}
	return await postOperationResultActivity({
		conversationId: input.conversationId,
		userId: input.userId,
		organizationId: input.organizationId ?? null,
		operationKey: `${input.executionId}-result`,
		outcome: "failure",
		operationLabel: input.instanceId ? "Agent (direct)" : "Direct chat",
		summary: input.errorMessage,
	});
}

// =============================================================================
// Tests
// =============================================================================

const SUCCESS_RESPONSE: PostOperationResultOutput = {
	posted: true,
	messageId: "msg-123",
	deduplicated: false,
};

/**
 * `vi.fn()` already owns a getter-only `.mock` property; we can't decorate
 * it via `Object.assign`. The caller takes the bare `vi.fn` directly and
 * passes it through `asActivity()` at the call site for the typed cast,
 * then asserts against the same `vi.fn` reference. This avoids the
 * "Cannot set property mock" runtime trap entirely.
 */
function makeActivity(
	override?: PostOperationResultOutput,
): ReturnType<typeof vi.fn> {
	return vi.fn().mockResolvedValue(override ?? SUCCESS_RESPONSE);
}

function asActivity(fn: ReturnType<typeof vi.fn>): PostOperationResultActivity {
	return fn as unknown as PostOperationResultActivity;
}

describe("Step 6 — orchestratorCompletionWorkflow operation-result dispatch", () => {
	it("derives outcome 'success' when ALL taskPlanSteps are complete", async () => {
		const activity = makeActivity();
		await runStep6Orchestrator(
			{
				executionId: "exec-1",
				userId: "user-1",
				organizationId: "org-1",
				conversationId: "conv-1",
				finalResponse: "All done.",
				message: "User asked X",
				executionMode: "balanced",
				isIterativeMode: false,
				taskPlanSteps: [
					{ id: "s1", description: "do a", status: "complete" },
					{ id: "s2", description: "do b", status: "complete" },
				],
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledTimes(1);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "success" }),
		);
	});

	it("derives outcome 'partial' when SOME taskPlanSteps are complete and others are not", async () => {
		const activity = makeActivity();
		await runStep6Orchestrator(
			{
				executionId: "exec-2",
				userId: "user-1",
				organizationId: "org-1",
				conversationId: "conv-1",
				finalResponse: "Got partway.",
				message: "User asked X",
				executionMode: "balanced",
				isIterativeMode: false,
				taskPlanSteps: [
					{ id: "s1", description: "do a", status: "complete" },
					{ id: "s2", description: "do b", status: "error" },
				],
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "partial" }),
		);
	});

	it("derives outcome 'failure' when NO taskPlanSteps are complete", async () => {
		const activity = makeActivity();
		await runStep6Orchestrator(
			{
				executionId: "exec-3",
				userId: "user-1",
				organizationId: "org-1",
				conversationId: "conv-1",
				finalResponse: "Failed.",
				message: "User asked X",
				executionMode: "balanced",
				isIterativeMode: false,
				taskPlanSteps: [
					{ id: "s1", description: "do a", status: "error" },
					{ id: "s2", description: "do b", status: "skipped" },
				],
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "failure" }),
		);
	});

	it("skips entirely when conversationId is undefined (today's Nexus / CopilotPage path)", async () => {
		const activity = makeActivity();
		const result = await runStep6Orchestrator(
			{
				executionId: "exec-4",
				userId: "user-1",
				organizationId: "org-1",
				// conversationId omitted
				finalResponse: "Anything.",
				message: "User asked X",
				executionMode: "balanced",
				isIterativeMode: false,
				taskPlanSteps: [
					{ id: "s1", description: "do a", status: "complete" },
				],
			},
			asActivity(activity),
		);
		expect(result).toBe("skipped");
		expect(activity).not.toHaveBeenCalled();
	});

	it("passes operationKey = `${executionId}-result` so a retried workflow hits the same idempotency slot", async () => {
		const activity = makeActivity();
		await runStep6Orchestrator(
			{
				executionId: "exec-deadbeef",
				userId: "user-1",
				conversationId: "conv-1",
				finalResponse: "ok",
				message: "User asked X",
				executionMode: "balanced",
				isIterativeMode: false,
				taskPlanSteps: [
					{ id: "s1", description: "do a", status: "complete" },
				],
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({ operationKey: "exec-deadbeef-result" }),
		);
	});

	it("uses `Orchestrator (${executionMode})` label in iterative mode", async () => {
		const activity = makeActivity();
		await runStep6Orchestrator(
			{
				executionId: "exec-i",
				userId: "user-1",
				conversationId: "conv-1",
				finalResponse: "ok",
				message: "User asked X",
				executionMode: "balanced",
				isIterativeMode: true,
				taskPlanSteps: [
					{
						id: "iterative-1",
						description: "iter step",
						status: "complete",
					},
				],
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				operationLabel: "Orchestrator (balanced)",
			}),
		);
	});

	it("uses `Orchestrator (${executionMode})` label in save_reuse mode (non-iterative)", async () => {
		const activity = makeActivity();
		await runStep6Orchestrator(
			{
				executionId: "exec-s",
				userId: "user-1",
				conversationId: "conv-1",
				finalResponse: "ok",
				message: "User asked X",
				executionMode: "save_reuse",
				isIterativeMode: false,
				taskPlanSteps: [
					{ id: "s1", description: "do a", status: "complete" },
				],
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				operationLabel: "Orchestrator (save_reuse)",
			}),
		);
	});

	it("uses plain `Orchestrator` label for default non-iterative balanced runs", async () => {
		const activity = makeActivity();
		await runStep6Orchestrator(
			{
				executionId: "exec-d",
				userId: "user-1",
				conversationId: "conv-1",
				finalResponse: "ok",
				message: "User asked X",
				executionMode: "balanced",
				isIterativeMode: false,
				taskPlanSteps: [
					{ id: "s1", description: "do a", status: "complete" },
				],
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({ operationLabel: "Orchestrator" }),
		);
	});

	it("falls back to `message` as summary when `finalResponse` is empty", async () => {
		const activity = makeActivity();
		await runStep6Orchestrator(
			{
				executionId: "exec-empty",
				userId: "user-1",
				conversationId: "conv-1",
				finalResponse: "",
				message: "Original prompt",
				executionMode: "balanced",
				isIterativeMode: false,
				taskPlanSteps: [
					{ id: "s1", description: "do a", status: "complete" },
				],
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({ summary: "Original prompt" }),
		);
	});

	it("normalises absent organizationId to null (NOT undefined) for the personal-context contract", async () => {
		const activity = makeActivity();
		await runStep6Orchestrator(
			{
				executionId: "exec-personal",
				userId: "user-1",
				// organizationId omitted
				conversationId: "conv-personal",
				finalResponse: "ok",
				message: "User asked X",
				executionMode: "balanced",
				isIterativeMode: false,
				taskPlanSteps: [
					{ id: "s1", description: "do a", status: "complete" },
				],
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: null }),
		);
	});
});

describe("Step 6 — directChatWorkflow operation-result dispatch (success path)", () => {
	it("calls activity with outcome 'success' and responseText as summary", async () => {
		const activity = makeActivity();
		await runStep6DirectChatSuccess(
			{
				executionId: "dc-1",
				userId: "user-1",
				organizationId: "org-1",
				conversationId: "conv-1",
				message: "Hi",
				responseText: "Hello back!",
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "success",
				summary: "Hello back!",
				operationKey: "dc-1-result",
			}),
		);
	});

	it("uses `Agent (direct)` operationLabel when instanceId is set", async () => {
		const activity = makeActivity();
		await runStep6DirectChatSuccess(
			{
				executionId: "dc-2",
				userId: "user-1",
				instanceId: "agent-template-instance-xyz",
				conversationId: "conv-1",
				message: "Hi",
				responseText: "Hello",
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({ operationLabel: "Agent (direct)" }),
		);
	});

	it("uses `Direct chat` operationLabel when instanceId is absent", async () => {
		const activity = makeActivity();
		await runStep6DirectChatSuccess(
			{
				executionId: "dc-3",
				userId: "user-1",
				conversationId: "conv-1",
				message: "Hi",
				responseText: "Hello",
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({ operationLabel: "Direct chat" }),
		);
	});

	it("skips entirely when conversationId is undefined", async () => {
		const activity = makeActivity();
		const result = await runStep6DirectChatSuccess(
			{
				executionId: "dc-skip",
				userId: "user-1",
				message: "Hi",
				responseText: "Hello",
			},
			asActivity(activity),
		);
		expect(result).toBe("skipped");
		expect(activity).not.toHaveBeenCalled();
	});

	it("falls back to `message` summary when responseText is empty", async () => {
		const activity = makeActivity();
		await runStep6DirectChatSuccess(
			{
				executionId: "dc-empty",
				userId: "user-1",
				conversationId: "conv-1",
				message: "Original prompt",
				responseText: "",
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({ summary: "Original prompt" }),
		);
	});

	// Copilot review fix #1 — `executeDirectChatActivity` falsy-success.
	//
	// The activity catches its own errors and returns `{ success: false,
	// error }` WITHOUT throwing. The workflow's success branch is then
	// reached, but the persisted outcome MUST be "failure" with `error`
	// as summary — otherwise the chat thread row disagrees with what
	// the user saw (SSE route surfaced `result.error` as an error event).

	it("posts outcome 'failure' when result.success === false (activity returned falsy-success without throwing)", async () => {
		const activity = makeActivity();
		await runStep6DirectChatSuccess(
			{
				executionId: "dc-falsy",
				userId: "user-1",
				conversationId: "conv-1",
				message: "Hi",
				resultSuccess: false,
				responseText: "(partial AI prefix)",
				error: "Model returned 503 mid-stream",
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "failure",
				summary: "Model returned 503 mid-stream",
			}),
		);
	});

	it("falls back to 'Unknown error' summary when result.success=false and error is empty", async () => {
		const activity = makeActivity();
		await runStep6DirectChatSuccess(
			{
				executionId: "dc-falsy-no-error",
				userId: "user-1",
				conversationId: "conv-1",
				message: "Hi",
				resultSuccess: false,
				responseText: "",
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "failure",
				summary: "Unknown error",
			}),
		);
	});
});

describe("Step 6 — directChatWorkflow operation-result dispatch (failure path)", () => {
	it("calls activity with outcome 'failure' and errorMessage as summary", async () => {
		const activity = makeActivity();
		await runStep6DirectChatFailure(
			{
				executionId: "dc-f-1",
				userId: "user-1",
				organizationId: "org-1",
				conversationId: "conv-1",
				message: "Hi",
				errorMessage: "AI provider returned 503",
			},
			asActivity(activity),
		);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "failure",
				summary: "AI provider returned 503",
				operationKey: "dc-f-1-result",
			}),
		);
	});

	it("forwards a long error message verbatim (the formatter truncates at 2 000 chars in PR1, not the workflow)", async () => {
		const activity = makeActivity();
		const longError = "x".repeat(5_000);
		await runStep6DirectChatFailure(
			{
				executionId: "dc-f-long",
				userId: "user-1",
				conversationId: "conv-1",
				message: "Hi",
				errorMessage: longError,
			},
			asActivity(activity),
		);
		// Workflow MUST NOT pre-truncate — that's the formatter's
		// responsibility (PR1's pure `buildOperationResultMessage`).
		const calledWith = activity.mock.calls[0]?.[0];
		expect(calledWith?.summary.length).toBe(5_000);
	});

	it("skips entirely when conversationId is undefined", async () => {
		const activity = makeActivity();
		const result = await runStep6DirectChatFailure(
			{
				executionId: "dc-f-skip",
				userId: "user-1",
				message: "Hi",
				errorMessage: "boom",
			},
			asActivity(activity),
		);
		expect(result).toBe("skipped");
		expect(activity).not.toHaveBeenCalled();
	});

	// Codex review fix #1 — isTerminal guard tests.
	//
	// These pin the workflow contract: only POST a "failure" message
	// when we are CERTAIN the workflow will not retry. Otherwise a
	// later successful retry would be dedup-blocked by the stale row.

	it("posts when isTerminal=true (default — current direct-chat retry policy)", async () => {
		const activity = makeActivity();
		const result = await runStep6DirectChatFailure(
			{
				executionId: "dc-f-terminal",
				userId: "user-1",
				conversationId: "conv-1",
				message: "Hi",
				errorMessage: "AI 503",
				isTerminal: true,
			},
			asActivity(activity),
		);
		expect(result).not.toBe("skipped");
		expect(activity).toHaveBeenCalledTimes(1);
		expect(activity).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "failure" }),
		);
	});

	it("SKIPS when isTerminal=false (retryable ApplicationFailure — let a retry post the real outcome)", async () => {
		const activity = makeActivity();
		const result = await runStep6DirectChatFailure(
			{
				executionId: "dc-f-retryable",
				userId: "user-1",
				conversationId: "conv-1",
				message: "Hi",
				errorMessage: "transient AI 503",
				isTerminal: false,
			},
			asActivity(activity),
		);
		expect(result).toBe("skipped");
		// CRITICAL: activity must NOT be called — otherwise the
		// dedup'd "failure" row would persist past a later successful
		// retry that hits the same operationKey.
		expect(activity).not.toHaveBeenCalled();
	});
});

describe("Step 6 — idempotency contract via stable operationKey", () => {
	it("returns the same operationKey across simulated retries (same executionId)", async () => {
		const activity = makeActivity();
		// Plain object (no `as const`): we WANT structural compatibility
		// with `CompletionMirrorInput`'s mutable `taskPlanSteps: TaskPlanStep[]`.
		// `as const` would freeze it to a readonly tuple, which TS rejects
		// against a mutable-array parameter.
		const inputs: CompletionMirrorInput = {
			executionId: "retry-test",
			userId: "user-1",
			conversationId: "conv-1",
			finalResponse: "ok",
			message: "User asked X",
			executionMode: "balanced",
			isIterativeMode: false,
			taskPlanSteps: [
				{ id: "s1", description: "do a", status: "complete" },
			],
		};

		// Simulate two workflow attempts (e.g. Temporal retry).
		await runStep6Orchestrator(inputs, asActivity(activity));
		await runStep6Orchestrator(inputs, asActivity(activity));

		const calls = activity.mock.calls.map(
			(c) => c[0] as PostOperationResultInput,
		);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.operationKey).toBe(calls[1]?.operationKey);
		expect(calls[0]?.operationKey).toBe("retry-test-result");
	});

	it("each per-agent run on a multi-agent CopilotPage gets a DISTINCT operationKey (different executionId)", async () => {
		const activity = makeActivity();
		// All N agents share the same conversationId on the Nexus
		// multi-agent surface; only the executionId differs. The
		// resulting messages are N distinct rows, one per agent.
		const sharedConversationId = "conv-multi";
		await runStep6Orchestrator(
			{
				executionId: "agent-A",
				userId: "user-1",
				conversationId: sharedConversationId,
				finalResponse: "A says hi",
				message: "User asked X",
				executionMode: "balanced",
				isIterativeMode: false,
				taskPlanSteps: [
					{ id: "s1", description: "do a", status: "complete" },
				],
			},
			asActivity(activity),
		);
		await runStep6Orchestrator(
			{
				executionId: "agent-B",
				userId: "user-1",
				conversationId: sharedConversationId,
				finalResponse: "B says hi",
				message: "User asked X",
				executionMode: "balanced",
				isIterativeMode: false,
				taskPlanSteps: [
					{ id: "s1", description: "do a", status: "complete" },
				],
			},
			asActivity(activity),
		);

		const calls = activity.mock.calls.map(
			(c) => c[0] as PostOperationResultInput,
		);
		expect(calls[0]?.operationKey).toBe("agent-A-result");
		expect(calls[1]?.operationKey).toBe("agent-B-result");
		expect(calls[0]?.operationKey).not.toBe(calls[1]?.operationKey);
	});
});
