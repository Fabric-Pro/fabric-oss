/**
 * The Sidekick's shared turn (`sidekick-turn.ts`), which its stream route and
 * the agent runtime's `agent-builder-sidekick` engine both call.
 *
 *   - `authorizeSidekickEntity` answers a refusal as `{ok: false, status,
 *     error}` with the route's exact messages, and admits a registered agent
 *     in its own organization, not the session's;
 *   - an unsaved agent looks nothing up and runs in the session's
 *     organization as "new";
 *   - `streamSidekickTurn` puts the form in front of the last user message
 *     only, strips the copies earlier turns carried, and passes an abort
 *     signal to the model call only when given one.
 *
 * Mocked: the database lookups, organization authorization, rate limit,
 * model resolution and the Sidekick's tool factory. The AI SDK is real.
 */
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	agent: vi.fn(),
	membership: vi.fn(),
	authorize: vi.fn(),
	model: vi.fn(),
	tools: vi.fn(),
	streamText: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: {} }));
vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: async () => ({ allowed: true }),
	RATE_LIMIT_PRESETS: { ai: { limit: 20, windowMs: 60_000 } },
}));
vi.mock("@repo/api/orpc/procedures", () => ({
	authorizeInputOrganization: h.authorize,
	Permissions: { AGENT_TEMPLATE_READ: "agent-template:read" },
}));
vi.mock("@repo/database", () => ({
	db: {},
	getOrganizationMembership: h.membership,
	getRegisteredAgentById: h.agent,
}));
vi.mock("@repo/ai", async () => {
	const ai = await vi.importActual<typeof import("ai")>("ai");
	h.streamText.mockImplementation(ai.streamText);
	return {
		convertToModelMessages: ai.convertToModelMessages,
		isStepCount: ai.isStepCount,
		streamText: h.streamText,
		getAIModelWithMetadata: h.model,
	};
});
vi.mock("@repo/ai/sidekick", () => ({ createSidekickTools: h.tools }));

import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { authorizeSidekickEntity, streamSidekickTurn } from "../sidekick-turn";

const USER_ID = "user-example-1";
const SESSION_ORG = "org-example-session";
const AGENT_ORG = "org-example-agent";

function model() {
	return new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [
					{ type: "stream-start", warnings: [] },
					{ type: "text-start", id: "t1" },
					{ type: "text-delta", id: "t1", delta: "Ready." },
					{ type: "text-end", id: "t1" },
					{
						type: "finish",
						finishReason: { unified: "stop", raw: undefined },
						usage: {
							inputTokens: {
								total: 1,
								noCache: 1,
								cacheRead: 0,
								cacheWrite: 0,
							},
							outputTokens: { total: 1, text: 1, reasoning: 0 },
						},
					},
				],
			}),
		}),
	});
}

let current: MockLanguageModelV4;

beforeEach(() => {
	vi.clearAllMocks();
	current = model();
	h.membership.mockResolvedValue({
		role: "member",
		organization: { deletedAt: null },
	});
	h.tools.mockReturnValue({});
	h.model.mockImplementation(async () => ({
		model: current,
		metadata: { provider: "OPENAI", modelString: "example-model" },
		trackUsage: vi.fn(),
	}));
});

function authorize(
	entityType: "registered" | "instance" | "new" = "registered",
	agentId = "agent-example-1",
) {
	return authorizeSidekickEntity({
		userId: USER_ID,
		agentId,
		entityType,
		sessionOrganizationId: SESSION_ORG,
	});
}

