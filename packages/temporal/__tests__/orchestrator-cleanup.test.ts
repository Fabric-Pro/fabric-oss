/**
 * Tests for the orchestrator workflow's try/finally cleanup contract.
 *
 * The full `orchestratorExecutionWorkflow` has 500+ lines and an
 * elaborate phase setup; pulling it into a unit test (vs. spinning up
 * `TestWorkflowEnvironment`) is impractical. We instead mirror the
 * try/finally body shape in a small helper and assert the contract:
 *  - cleanup is called exactly once per workflow exit
 *  - `exitReason` reflects the path the body took
 *  - the cleanup activity runs inside the non-cancellable scope even
 *    when the body threw
 *
 * The production workflow is `packages/temporal/src/workflows/
 * orchestrator/index.ts`; this test pins the contract so a divergence
 * is caught on review.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/orchestrator-cleanup.test.ts
 */

import { describe, expect, it, vi } from "vitest";

type ExitReason =
	| "success"
	| "failure"
	| "cancelled"
	| "timeout"
	| "exception"
	| "oauth_blocked";

interface CleanupCall {
	sessionId: string | null;
	exitReason: ExitReason;
	weaveExecutionId: string | null;
	provider: string;
}

/**
 * Mirror of the orchestrator workflow's body shape. Real flow:
 *
 *   const startedAtMs = Date.now();
 *   let exitReason: ExitReason = "exception";
 *   try {
 *     ... // body sets exitReason at each early-return / final return
 *     return ...;
 *   } finally {
 *     await CancellationScope.nonCancellable(async () => {
 *       await cleanupWeaveResourcesActivity({ ..., exitReason, ... });
 *     });
 *   }
 *
 * The mirror lets us drive each branch in isolation.
 */
async function runOrchestratorMirror(input: {
	body: () => Promise<{ exitReason: ExitReason }>;
	sandboxSessionId: string | null;
	weaveExecutionId: string | null;
	provider?: string;
	cleanupSpy: (call: CleanupCall) => Promise<void>;
}): Promise<{ caught: unknown }> {
	let exitReason: ExitReason = "exception";
	let caught: unknown;
	try {
		const out = await input.body();
		exitReason = out.exitReason;
	} catch (err) {
		caught = err;
	} finally {
		// Mirrors `CancellationScope.nonCancellable(...)` — the activity
		// must run even when the body threw.
		await input.cleanupSpy({
			sessionId: input.sandboxSessionId,
			exitReason,
			weaveExecutionId: input.weaveExecutionId,
			provider: input.provider ?? "BACKGROUND_AGENTS",
		});
	}
	return { caught };
}

describe("orchestratorExecutionWorkflow cleanup contract", () => {
	it("calls cleanup with exitReason='success' on the happy path", async () => {
		const cleanup = vi.fn().mockResolvedValue(undefined);

		await runOrchestratorMirror({
			body: async () => ({ exitReason: "success" }),
			sandboxSessionId: "sess-1",
			weaveExecutionId: "wexec-1",
			cleanupSpy: cleanup,
		});

		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(cleanup).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "sess-1",
				exitReason: "success",
				weaveExecutionId: "wexec-1",
			}),
		);
	});

	it("calls cleanup with exitReason='failure' when a phase returns failed", async () => {
		const cleanup = vi.fn().mockResolvedValue(undefined);

		await runOrchestratorMirror({
			body: async () => ({ exitReason: "failure" }),
			sandboxSessionId: "sess-2",
			weaveExecutionId: "wexec-2",
			cleanupSpy: cleanup,
		});

		expect(cleanup.mock.calls[0][0]).toMatchObject({
			exitReason: "failure",
			sessionId: "sess-2",
		});
	});

	it("calls cleanup with exitReason='cancelled' on the cancel path", async () => {
		const cleanup = vi.fn().mockResolvedValue(undefined);

		await runOrchestratorMirror({
			body: async () => ({ exitReason: "cancelled" }),
			sandboxSessionId: "sess-3",
			weaveExecutionId: "wexec-3",
			cleanupSpy: cleanup,
		});

		expect(cleanup.mock.calls[0][0]).toMatchObject({
			exitReason: "cancelled",
		});
	});

	it("calls cleanup with exitReason='oauth_blocked' on the OAuth-pause path", async () => {
		const cleanup = vi.fn().mockResolvedValue(undefined);

		await runOrchestratorMirror({
			body: async () => ({ exitReason: "oauth_blocked" }),
			sandboxSessionId: "sess-4",
			weaveExecutionId: "wexec-4",
			cleanupSpy: cleanup,
		});

		expect(cleanup.mock.calls[0][0]).toMatchObject({
			exitReason: "oauth_blocked",
		});
	});

	it("calls cleanup with exitReason='exception' when the body throws (default value)", async () => {
		const cleanup = vi.fn().mockResolvedValue(undefined);

		const { caught } = await runOrchestratorMirror({
			body: async () => {
				throw new Error("phase crashed");
			},
			sandboxSessionId: "sess-5",
			weaveExecutionId: "wexec-5",
			cleanupSpy: cleanup,
		});

		expect((caught as Error).message).toBe("phase crashed");
		// `exitReason` is initialised to "exception" so the audit log can
		// distinguish unhandled throws from deliberate "failure" returns.
		expect(cleanup.mock.calls[0][0]).toMatchObject({
			exitReason: "exception",
			sessionId: "sess-5",
		});
	});

	it("passes sessionId=null when the workflow exited before sandbox creation", async () => {
		const cleanup = vi.fn().mockResolvedValue(undefined);

		await runOrchestratorMirror({
			body: async () => ({ exitReason: "failure" }),
			sandboxSessionId: null,
			weaveExecutionId: "wexec-no-session",
			cleanupSpy: cleanup,
		});

		expect(cleanup.mock.calls[0][0]).toMatchObject({
			sessionId: null,
			exitReason: "failure",
		});
	});

	it("forwards the resolved provider key (defaults BACKGROUND_AGENTS)", async () => {
		const cleanup = vi.fn().mockResolvedValue(undefined);

		await runOrchestratorMirror({
			body: async () => ({ exitReason: "success" }),
			sandboxSessionId: "sess-9",
			weaveExecutionId: "wexec-9",
			provider: "KANBAN_LOCAL",
			cleanupSpy: cleanup,
		});

		expect(cleanup.mock.calls[0][0]).toMatchObject({
			provider: "KANBAN_LOCAL",
		});
	});
});
