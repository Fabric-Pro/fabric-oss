/**
 * A run can ask for approval more than once: approving a created workflow
 * lets it continue, and a later call in the same run (another one-shot grant)
 * asks again. Every request the server raises must reach the person as a card
 * the chat can render (`awaiting_approval` with its `pendingApproval`), however
 * the approval of the previous one and the next request interleave.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/cancel-telemetry", () => ({
	emitCancelEvent: vi.fn(),
}));
vi.mock("../useOrchestratorPartyKit", () => ({
	useOrchestratorPartyKit: () => ({
		isConnected: false,
		toolCalls: [],
		stepProgress: undefined,
		currentPhase: "idle",
		reset: vi.fn(),
		notifyStepStart: vi.fn(),
	}),
}));

import type { ApprovalSendResult } from "../../lib/approval-response";
import { useOrchestratorStream } from "../useOrchestratorStream";

const STREAM_URL = "/api/agents/fabric-ai/orchestrator-temporal/stream";
const APPROVE_URL = "/api/agents/fabric-ai/orchestrator-temporal/approve";

const CREATE = {
	approvalId: "authority-sess-create-call-1",
	stepId: "authority-call-1",
	reason: 'HIGH RISK: Allow "fabric_create_workflow" to run once in Fabric?',
};
const RUN = {
	approvalId: "authority-sess-run-call-3",
	stepId: "authority-call-3",
	reason: 'HIGH RISK: Allow "fabric_execute_workflow" to run once in Fabric?',
};

type Chunk = { value?: Uint8Array; done?: boolean };

/** One stream window: what the server writes, read as the hook reads it. */
function streamWindow() {
	const queue: Chunk[] = [];
	let wake: (() => void) | null = null;
	const read = () =>
		new Promise<Chunk>((resolve) => {
			const drain = () => {
				const next = queue.shift();
				if (next) {
					resolve({ value: next.value, done: next.done ?? false });
				}
				return Boolean(next);
			};
			if (!drain()) {
				wake = () => {
					drain();
				};
			}
		});
	const push = (chunk: Chunk) => {
		queue.push(chunk);
		const w = wake;
		wake = null;
		w?.();
	};
	const response = {
		ok: true,
		headers: new Headers(),
		body: { getReader: () => ({ read, cancel: async () => undefined }) },
		json: async () => ({}),
	} as unknown as Response;
	return { push, response };
}

/**
 * Every stream POST opens its own window; events go to the latest one. The
 * approve POST answers only when the test says so.
 */
function scriptedRun() {
	const encoder = new TextEncoder();
	const windows: Array<ReturnType<typeof streamWindow>> = [];
	const streamBodies: string[] = [];
	const approvals: Array<Record<string, unknown>> = [];
	const push = (chunk: Chunk) => windows.at(-1)?.push(chunk);

	let answerApproval: ((status: number) => void) | null = null;
	global.fetch = vi.fn((input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as Request).url;
		if (url === STREAM_URL) {
			const window = streamWindow();
			windows.push(window);
			streamBodies.push(String(init?.body ?? ""));
			return Promise.resolve(window.response);
		}
		if (url === APPROVE_URL) {
			approvals.push(JSON.parse(String(init?.body ?? "{}")));
			return new Promise<Response>((resolve) => {
				answerApproval = (status) =>
					resolve({
						ok: status >= 200 && status < 300,
						status,
						json: async () =>
							status === 409
								? {
										error: "This approval is no longer pending.",
										code: "APPROVAL_NOT_PENDING",
									}
								: { success: true },
					} as Response);
			});
		}
		return Promise.resolve({
			ok: true,
			json: async () => ({ success: true }),
		} as Response);
	}) as unknown as typeof fetch;

	return {
		streamBodies,
		approvals,
		send: (event: Record<string, unknown>) =>
			act(async () => {
				push({
					value: encoder.encode(`data: ${JSON.stringify(event)}\n`),
				});
			}),
		end: () =>
			act(async () => {
				push({
					value: encoder.encode(
						`data: ${JSON.stringify({ type: "completed", status: "completed", response: "" })}\n`,
					),
				});
				push({ done: true });
			}),
		answerApproval: (status = 200) =>
			act(async () => {
				answerApproval?.(status);
			}),
	};
}

