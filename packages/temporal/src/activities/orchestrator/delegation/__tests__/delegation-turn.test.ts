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
	fetchAgentEndpoint: vi.fn(),
	pollCompleted: false,
	isExternal: true,
	/** Every outbound request, as "METHOD path". */
	requests: [] as string[],
	onAgentCard: { value: () => {} },
	onSend: {
		value: undefined as
			| ((init: RequestInit | undefined) => Promise<Response>)
			| undefined,
	},
}));

vi.mock("@repo/utils/agent-endpoint", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	fetchAgentEndpoint: h.fetchAgentEndpoint,
}));
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	checkConversationTurnDispatchable: h.checkDispatchable,
}));
// The real A2A clients, so the send, its retries and its signal are
// exercised down to `fetch`.
vi.mock("@repo/agent-core", async () => {
	vi.stubEnv("AGENT_SERVICE_SECRET", "example-delegation-service-secret");
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
		isExternal: h.isExternal,
	})),
}));
vi.mock("../../utils/partykit-publisher", () => ({
	publishToolStart: vi.fn(async () => undefined),
	publishToolComplete: vi.fn(async () => undefined),
}));

import { executeAgentAsTool } from "../../execution/execute-agent-as-tool";
import {
	rethrowIfTurnStopped,
	runWithTurnDispatch,
	TURN_BUDGET_EXHAUSTED,
} from "../../turn-dispatch";

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
	h.isExternal = true;
	h.pollCompleted = false;
	h.fetchAgentEndpoint
		.mockReset()
		.mockImplementation((url, init) => global.fetch(url, init));
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
			return json({
				id: "task-1",
				status: h.pollCompleted ? "completed" : "working",
				messages: [],
			});
		}
		throw new Error(`unexpected request ${url.pathname}`);
	}) as unknown as typeof fetch;
});

