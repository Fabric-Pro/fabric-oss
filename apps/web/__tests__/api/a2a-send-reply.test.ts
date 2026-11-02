/**
 * `POST /api/agents/a2a/send` — what the relay sends to the SYSTEM agent and
 * what it answers, pinned exactly so the steps it shares with the agent
 * runtime's `cuga-generalist` engine (`a2a-send-turn.ts`) keep its behaviour:
 *
 *   - the outbound call: the client's options, the A2A message with the
 *     history in its metadata, the tenant, and exactly the options the
 *     route always sent (no service credential, no trusted destination);
 *   - the JSON reply: text parts joined, reasoning from a data part or the
 *     task's metadata, the artifact text and tool calls, the completed and
 *     failed fallbacks, and the agent's conversation id or the one sent;
 *   - the refusals' exact bodies (404, 400, 403);
 *   - the AI config: a usage limit is the 429 the limit toast reads, any
 *     other token failure sends no AI config, a base URL failure still sends
 *     it without a base URL, and a failed send is the route's 500.
 */
import { agentEndpointRefusal } from "@repo/utils/agent-endpoint";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getSession: vi.fn(),
	isOrganizationMember: vi.fn(),
	getActiveSystemRegisteredAgent: vi.fn(),
	clientOptions: vi.fn(),
	sendMessageSecure: vi.fn(),
	buildEffectiveBaseUrl: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	getRAGProviderConfigForModel: vi.fn(),
	issueAIToken: vi.fn(),
}));

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (args: unknown) => m.getSession(args) } },
}));
vi.mock("@repo/database", () => ({
	getActiveSystemRegisteredAgent: (agentId: string) =>
		m.getActiveSystemRegisteredAgent(agentId),
	isOrganizationMember: (userId: string, organizationId: string) =>
		m.isOrganizationMember(userId, organizationId),
}));
vi.mock("@repo/agent-core/a2a", () => ({
	SecureA2AClient: class {
		constructor(options: unknown) {
			m.clientOptions(options);
		}
		sendMessageSecure = (...args: unknown[]) =>
			m.sendMessageSecure(...args);
	},
}));
vi.mock("@repo/ai", () => ({
	buildEffectiveBaseUrl: (...args: unknown[]) =>
		m.buildEffectiveBaseUrl(...args),
	getAIModelWithMetadata: (...args: unknown[]) =>
		m.getAIModelWithMetadata(...args),
	getRAGProviderConfigForModel: (...args: unknown[]) =>
		m.getRAGProviderConfigForModel(...args),
}));
vi.mock("@repo/ai-token", () => ({
	issueAIToken: (options: unknown) => m.issueAIToken(options),
}));
vi.mock("@repo/payments", async () => ({
	AiUsageLimitExceededError: (
		await import("@repo/payments/lib/ai-usage-limit-error")
	).AiUsageLimitExceededError,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { AiUsageLimitExceededError } = await import(
	"@repo/payments/lib/ai-usage-limit-error"
);
const { POST } = await import("../../app/api/agents/a2a/send/route");

function send(body: Record<string, unknown>) {
	return POST(
		new Request("http://localhost/api/agents/a2a/send", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}) as never,
	);
}

const AI_CONFIG = {
	token: "ai-token",
	model: "m",
	provider: "p",
	baseUrl: undefined,
};

/** A plain send with the reply `task`, and the route's JSON answer. */
async function replyTo(
	task: Record<string, unknown>,
	contextId?: string,
): Promise<unknown> {
	m.sendMessageSecure.mockResolvedValue(task);
	const res = await send({
		agentId: "system-agent",
		message: { role: "user", content: "hello" },
		...(contextId ? { contextId } : {}),
	});
	expect(res.status).toBe(200);
	return res.json();
}

beforeEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	process.env.AGENT_DISCOVERY_ALLOWED_HOSTS = "";
	m.getSession.mockResolvedValue({ user: { id: "user-1" }, session: {} });
	m.isOrganizationMember.mockResolvedValue(true);
	m.getActiveSystemRegisteredAgent.mockResolvedValue({
		deploymentUrl: "https://agent.example.com",
	});
	m.sendMessageSecure.mockResolvedValue({ id: "t1", status: "completed" });
	m.buildEffectiveBaseUrl.mockReturnValue(undefined);
	m.getAIModelWithMetadata.mockResolvedValue({
		metadata: { modelString: "m", provider: "p" },
		trackUsage: () => {},
	});
	m.getRAGProviderConfigForModel.mockResolvedValue({ baseUrl: null });
	m.issueAIToken.mockResolvedValue("ai-token");
});