describe("authorizeSidekickEntity", () => {
	it("registered: missing agent is 404 Agent not found", async () => {
		h.agent.mockResolvedValue(null);

		await expect(authorize()).resolves.toEqual({
			ok: false,
			status: 404,
			error: "Agent not found",
		});
	});

	it("registered SYSTEM agent is 403 with the system-agent message", async () => {
		h.agent.mockResolvedValue({ scope: "SYSTEM", userId: null });

		await expect(authorize()).resolves.toEqual({
			ok: false,
			status: 403,
			error: "System agents cannot be modified via Sidekick",
		});
	});

	it("registered USER agent of another user is 403 Forbidden", async () => {
		h.agent.mockResolvedValue({
			scope: "USER",
			userId: "user-example-other",
			organizationId: null,
		});

		await expect(authorize()).resolves.toEqual({
			ok: false,
			status: 403,
			error: "Forbidden",
		});
	});

	it("own USER agent is admitted with no organization", async () => {
		h.agent.mockResolvedValue({
			scope: "USER",
			userId: USER_ID,
			organizationId: null,
		});

		await expect(authorize()).resolves.toEqual({
			ok: true,
			organizationId: undefined,
			entityType: "registered",
			organizationDeleted: false,
		});
		expect(h.membership).not.toHaveBeenCalled();
	});

	it("ORGANIZATION agent without organizationId is 403", async () => {
		h.agent.mockResolvedValue({
			scope: "ORGANIZATION",
			userId: USER_ID,
			organizationId: null,
		});

		await expect(authorize()).resolves.toEqual({
			ok: false,
			status: 403,
			error: "Forbidden",
		});
	});

	it("ORGANIZATION agent: non-member 403, member admitted in the agent's organization", async () => {
		h.agent.mockResolvedValue({
			scope: "ORGANIZATION",
			userId: "user-example-other",
			organizationId: AGENT_ORG,
		});
		h.membership.mockResolvedValueOnce(null);

		await expect(authorize()).resolves.toEqual({
			ok: false,
			status: 403,
			error: "Forbidden",
		});
		await expect(authorize()).resolves.toEqual({
			ok: true,
			organizationId: AGENT_ORG,
			entityType: "registered",
			organizationDeleted: false,
		});
		expect(h.membership).toHaveBeenNthCalledWith(1, AGENT_ORG, USER_ID);
		expect(h.membership).toHaveBeenNthCalledWith(2, AGENT_ORG, USER_ID);
	});

	it("ORGANIZATION agent of a deleted organization is admitted to its member, marked deleted for the runtime to refuse", async () => {
		h.agent.mockResolvedValue({
			scope: "ORGANIZATION",
			userId: USER_ID,
			organizationId: AGENT_ORG,
		});
		h.membership.mockResolvedValue({
			role: "owner",
			organization: { deletedAt: new Date(0) },
		});

		await expect(authorize()).resolves.toEqual({
			ok: true,
			organizationId: AGENT_ORG,
			entityType: "registered",
			organizationDeleted: true,
		});
		expect(h.membership).toHaveBeenCalledWith(AGENT_ORG, USER_ID);
	});

	it.each(["owner", "admin", "member", "viewer"])(
		"admits an organization agent to its %s, bound to the stored organization",
		async (role) => {
			h.agent.mockResolvedValue({
				scope: "ORGANIZATION",
				userId: "user-example-other",
				organizationId: AGENT_ORG,
			});
			h.membership.mockResolvedValue({
				role,
				organization: { deletedAt: null },
			});
			await expect(authorize()).resolves.toEqual({
				ok: true,
				organizationId: AGENT_ORG,
				entityType: "registered",
				organizationDeleted: false,
			});
			expect(h.membership).toHaveBeenCalledWith(AGENT_ORG, USER_ID);
		},
	);

	it("entityType new and agentId 'new' with entityType registered both skip lookups and use the session organization, entityType 'new'", async () => {
		const admitted = {
			ok: true,
			organizationId: SESSION_ORG,
			entityType: "new",
			organizationDeleted: false,
		};

		await expect(authorize("new", "agent-example-1")).resolves.toEqual(
			admitted,
		);
		await expect(authorize("registered", "new")).resolves.toEqual(admitted);
		await expect(authorize("instance", "new")).resolves.toEqual(admitted);
		expect(h.agent).not.toHaveBeenCalled();
		expect(h.membership).not.toHaveBeenCalled();
		expect(h.authorize).not.toHaveBeenCalled();
	});
});

function userMessage(id: string, text: string): UIMessage {
	return { id, role: "user", parts: [{ type: "text", text }] };
}

/** Run a turn to its end, so the model has been called. */
async function runTurn(
	messages: UIMessage[],
	abortSignal?: AbortSignal,
): Promise<void> {
	const result = await streamSidekickTurn({
		userId: USER_ID,
		agentId: "agent-example-1",
		entityType: "registered",
		organizationId: AGENT_ORG,
		messages,
		formSnapshot: { name: "Researcher" },
		...(abortSignal ? { abortSignal } : {}),
	});
	await result.consumeStream();
}

describe("streamSidekickTurn", () => {
	it("streamSidekickTurn prepends the form snapshot to the last user message only and strips earlier <agent_context> blocks", async () => {
		await runTurn([
			userMessage(
				"user-1",
				'<agent_context>\n{"name":"Old"}\n</agent_context>\n\nFirst ask',
			),
			{
				id: "assistant-1",
				role: "assistant",
				parts: [{ type: "text", text: "Sure." }],
			},
			userMessage("user-2", "Second ask"),
		]);

		const [call] = current.doStreamCalls;
		const userTexts = call?.prompt.flatMap((message) =>
			message.role === "user"
				? [
						message.content
							.flatMap((part) =>
								part.type === "text" ? [part.text] : [],
							)
							.join(""),
					]
				: [],
		);
		expect(userTexts).toEqual([
			"First ask",
			'<agent_context>\n{"name":"Researcher"}\n</agent_context>\n\nSecond ask',
		]);
		expect(h.model).toHaveBeenCalledWith(
			{ taskType: "CHAT" },
			expect.objectContaining({
				userId: USER_ID,
				organizationId: AGENT_ORG,
				planEligible: true,
			}),
		);
		expect(h.tools).toHaveBeenCalledWith({
			agentId: "agent-example-1",
			entityType: "registered",
			userId: USER_ID,
			organizationId: AGENT_ORG,
		});
	});

	it("streamSidekickTurn passes abortSignal only when given", async () => {
		const controller = new AbortController();

		await runTurn([userMessage("user-1", "First ask")]);
		await runTurn([userMessage("user-1", "First ask")], controller.signal);

		const [withoutSignal, withSignal] = h.streamText.mock.calls.map(
			([options]) => options,
		);
		expect(withoutSignal).not.toHaveProperty("abortSignal");
		expect(withSignal).toHaveProperty("abortSignal", controller.signal);
	});
});
