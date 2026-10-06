/**
 * Agent delegation inside an Advisor chat turn.
 *
 * Delegation launches another agent's model work over A2A after several
 * slow awaits — endpoint lookup, a network health check, model
 * configuration and AI-token issuance. A Stop recorded during any of them
 * must stop the delegation at the outbound send, not before the preflight
 * only; a cancelled activity aborts the send and the polling; and a stop is
 * rethrown, not turned into an ordinary "delegation failed" result. Aborting
 * stops our requests only: the remote agent is not asked to stop.
 */

import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	checkDispatchable: vi.fn(),
	/** Every outbound request, as "METHOD path". */
	requests: [] as string[],
	onAgentCard: { value: () => {} },
	onSend: {
		value: undefined as
			| ((init: RequestInit | undefined) => Promise<Response>)
			| undefined,
	},
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	checkConversationTurnDispatchable: h.checkDispatchable,
}));
// The real A2A clients, so the send, its retries and its signal are
// exercised down to `fetch`.
vi.mock("@repo/agent-core", async () => {
	const a2a = await import("@repo/agent-core/a2a");
	return { A2AClient: a2a.A2AClient, SecureA2AClient: a2a.SecureA2AClient };
});
vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: {},
	GATEWAY_PROVIDERS: [],
	getAIModelWithMetadata: vi.fn(async () => ({
		metadata: { provider: "ANTHROPIC_DIRECT", modelId: "example-model" },
		trackUsage: vi.fn(),
	})),
}));
vi.mock("@repo/ai-token", () => ({
	issueAIToken: vi.fn(async () => "token-example"),
}));
vi.mock("../resolve-endpoint", () => ({
	resolveAgentEndpoint: vi.fn(async () => ({
		agentId: "agent-1",
		name: "Example agent",
		deploymentUrl: "https://agent.example.com",
		protocol: "a2a",
		isExternal: true,
	})),
}));
vi.mock("../../utils/partykit-publisher", () => ({
	publishToolStart: vi.fn(async () => undefined),
	publishToolComplete: vi.fn(async () => undefined),
}));

import { executeAgentAsTool } from "../../execution/execute-agent-as-tool";

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-00000000-0000-4000-8000-000000000001",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

let cancelled = false;

const originalFetch = global.fetch;

function json(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

beforeEach(() => {
	cancelled = false;
	h.requests.length = 0;
	h.onAgentCard.value = () => {};
	h.onSend.value = undefined;
	h.checkDispatchable.mockReset();
	h.checkDispatchable.mockImplementation(async () =>
		cancelled ? { ok: false, reason: "cancelled" } : { ok: true },
	);
	global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		h.requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
		if (url.pathname === "/.well-known/agent-card.json") {
			h.onAgentCard.value();
			return json({
				name: "Example agent",
				url: "https://agent.example.com",
				protocolVersion: "0.3.0",
			});
		}
		if (url.pathname === "/a2a/send") {
			if (h.onSend.value) {
				return h.onSend.value(init);
			}
			return json({ id: "task-1", status: "completed", messages: [] });
		}
		if (url.pathname === "/a2a/tasks/task-1") {
			return json({ id: "task-1", status: "working", messages: [] });
		}
		throw new Error(`unexpected request ${url.pathname}`);
	}) as unknown as typeof fetch;
});

afterEach(() => {
	global.fetch = originalFetch;
});

const sends = () => h.requests.filter((r) => r === "POST /a2a/send");

function delegate(withTurn: boolean) {
	return new MockActivityEnvironment()
		.run(executeAgentAsTool, {
			agentId: "agent-1",
			input: { message: "research the launch" },
			userId: TURN_SCOPE.userId,
			organizationId: TURN_SCOPE.organizationId,
			...(withTurn ? { turnScope: TURN_SCOPE } : {}),
		})
		.then(
			(value) => ({ resolvedWith: value }),
			(err: unknown) => err,
		);
}

describe("delegation in a chat turn", () => {
	it("a Stop recorded during the preflight health check stops the delegation before the A2A send", async () => {
		h.onAgentCard.value = () => {
			cancelled = true;
		};
		const outcome = await delegate(true);
		expect(h.requests).toContain("GET /.well-known/agent-card.json");
		expect(sends()).toEqual([]);
		expect(outcome).toBeInstanceOf(ApplicationFailure);
		expect((outcome as ApplicationFailure).type).toBe(
			"TurnNotDispatchable",
		);
	});

	it("a Stop recorded during a failed send attempt stops the client's retry", async () => {
		h.onSend.value = async () => {
			cancelled = true;
			throw new TypeError("fetch failed: ECONNRESET");
		};
		const outcome = await delegate(true);
		expect(sends()).toHaveLength(1);
		expect(outcome).toBeInstanceOf(ApplicationFailure);
		expect((outcome as ApplicationFailure).type).toBe(
			"TurnNotDispatchable",
		);
	});

	it("a cancelled activity aborts an in-flight send and reports cancelled", async () => {
		let sendAborted = false;
		h.onSend.value = (init) =>
			new Promise<Response>((_resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("never aborted")),
					3_000,
				);
				init?.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					sendAborted = true;
					reject(init.signal?.reason);
				});
			});
		const env = new MockActivityEnvironment();
		const running = env
			.run(executeAgentAsTool, {
				agentId: "agent-1",
				input: { message: "research the launch" },
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
				turnScope: TURN_SCOPE,
			})
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);
		await vi.waitFor(() => {
			expect(sends()).toHaveLength(1);
		});
		env.cancel();
		const outcome = await running;
		expect(sendAborted).toBe(true);
		expect(sends()).toHaveLength(1);
		expect(outcome).toBeInstanceOf(CancelledFailure);
	});

	it("a run without a turn delegates as before", async () => {
		h.onAgentCard.value = () => {
			cancelled = true;
		};
		const outcome = (await delegate(false)) as {
			resolvedWith: { output: unknown };
		};
		expect(sends()).toHaveLength(1);
		expect(outcome).toHaveProperty("resolvedWith");
		expect(h.checkDispatchable).not.toHaveBeenCalled();
	});

	it("a cancelled activity stops polling an asynchronous agent's task", async () => {
		h.onSend.value = async () =>
			json({ id: "task-1", status: "working", messages: [] });
		const env = new MockActivityEnvironment();
		const running = env
			.run(executeAgentAsTool, {
				agentId: "agent-1",
				input: { message: "research the launch" },
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
				turnScope: TURN_SCOPE,
			})
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);
		await vi.waitFor(() => {
			expect(h.requests).toContain("GET /a2a/tasks/task-1");
		});
		env.cancel();
		const outcome = await running;
		expect(outcome).toBeInstanceOf(CancelledFailure);
		// The poll loop ends with the activity: no poll after the cancel.
		const pollsAtCancel = h.requests.length;
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(h.requests).toHaveLength(pollsAtCancel);
		// The remote agent is not asked to cancel (see delegate-to-agent.ts:
		// aborting stops our requests only).
		expect(h.requests).not.toContain("POST /a2a/tasks/task-1/cancel");
	});
});