/** What the server's poll sends when the workflow raises a request. */
function raised(approval: typeof CREATE) {
	return [
		{ type: "approval_required", ...approval },
		{
			type: "progress",
			completedSteps: 0,
			totalSteps: 0,
			phase: "awaiting_approval",
			message: "Approval needed: WRITE access to Fabric",
		},
	];
}

describe("a second approval in the same run", () => {
	const originalFetch = global.fetch;
	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	async function untilFirstApproval() {
		const run = scriptedRun();
		const hook = renderHook(() => useOrchestratorStream());
		let sending: Promise<string | null> | undefined;
		act(() => {
			sending = hook.result.current.sendMessage(
				"Every Monday make me a status page",
			);
		});
		await run.send({ type: "started", executionId: "orch-1" });
		for (const event of raised(CREATE)) {
			await run.send(event);
		}
		await waitFor(() =>
			expect(hook.result.current.state.pendingApproval).toEqual(CREATE),
		);
		return { run, hook, sending };
	}

	it("shows the second request after the first approval has been answered", async () => {
		const { run, hook, sending } = await untilFirstApproval();

		let approving: Promise<ApprovalSendResult> | undefined;
		act(() => {
			approving = hook.result.current.sendApproval(true);
		});
		await run.answerApproval();
		await act(async () => {
			await approving;
		});
		expect(run.approvals).toEqual([
			{
				executionId: "orch-1",
				approved: true,
				approvalId: CREATE.approvalId,
			},
		]);
		expect(hook.result.current.progressMessage).toBe("");
		await run.send({ type: "approval_resolved", ...CREATE });
		await run.send({
			type: "progress",
			phase: "executing_tool",
			message: "Calling fabric_create_workflow...",
		});
		for (const event of raised(RUN)) {
			await run.send(event);
		}

		expect(hook.result.current.state.status).toBe("awaiting_approval");
		expect(hook.result.current.state.pendingApproval).toEqual(RUN);

		await run.end();
		await act(async () => {
			await sending;
		});
	});

	it("keeps the second request when the first approval's answer comes back after it", async () => {
		const { run, hook, sending } = await untilFirstApproval();

		let approving: Promise<ApprovalSendResult> | undefined;
		act(() => {
			approving = hook.result.current.sendApproval(true);
		});
		await run.send({ type: "approval_resolved", ...CREATE });
		for (const event of raised(RUN)) {
			await run.send(event);
		}
		await run.answerApproval();
		await act(async () => {
			await approving;
		});

		expect(hook.result.current.state.status).toBe("awaiting_approval");
		expect(hook.result.current.state.pendingApproval).toEqual(RUN);

		await run.end();
		await act(async () => {
			await sending;
		});
	});
});

