/**
 * `useOrchestratorStream.attach`: a turn already running when the
 * conversation was opened (a reload mid-turn) becomes the live turn.
 *
 *  - Nothing new is sent: every request, the first included, is a reconnect
 *    by the turn's executionId, with no message and no clientRequestKey.
 *  - The question shows at once, and the turn's progress, a pending approval
 *    and its answer stream in.
 *  - Approve, Stop and follow-ups act on the attached turn by its id.
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

import { useOrchestratorStream } from "../useOrchestratorStream";

const BASE = "/api/agents/fabric-ai/orchestrator-temporal";
const STREAM_URL = `${BASE}/stream`;
const EXECUTION_ID = "orch-aaaaaaaa-0000-4000-8000-0000000000a1";
const QUESTION = "Publish the weekly status page";

function makeSseResponse() {
	const encoder = new TextEncoder();
	const queue: Array<{ value?: Uint8Array; done?: boolean }> = [];
	let resolveNext: (() => void) | null = null;
	const read = () =>
		new Promise<{ value?: Uint8Array; done?: boolean }>((resolve) => {
			const drain = () => {
				const next = queue.shift();
				if (next) {
					resolve({ value: next.value, done: next.done ?? false });
					return true;
				}
				return false;
			};
			if (drain()) {
				return;
			}
			resolveNext = () => {
				drain();
			};
		});
	const push = (entry: { value?: Uint8Array; done?: boolean }) => {
		queue.push(entry);
		const r = resolveNext;
		resolveNext = null;
		r?.();
	};
	return {
		response: {
			ok: true,
			status: 200,
			body: { getReader: () => ({ read }) },
			json: async () => ({}),
		},
		send: (event: Record<string, unknown>) =>
			push({ value: encoder.encode(`data: ${JSON.stringify(event)}\n`) }),
		end: () => push({ done: true }),
	};
}

interface Call {
	url: string;
	body: Record<string, unknown>;
}

function installFetch(streamResponses: unknown[]): { calls: Call[] } {
	const calls: Call[] = [];
	let next = 0;
	global.fetch = vi.fn((input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as Request).url;
		calls.push({
			url,
			body: init?.body ? JSON.parse(String(init.body)) : {},
		});
		if (url !== STREAM_URL) {
			return Promise.resolve({
				ok: true,
				status: 200,
				json: async () => ({ success: true }),
			} as Response);
		}
		const scripted = streamResponses[next++];
		if (scripted === undefined) {
			return Promise.reject(new Error("unexpected stream POST"));
		}
		return Promise.resolve(scripted as Response);
	}) as unknown as typeof fetch;
	return { calls };
}

const originalFetch = global.fetch;
afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

const HOOK_OPTIONS = {
	organizationId: "org-example-1",
	conversationId: "conversation-example-1",
};

function renderAttached(streamResponses: unknown[]) {
	const { calls } = installFetch(streamResponses);
	const hook = renderHook(() => useOrchestratorStream(HOOK_OPTIONS));
	let attaching: Promise<string | null> | undefined;
	act(() => {
		attaching = hook.result.current.attach(EXECUTION_ID, QUESTION);
	});
	return {
		...hook,
		calls,
		streamCalls: () => calls.filter((call) => call.url === STREAM_URL),
		attaching: () => attaching,
	};
}

describe("useOrchestratorStream — attaching to a running turn", () => {
	it("reconnects by executionId without sending the question again, and shows the question at once", async () => {
		const window = makeSseResponse();
		const { result, streamCalls, attaching } = renderAttached([
			window.response,
		]);

		expect(result.current.state.executionId).toBe(EXECUTION_ID);
		expect(result.current.state.status).toBe("running");
		expect(result.current.isLoading).toBe(true);
		expect(result.current.messages.map((m) => [m.role, m.content])).toEqual(
			[
				["user", QUESTION],
				["assistant", ""],
			],
		);
		await waitFor(() => {
			expect(streamCalls()).toHaveLength(1);
		});
		expect(streamCalls()[0].body).toEqual({
			eventReplay: true,
			executionId: EXECUTION_ID,
			organizationId: HOOK_OPTIONS.organizationId,
			conversationId: HOOK_OPTIONS.conversationId,
			surface: "loom-orchestrator",
			clientRequestKey: null,
		});

		await act(async () => {
			window.end();
			await attaching();
		});
	});

	it("shows the pending approval the reconnect re-sends, and approving it continues the same turn to its answer", async () => {
		const window = makeSseResponse();
		const { result, calls, attaching } = renderAttached([window.response]);

		await act(async () => {
			window.send({
				type: "started",
				executionId: EXECUTION_ID,
				resumed: true,
			});
			window.send({
				type: "approval_required",
				approvalId: "approval-1",
				stepId: "step-1",
				reason: "MEDIUM RISK: Publish the page",
			});
		});
		await waitFor(() => {
			expect(result.current.isAwaitingApproval).toBe(true);
		});
		expect(result.current.state.pendingApproval).toMatchObject({
			approvalId: "approval-1",
			reason: "MEDIUM RISK: Publish the page",
		});

		let approved: string | undefined;
		await act(async () => {
			approved = await result.current.sendApproval(true);
		});
		expect(approved).toBe("sent");
		expect(
			calls.find((call) => call.url === `${BASE}/approve`)?.body,
		).toMatchObject({ executionId: EXECUTION_ID, approved: true });
		expect(result.current.state.pendingApproval).toBeNull();
		expect(result.current.state.status).toBe("running");

		await act(async () => {
			window.send({ type: "approval_resolved" });
			window.send({
				type: "completed",
				status: "completed",
				response: "The page is published.",
			});
			window.end();
			expect(await attaching()).toBe(EXECUTION_ID);
		});
		expect(result.current.state.status).toBe("completed");
		expect(result.current.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: "The page is published.",
			isStreaming: false,
		});
	});

	it("streams the running turn's answer in, reconnecting by its id again when the window closes", async () => {
		const first = makeSseResponse();
		const second = makeSseResponse();
		const { result, streamCalls, attaching } = renderAttached([
			first.response,
			second.response,
		]);

		await act(async () => {
			first.send({
				type: "started",
				executionId: EXECUTION_ID,
				resumed: true,
			});
			first.send({ type: "text_delta", content: "Drafting the page" });
		});
		await waitFor(() => {
			expect(result.current.messages.at(-1)?.content).toBe(
				"Drafting the page",
			);
		});
		await act(async () => {
			first.send({ type: "stream_timeout", executionId: EXECUTION_ID });
			first.end();
		});
		await waitFor(() => {
			expect(streamCalls()).toHaveLength(2);
		});
		expect(streamCalls()[1].body).toMatchObject({
			executionId: EXECUTION_ID,
		});
		expect(streamCalls()[1].body).not.toHaveProperty("message");

		await act(async () => {
			second.send({
				type: "started",
				executionId: EXECUTION_ID,
				resumed: true,
			});
			second.send({
				type: "completed",
				status: "completed",
				response: "Here is the weekly status page.",
			});
			second.end();
			await attaching();
		});
		expect(result.current.state.status).toBe("completed");
		expect(result.current.messages.map((m) => [m.role, m.content])).toEqual(
			[
				["user", QUESTION],
				["assistant", "Here is the weekly status page."],
			],
		);
	});

	it("stops the attached turn by its executionId", async () => {
		const window = makeSseResponse();
		const { result, calls, attaching } = renderAttached([window.response]);
		await waitFor(() => {
			expect(calls.some((call) => call.url === STREAM_URL)).toBe(true);
		});

		act(() => {
			result.current.stop("button");
		});

		await waitFor(() => {
			expect(calls.some((call) => call.url === `${BASE}/cancel`)).toBe(
				true,
			);
		});
		const cancel = calls.find((call) => call.url === `${BASE}/cancel`);
		expect(cancel?.body).toEqual({
			executionId: EXECUTION_ID,
			conversationId: HOOK_OPTIONS.conversationId,
			organizationId: HOOK_OPTIONS.organizationId,
		});
		expect(result.current.state.status).toBe("cancelled");

		await act(async () => {
			window.end();
			await attaching();
		});
	});

	it("sends a follow-up to the attached turn", async () => {
		const window = makeSseResponse();
		const { result, calls, attaching } = renderAttached([window.response]);
		expect(result.current.isFollowUpEnabled).toBe(true);

		let sent: boolean | undefined;
		await act(async () => {
			sent = await result.current.sendFollowUp("Add last week's numbers");
		});
		expect(sent).toBe(true);
		expect(
			calls.find((call) => call.url === `${BASE}/follow-up`)?.body,
		).toMatchObject({
			executionId: EXECUTION_ID,
			message: "Add last week's numbers",
		});

		await act(async () => {
			window.send({
				type: "completed",
				status: "completed",
				response: "Done.",
			});
			window.end();
			await attaching();
		});
	});
});