describe("the outbound call", () => {
	it("sends the message, its history and the conversation to the SYSTEM agent", async () => {
		const res = await send({
			agentId: "system-agent",
			message: {
				role: "user",
				content: "hello",
				metadata: { source: "example" },
			},
			history: [{ role: "user", content: "earlier" }],
			contextId: "ctx-example-1",
			organizationId: "org-1",
		});

		expect(res.status).toBe(200);
		expect(m.clientOptions).toHaveBeenCalledTimes(1);
		expect(m.clientOptions.mock.calls[0]?.[0]).toEqual({
			timeout: 120000,
			sourceAgent: "fabric-web",
		});
		expect(m.sendMessageSecure.mock.calls[0]).toStrictEqual([
			"https://agent.example.com",
			{
				role: "user",
				parts: [{ type: "text", text: "hello" }],
				metadata: {
					source: "example",
					history: [{ role: "user", content: "earlier" }],
				},
			},
			{ userId: "user-1", organizationId: "org-1" },
			{
				contextId: "ctx-example-1",
				metadata: { source: "example" },
				aiConfig: AI_CONFIG,
			},
		]);
	});

	it("sends a bare message with no organization, history or conversation", async () => {
		const res = await send({
			agentId: "system-agent",
			message: { role: "user", content: "hello" },
		});

		expect(res.status).toBe(200);
		expect(m.sendMessageSecure.mock.calls[0]?.[1]).toStrictEqual({
			role: "user",
			parts: [{ type: "text", text: "hello" }],
			metadata: { history: [] },
		});
		expect(m.sendMessageSecure.mock.calls[0]?.[2]).toStrictEqual({
			userId: "user-1",
			organizationId: null,
		});
		// Exactly these three keys: no signal, trusted destination or
		// service credential.
		expect(m.sendMessageSecure.mock.calls[0]?.[3]).toStrictEqual({
			contextId: undefined,
			metadata: undefined,
			aiConfig: AI_CONFIG,
		});
	});
});

describe("the reply", () => {
	it("joins the agent's text parts", async () => {
		expect(
			await replyTo({
				id: "t1",
				contextId: "ctx-agent",
				status: "completed",
				messages: [
					{
						role: "agent",
						parts: [
							{ type: "text", text: "Hello " },
							{ type: "text", text: "world" },
						],
					},
				],
			}),
		).toEqual({
			response: "Hello world",
			contextId: "ctx-agent",
			taskId: "t1",
			status: "completed",
			toolCalls: [],
		});
	});

	it("reads the reasoning from a data part", async () => {
		expect(
			await replyTo({
				id: "t1",
				status: "completed",
				messages: [
					{
						role: "agent",
						parts: [
							{ type: "text", text: "Answer" },
							{ type: "data", data: { reasoning: "Because." } },
						],
					},
				],
				metadata: { reasoning: "Not this." },
			}),
		).toEqual({
			response: "Answer",
			taskId: "t1",
			status: "completed",
			toolCalls: [],
			reasoning: "Because.",
		});
	});

	it("falls back to the task's metadata for the reasoning", async () => {
		expect(
			await replyTo({
				id: "t1",
				status: "completed",
				messages: [
					{
						role: "agent",
						parts: [{ type: "text", text: "Answer" }],
					},
				],
				metadata: { reasoning: "From metadata." },
			}),
		).toEqual({
			response: "Answer",
			taskId: "t1",
			status: "completed",
			toolCalls: [],
			reasoning: "From metadata.",
		});
	});

	it("answers with an artifact's text, and passes its tool calls and the artifacts on", async () => {
		const artifacts = [
			{
				id: "a1",
				name: "out",
				mimeType: "text/plain",
				parts: [
					{ type: "text", text: "From the artifact" },
					{
						type: "data",
						data: {
							toolCalls: [
								{
									name: "search",
									args: { q: "x" },
									result: "r",
								},
							],
						},
					},
				],
			},
		];
		expect(
			await replyTo({
				id: "t1",
				status: "completed",
				messages: [],
				artifacts,
			}),
		).toEqual({
			response: "From the artifact",
			taskId: "t1",
			status: "completed",
			toolCalls: [{ name: "search", args: { q: "x" }, result: "r" }],
			artifacts,
		});
	});

	it("says a completed task with no text completed", async () => {
		expect(
			await replyTo({ id: "t1", status: "completed", messages: [] }),
		).toEqual({
			response: "Task completed successfully.",
			taskId: "t1",
			status: "completed",
			toolCalls: [],
		});
	});

	it.each([
		[{ error: { message: "The agent gave up." } }, "The agent gave up."],
		[undefined, "Task failed with unknown error."],
	])("says why a failed task failed (%j)", async (metadata, response) => {
		expect(
			await replyTo({
				id: "t1",
				status: "failed",
				messages: [],
				metadata,
			}),
		).toEqual({ response, taskId: "t1", status: "failed", toolCalls: [] });
	});

	it("keeps the agent's conversation id, else the one sent", async () => {
		expect(
			await replyTo(
				{ id: "t1", contextId: "ctx-agent", status: "completed" },
				"ctx-sent",
			),
		).toMatchObject({ contextId: "ctx-agent" });
		expect(
			await replyTo({ id: "t1", status: "completed" }, "ctx-sent"),
		).toMatchObject({ contextId: "ctx-sent" });
	});
});