describe("an answer the run no longer waits for", () => {
	const originalFetch = global.fetch;
	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	async function untilApproval() {
		const run = scriptedRun();
		const hook = renderHook(() => useOrchestratorStream());
		let sending: Promise<string | null> | undefined;
		act(() => {
			sending = hook.result.current.sendMessage(
				"Every Monday make me a status page",
			);
		});
		await run.send({ type: "started", executionId: "orch-1" });
		for (const event of raised(CREATE)) {
			await run.send(event);
		}
		await waitFor(() =>
			expect(hook.result.current.state.pendingApproval).toEqual(CREATE),
		);
		return { run, hook, sending };
	}

	it("reports the card as stale on 409 and clears it", async () => {
		const { run, hook, sending } = await untilApproval();

		let approving: Promise<ApprovalSendResult> | undefined;
		act(() => {
			approving = hook.result.current.sendApproval(true);
		});
		await run.answerApproval(409);
		let result: ApprovalSendResult | undefined;
		await act(async () => {
			result = await approving;
		});

		expect(result).toBe("stale");
		expect(hook.result.current.state.pendingApproval).toBeNull();
		expect(hook.result.current.progressMessage).toBe("");

		await run.end();
		await act(async () => {
			await sending;
		});
	});

	it("keeps a newer request when the stale answer comes back after it", async () => {
		const { run, hook, sending } = await untilApproval();

		let approving: Promise<ApprovalSendResult> | undefined;
		act(() => {
			approving = hook.result.current.sendApproval(true);
		});
		for (const event of raised(RUN)) {
			await run.send(event);
		}
		await run.answerApproval(409);
		let result: ApprovalSendResult | undefined;
		await act(async () => {
			result = await approving;
		});

		expect(result).toBe("stale");
		expect(hook.result.current.state.status).toBe("awaiting_approval");
		expect(hook.result.current.state.pendingApproval).toEqual(RUN);

		await run.end();
		await act(async () => {
			await sending;
		});
	});

	it("still reports other refusals as failures and keeps the card", async () => {
		const { run, hook, sending } = await untilApproval();
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		let approving: Promise<ApprovalSendResult> | undefined;
		act(() => {
			approving = hook.result.current.sendApproval(true);
		});
		await run.answerApproval(500);
		let result: ApprovalSendResult | undefined;
		await act(async () => {
			result = await approving;
		});

		expect(result).toBe("failed");
		expect(hook.result.current.state.pendingApproval).toEqual(CREATE);

		await run.end();
		await act(async () => {
			await sending;
		});
	});
});

describe("a stream that goes silent while the run waits", () => {
	const originalFetch = global.fetch;
	afterEach(() => {
		vi.useRealTimers();
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	/** No byte, not even the server's 15 s ping, for three heartbeats. */
	const silentFor = (ms: number) =>
		act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});

	async function approvedThenSilent() {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const run = scriptedRun();
		const hook = renderHook(() => useOrchestratorStream());
		let sending: Promise<string | null> | undefined;
		act(() => {
			sending = hook.result.current.sendMessage(
				"Every Monday make me a status page",
			);
		});
		await run.send({ type: "started", executionId: "orch-1" });
		for (const event of raised(CREATE)) {
			await run.send(event);
		}
		expect(hook.result.current.state.pendingApproval).toEqual(CREATE);

		let approving: Promise<ApprovalSendResult> | undefined;
		act(() => {
			approving = hook.result.current.sendApproval(true);
		});
		await run.answerApproval();
		await act(async () => {
			await approving;
		});
		expect(hook.result.current.state.status).toBe("running");
		return { run, hook, sending };
	}

	it("reconnects, and the request the new window carries is shown", async () => {
		const { run, hook, sending } = await approvedThenSilent();

		await silentFor(45_000 + 2_000);

		expect(run.streamBodies).toHaveLength(2);
		expect(run.streamBodies[1]).toContain('"executionId":"orch-1"');
		await run.send({ type: "started", executionId: "orch-1" });
		for (const event of raised(RUN)) {
			await run.send(event);
		}
		expect(hook.result.current.state.status).toBe("awaiting_approval");
		expect(hook.result.current.state.pendingApproval).toEqual(RUN);

		await run.end();
		await act(async () => {
			await sending;
		});
	});

	it("fails the turn visibly when no reconnect brings the stream back", async () => {
		const { run, hook, sending } = await approvedThenSilent();

		for (let attempt = 0; attempt < 4; attempt++) {
			await silentFor(45_000 + 2_000);
		}
		await act(async () => {
			await sending;
		});

		expect(run.streamBodies).toHaveLength(4);
		expect(hook.result.current.state.status).toBe("failed");
		expect(hook.result.current.state.result?.error).toMatch(
			/could not be resumed/,
		);
	});
});
