/**
 * Tests for the codingRunWorkflow's try/finally cleanup contract.
 *
 * Same approach as orchestrator-cleanup.test.ts — the production
 * workflow is too elaborate for a direct unit test, so we mirror the
 * try/finally body shape and verify the contract:
 *  - cleanup is called exactly once per workflow exit
 *  - `exitReason` correctly reflects success / failure / cancel /
 *    timeout / exception paths
 *  - the duplicate `cancelExecutionSession` call from `handleCancellation`
 *    is harmless because the cleanup activity is idempotent (covered by
 *    `cleanup-resources.test.ts`)
 *
 * Production workflow: `packages/temporal/src/workflows/coding-run-workflow.ts`.
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
	codingRunId: string;
	provider: "BACKGROUND_AGENTS" | "KANBAN_LOCAL";
}

async function runCodingRunMirror(input: {
	body: () => Promise<{ exitReason: ExitReason }>;
	sessionId: string | null;
	codingRunId: string;
	provider: "BACKGROUND_AGENTS" | "KANBAN_LOCAL";
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
		await input.cleanupSpy({
			sessionId: input.sessionId,
			exitReason,
			codingRunId: input.codingRunId,
			provider: input.provider,
		});
	}
	return { caught };
}

describe("codingRunWorkflow cleanup contract", () => {
	it("calls cleanup with exitReason='success' for a completed PR-opened run", async () => {
		const cleanup = vi.fn().mockResolvedValue(undefined);

		await runCodingRunMirror({
			body: async () => ({ exitReason: "success" }),
			sessionId: "sess-1",
			codingRunId: "run-1",
			provider: "BACKGROUND_AGENTS",
			cleanupSpy: cleanup,
		});

		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(cleanup).toHaveBeenCalledWith({
			sessionId: "sess-1",
			exitReason: "success",
			codingRunId: "run-1",
			provider: "BACKGROUND_AGENTS",
		});
	});

	it("calls cleanup with exitReason='failure' for a provider-reported failure", async () => {
		const cleanup = vi.fn().mockResolvedValue(undefined);

		await runCodingRunMirror({
			body: async () => ({ exitReason: "failure" }),
			sessionId: "sess-fail",
			codingRunId: "run-fail",
			provider: "BACKGROUND_AGENTS",
			cleanupSpy: cleanup,
		});

		expect(cleanup.mock.calls[0][0]).toMatchObject({
			exitReason: "failure",
		});
	});

	it("calls cleanup with exitReason='cancelled' on the explicit cancel signal path", async () => {
		const cleanup = vi.fn().mockResolvedValue(undefined);

		await runCodingRunMirror({
			body: async () => ({ exitReason: "cancelled" }),
			sessionId: "sess-c",
			codingRunId: "run-c",
			provider: "KANBAN_LOCAL",
			cleanupSpy: cleanup,
		});

		expect(cleanup.mock.calls[0][0]).toMatchObject({
			exitReason: "cancelled",
			provider: "KANBAN_LOCAL",
		});
	});

	it("calls cleanup with exitReason='timeout' when poll exhausts MAX_POLL_ITERATIONS", async () => {
		const cleanup = vi.fn().mockResolvedValue(undefined);

		await runCodingRunMirror({
			body: async () => ({ exitReason: "timeout" }),
			sessionId: "sess-t",
			codingRunId: "run-t",
			provider: "BACKGROUND_AGENTS",
			cleanupSpy: cleanup,
		});

		expect(cleanup.mock.calls[0][0]).toMatchObject({
			exitReason: "timeout",
		});
	});

	it("calls cleanup with exitReason='exception' on uncaught throw (default value)", async () => {
		const cleanup = vi.fn().mockResolvedValue(undefined);

		const { caught } = await runCodingRunMirror({
			body: async () => {
				throw new Error("activity blew up");
			},
			sessionId: "sess-x",
			codingRunId: "run-x",
			provider: "BACKGROUND_AGENTS",
			cleanupSpy: cleanup,
		});

		expect((caught as Error).message).toBe("activity blew up");
		expect(cleanup.mock.calls[0][0]).toMatchObject({
			exitReason: "exception",
			sessionId: "sess-x",
		});
	});

	it("calls cleanup even when sessionId never got assigned (no-op path)", async () => {
		const cleanup = vi.fn().mockResolvedValue(undefined);

		await runCodingRunMirror({
			body: async () => ({ exitReason: "failure" }),
			sessionId: null,
			codingRunId: "run-no-sess",
			provider: "BACKGROUND_AGENTS",
			cleanupSpy: cleanup,
		});

		expect(cleanup.mock.calls[0][0]).toMatchObject({
			sessionId: null,
			exitReason: "failure",
		});
	});
});