describe("the refusals", () => {
	it("refuses an organization the caller is not a member of", async () => {
		m.isOrganizationMember.mockResolvedValue(false);

		const res = await send({
			agentId: "system-agent",
			message: { role: "user", content: "hello" },
			organizationId: "org-someone-else",
		});

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "Access denied: you are not a member of organization org-someone-else",
		});
		expect(m.getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(m.issueAIToken).not.toHaveBeenCalled();
		expect(m.sendMessageSecure).not.toHaveBeenCalled();
	});

	it("refuses an endpoint the guard rejects with its own text", async () => {
		m.getActiveSystemRegisteredAgent.mockResolvedValue({
			deploymentUrl: "http://10.0.0.5:9000",
		});

		const res = await send({
			agentId: "system-agent",
			message: { role: "user", content: "hello" },
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: agentEndpointRefusal("http://10.0.0.5:9000"),
		});
		expect(m.issueAIToken).not.toHaveBeenCalled();
		expect(m.sendMessageSecure).not.toHaveBeenCalled();
	});

	it("hides an agent it cannot find", async () => {
		m.getActiveSystemRegisteredAgent.mockResolvedValue(null);

		const res = await send({
			agentId: "system-agent",
			message: { role: "user", content: "hello" },
		});

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Agent not found" });
		expect(m.getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(m.sendMessageSecure).not.toHaveBeenCalled();
	});
});

describe("the AI config", () => {
	it("answers a usage limit with the 429 the limit toast reads, and sends nothing", async () => {
		m.issueAIToken.mockRejectedValue(
			new AiUsageLimitExceededError({
				message: "AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
				limitId: "limit-1",
				dimension: "TOKENS",
				window: "MONTHLY",
				used: BigInt(10),
				max: BigInt(10),
				manageLimitsUrl: "https://example.com/limits",
			}),
		);

		const res = await send({
			agentId: "system-agent",
			message: { role: "user", content: "hello" },
		});

		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({
			error: "AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
			code: "AI_USAGE_LIMIT_EXCEEDED",
			data: {
				limitId: "limit-1",
				dimension: "TOKENS",
				window: "MONTHLY",
				used: "10",
				max: "10",
				manageLimitsUrl: "https://example.com/limits",
			},
		});
		expect(m.sendMessageSecure).not.toHaveBeenCalled();
	});

	it("sends no AI config when the token cannot be issued for another reason", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		m.issueAIToken.mockRejectedValue(new Error("token service down"));

		const res = await send({
			agentId: "system-agent",
			message: { role: "user", content: "hello" },
		});

		expect(res.status).toBe(200);
		expect(
			m.sendMessageSecure.mock.calls[0]?.[3]?.aiConfig,
		).toBeUndefined();
		expect(warn).toHaveBeenCalled();
	});

	it("still sends the AI config, with no base URL, when the base URL fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		m.buildEffectiveBaseUrl.mockImplementation(() => {
			throw new Error("bad base URL");
		});

		const res = await send({
			agentId: "system-agent",
			message: { role: "user", content: "hello" },
		});

		expect(res.status).toBe(200);
		expect(m.sendMessageSecure.mock.calls[0]?.[3]?.aiConfig).toStrictEqual(
			AI_CONFIG,
		);
	});

	it("answers a failed send with the route's 500", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		m.sendMessageSecure.mockRejectedValue(new Error("agent unreachable"));

		const res = await send({
			agentId: "system-agent",
			message: { role: "user", content: "hello" },
		});

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "agent unreachable" });
	});
});