afterEach(() => {
	global.fetch = originalFetch;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
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

	it("a stop latched under the activity's turn guard while the send's own turn check reads the record stops the send", async () => {
		// The last turn check before the send is the client's per-attempt
		// check; a sibling request's budget refusal latches on the guard
		// while that check is reading the turn record. The guard's latched
		// stops are checked after the read, immediately before the send.
		let checks = 0;
		h.checkDispatchable.mockImplementation(async () => {
			checks += 1;
			if (checks === 2) {
				try {
					rethrowIfTurnStopped(
						ApplicationFailure.create({
							type: TURN_BUDGET_EXHAUSTED,
							message: "Turn has used its token allowance",
							nonRetryable: true,
						}),
					);
				} catch {
					// Latched on the guard, as a sibling's catch would.
				}
			}
			return { ok: true };
		});
		const outcome = await new MockActivityEnvironment()
			.run(() =>
				runWithTurnDispatch(TURN_SCOPE, () =>
					executeAgentAsTool({
						agentId: "agent-1",
						input: { message: "research the launch" },
						userId: TURN_SCOPE.userId,
						organizationId: TURN_SCOPE.organizationId,
						turnScope: TURN_SCOPE,
					}),
				),
			)
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);
		expect(checks).toBe(2);
		expect(sends()).toEqual([]);
		expect((outcome as ApplicationFailure).type).toBe(
			TURN_BUDGET_EXHAUSTED,
		);
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

describe("delegation agent API key", () => {
	it("authenticates a system agent with the trimmed key", async () => {
		vi.stubEnv("AGENT_API_KEY", "  example-agent-key  ");
		h.isExternal = false;
		let headers: Headers | undefined;
		h.onSend.value = async (init) => {
			headers = new Headers(init?.headers);
			return json({ id: "task-1", status: "completed", messages: [] });
		};
		const outcome = await delegate(false);
		expect(outcome).toHaveProperty("resolvedWith");
		expect(sends()).toHaveLength(1);
		expect(headers?.get("Authorization")).toBe("Bearer example-agent-key");
		expect(headers?.get("X-Service-Token")).toBe(
			"example-delegation-service-secret",
		);
		for (const name of [
			"X-Tenant-Signature",
			"X-Tenant-Payload",
			"X-Tenant-Timestamp",
		]) {
			expect(headers?.has(name), name).toBe(true);
		}
	});

	it.each([undefined, "   "])(
		"logs a missing system-agent key without throwing (%j)",
		async (key) => {
			vi.stubEnv("AGENT_API_KEY", key);
			h.isExternal = false;
			const error = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			let headers: Headers | undefined;
			h.onSend.value = async (init) => {
				headers = new Headers(init?.headers);
				return json({
					id: "task-1",
					status: "completed",
					messages: [],
				});
			};
			const outcome = await delegate(false);
			expect(outcome).toHaveProperty("resolvedWith");
			expect(sends()).toHaveLength(1);
			expect(headers?.has("Authorization")).toBe(false);
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining("AGENT_API_KEY is not set"),
			);
		},
	);

	it("withholds the agent key from an external agent", async () => {
		vi.stubEnv("AGENT_API_KEY", "example-agent-key");
		let headers: Headers | undefined;
		h.onSend.value = async (init) => {
			headers = new Headers(init?.headers);
			return json({ id: "task-1", status: "completed", messages: [] });
		};
		const outcome = await delegate(false);
		expect(outcome).toHaveProperty("resolvedWith");
		expect(sends()).toHaveLength(1);
		expect(headers).toBeDefined();
		for (const name of [
			"X-Service-Token",
			"X-Tenant-Signature",
			"X-Tenant-Payload",
			"X-Tenant-Timestamp",
		]) {
			expect.soft(headers?.has(name), name).toBe(false);
		}
		expect
			.soft(JSON.stringify(Array.from(headers ?? [])))
			.not.toContain("example-delegation-service-secret");
		expect(headers?.has("Authorization")).toBe(false);
		expect(JSON.stringify(Array.from(headers ?? []))).not.toContain(
			"example-agent-key",
		);
	});
});

describe("delegation outbound transport", () => {
	it.each([true, false])(
		"routes health, send and poll according to isExternal=%s",
		async (isExternal) => {
			h.isExternal = isExternal;
			h.pollCompleted = true;
			h.onSend.value = async () =>
				json({ id: "task-1", status: "working", messages: [] });
			const outcome = await delegate(false);
			expect(outcome).toHaveProperty("resolvedWith");
			expect(h.requests).toEqual([
				"GET /.well-known/agent-card.json",
				"POST /a2a/send",
				"GET /a2a/tasks/task-1",
			]);
			if (isExternal) {
				for (const path of [
					"/.well-known/agent-card.json",
					"/a2a/send",
					"/a2a/tasks/task-1",
				]) {
					expect
						.soft(h.fetchAgentEndpoint)
						.toHaveBeenCalledWith(
							`https://agent.example.com${path}`,
							expect.any(Object),
						);
				}
			} else {
				expect(h.fetchAgentEndpoint).not.toHaveBeenCalled();
			}
		},
	);
});

describe("failed delegation response", () => {
	it.each(["Unable to answer", undefined, 42])(
		"reads only a string metadata.error (%j)",
		async (error) => {
			h.onSend.value = async () =>
				json({
					id: "task-1",
					status: "failed",
					messages: [],
					metadata: { error, ai_api_key: "example-secret" },
				});
			const { delegateToAgent } = await import("../delegate-to-agent");
			const result = (await new MockActivityEnvironment().run(
				delegateToAgent,
				{
					agentId: "agent-1",
					message: "hello",
					userId: TURN_SCOPE.userId,
					organizationId: TURN_SCOPE.organizationId,
				},
			)) as Awaited<ReturnType<typeof delegateToAgent>>;
			expect(result.status).toBe("failed");
			expect(result.response).toContain(
				"A2A delegation to Example agent failed:",
			);
			if (typeof error === "string") {
				expect(result.response).toContain(error);
			}
			expect(result.response).not.toContain("example-secret");
			expect(result.response).not.toContain("42");
		},
	);
	it("returns readable failure text from an agent invoked as a tool", async () => {
		h.onSend.value = async () =>
			json({
				id: "task-1",
				status: "failed",
				messages: [],
				metadata: {
					error: "Unable to answer",
					ai_api_key: "example-secret",
				},
			});
		const outcome = await delegate(false);
		expect(outcome).toHaveProperty(
			"resolvedWith.output",
			"A2A delegation to Example agent failed: Unable to answer",
		);
		expect(JSON.stringify(outcome)).not.toContain("example-secret");
		expect(sends()).toHaveLength(1);
	});
});

it.each([
	{
		message: "Provider failed: api_key=example-secret",
		secret: "example-secret",
		expected: "Provider failed: <redacted>",
	},
	{
		message: "Provider failed: Authorization: Bearer example-session-token",
		secret: "example-session-token",
		expected: "Provider failed: <redacted>",
	},
	{
		message:
			"Provider failed: 401 Incorrect API key sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
		secret: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
		expected: "Provider failed: 401 Incorrect API key <redacted>",
	},
])(
	"sanitizes external metadata.error ($message)",
	async ({ message, secret, expected }) => {
		h.onSend.value = async () =>
			json({
				id: "task-1",
				status: "failed",
				messages: [],
				metadata: {
					error: message,
					ai_api_key: "example-other-secret",
				},
			});
		const { delegateToAgent } = await import("../delegate-to-agent");
		const result = (await new MockActivityEnvironment().run(
			delegateToAgent,
			{
				agentId: "agent-1",
				message: "hello",
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
			},
		)) as Awaited<ReturnType<typeof delegateToAgent>>;
		expect(result.status).toBe("failed");
		expect(result.response).toBe(
			`A2A delegation to Example agent failed: ${expected}`,
		);
		expect(JSON.stringify(result)).not.toContain(secret);
		expect(JSON.stringify(result)).not.toContain("example-other-secret");
	},
);
