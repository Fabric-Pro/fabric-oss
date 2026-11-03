// @vitest-environment node
/**
 * The runtime's `agent-builder-sidekick` engine: the Agent Builder Sidekick,
 * streamed as AG-UI events.
 *
 *   - refused before RUN_STARTED, with no model, tool or entity work beyond
 *     the refusing check: `FEATURE_DISABLED` while `COPILOTKIT_SIDEKICK_CHAT`
 *     is off for the organization on screen, `RATE_LIMITED` on the route's
 *     budget, `INVALID_REQUEST` for bad props, `NO_MESSAGE` without a new
 *     user message, the route's own `FORBIDDEN`/`NOT_FOUND` for the agent
 *     being edited, `FORBIDDEN` for a registered agent of a deleted
 *     organization (which the route admits), and `FORBIDDEN` for a new
 *     agent, named by its id or its entity type, in
 *     an organization the caller is not a member of;
 *   - an admitted turn runs the real Sidekick tools on the agent's own
 *     organization (an instance's, a registered agent's, the organization on
 *     screen for a new agent), billed as the route bills it, inside the
 *     caller's own interactive context (never an impersonator's);
 *   - a second run's history reaches the model as the route's would, with
 *     the route's cache markers;
 *   - a usage limit, at resolution or mid-turn, and a ChatGPT plan refusal
 *     end the run with the route's code and body; a tool that throws answers
 *     "An error occurred." and the turn goes on; a stop aborts the model call
 *     and ends the run; an unexpected access failure is a generic error.
 */
import {
	type AGUIEvent,
	type BaseEvent,
	EventType,
	type Message,
	type RunAgentInput,
	verifyEvents,
} from "@ag-ui/client";
import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import {
	isAiImpersonatedRequest,
	isAiInteractiveRequestFor,
} from "@repo/ai/lib/chatgpt-plan/interactive-context";
import { ChatGptPlanModelNotServedError } from "@repo/ai/lib/chatgpt-plan/models";
import { ChatGptPlanAuthError } from "@repo/ai/lib/chatgpt-plan/oauth";
import { wrapModelWithUsageLimits } from "@repo/ai/lib/usage-limit-middleware";
import { createSidekickTools } from "@repo/ai/sidekick";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import type { RunStream, RuntimeCaller } from "@saas/agents/runtime/engine";
import { SidekickEngine } from "@saas/agents/runtime/sidekick-engine";
import { toUIMessageStream, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { from, lastValueFrom, toArray } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSidekickTurn } from "../../../app/api/agents/sidekick/stream/sidekick-turn";
import {
	type ModelChunk,
	modelStep,
	SUGGEST_TOOLS_INPUT,
	scriptedReply,
	textChunks,
	toolCallChunk,
} from "./_helpers/sidekick-history";

const m = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	findInstance: vi.fn(),
	getOrganizationMembership: vi.fn(),
	getRegisteredAgentById: vi.fn(),
	countPendingSuggestionsByKind: vi.fn(),
	markRegisteredAgentSuggestionsOutdated: vi.fn(),
	createRegisteredAgentSuggestions: vi.fn(),
	checkRateLimit: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	trackUsage: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: {} }));
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	isFeatureEnabled: (...args: unknown[]) => m.isFeatureEnabled(...args),
	db: {
		agentTemplateInstance: {
			findUnique: (...args: unknown[]) => m.findInstance(...args),
		},
	},
	getOrganizationMembership: (...args: unknown[]) =>
		m.getOrganizationMembership(...args),
	getRegisteredAgentById: (...args: unknown[]) =>
		m.getRegisteredAgentById(...args),
	countPendingSuggestionsByKind: (...args: unknown[]) =>
		m.countPendingSuggestionsByKind(...args),
	markRegisteredAgentSuggestionsOutdated: (...args: unknown[]) =>
		m.markRegisteredAgentSuggestionsOutdated(...args),
	createRegisteredAgentSuggestions: (...args: unknown[]) =>
		m.createRegisteredAgentSuggestions(...args),
}));
vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: (...args: unknown[]) => m.checkRateLimit(...args),
	RATE_LIMIT_PRESETS: { ai: { limit: 20, windowMs: 60_000 } },
}));
// The route's AI SDK entry points, real; only model resolution is replaced.
vi.mock("@repo/ai", async () => {
	const ai = await vi.importActual<typeof import("ai")>("ai");
	return {
		convertToModelMessages: ai.convertToModelMessages,
		isStepCount: ai.isStepCount,
		streamText: ai.streamText,
		getAIModelWithMetadata: (...args: unknown[]) =>
			m.getAIModelWithMetadata(...args),
	};
});
// The real tool set, watched.
vi.mock("@repo/ai/sidekick", async (importOriginal) => {
	const real = await importOriginal<typeof import("@repo/ai/sidekick")>();
	return { ...real, createSidekickTools: vi.fn(real.createSidekickTools) };
});

const THREAD = "thread-example-0001";
const RUN = "run-example-0001";
const USER = "user-example-1";
const ORG = "org-example-1";
const CALLER: RuntimeCaller = {
	userId: USER,
	organizationId: ORG,
	audit: {
		session: {
			id: "session-example-1",
			activeOrganizationId: "org-example-2",
			impersonatedBy: null,
		},
	},
};
const SNAPSHOT = { name: "Example agent", tools: [] };
const NEW_AGENT = { agentId: "new", entityType: "new", formSnapshot: SNAPSHOT };
const QUESTION: Message = {
	id: "user-1",
	role: "user",
	content: "Help me improve this agent",
};
const APPLY_TOOLS =
	/<sidekick_apply_tools>\n([\s\S]*?)\n<\/sidekick_apply_tools>/;

const tools = vi.mocked(createSidekickTools);

/** The model the next run resolves; each run gets its own. */
let model: MockLanguageModelV4;

function useModel(
	next: MockLanguageModelV4,
	metadata = { provider: "OPENAI", modelString: "gpt-example" },
): MockLanguageModelV4 {
	model = next;
	m.getAIModelWithMetadata.mockResolvedValueOnce({
		model: next,
		metadata,
		trackUsage: m.trackUsage,
	});
	return next;
}

/** Step 1: text and a valid `suggest_tools` call. Step 2: text. */
function suggestingModel(): MockLanguageModelV4 {
	return new MockLanguageModelV4({
		doStream: [
			modelStep(
				[
					...textChunks("t1", "Adding a tool."),
					toolCallChunk(
						"call-1",
						"suggest_tools",
						SUGGEST_TOOLS_INPUT,
					),
				],
				"tool-calls",
			),
			modelStep(textChunks("t2", "Added it.")),
		],
	});
}

it("captures each served step before a later step changes the fallback snapshot", async () => {
	const metadata = {
		provider: "OPENAI_CHATGPT_PLAN",
		modelString: "example-configured",
		answerSnapshot: {
			provider: "OPENAI_CHATGPT_PLAN",
			modelString: "example-plan-served",
		},
	};
	let step = 0;
	useModel(
		new MockLanguageModelV4({
			doStream: async () => {
				if (step++ === 0) {
					return modelStep(
						[
							...textChunks("t1", "Checking."),
							toolCallChunk(
								"call-1",
								"suggest_tools",
								SUGGEST_TOOLS_INPUT,
							),
						],
						"tool-calls",
					);
				}
				metadata.answerSnapshot = {
					provider: "OPENAI_DIRECT",
					modelString: "example-api-served",
				};
				return modelStep(textChunks("t2", "Answer."));
			},
		}),
		metadata,
	);
	const result = await streamSidekickTurn({
		userId: USER,
		agentId: "new",
		entityType: "new",
		organizationId: ORG,
		messages: [
			{
				id: "question",
				role: "user",
				parts: [{ type: "text", text: "Help" }],
			},
		],
		formSnapshot: SNAPSHOT,
	});
	let metadataStep = 0;
	const reader = toUIMessageStream({
		stream: result.stream,
		messageMetadata: ({ part }) =>
			part.type === "finish-step"
				? { model: result.getAnswerModel(metadataStep++) }
				: undefined,
	}).getReader();
	const received: unknown[] = [];
	while (true) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		if (value.type === "message-metadata") {
			received.push(value.messageMetadata);
		}
	}
	expect(received).toEqual([
		{
			model: expect.objectContaining({
				id: "example-plan-served",
				viaPlan: true,
			}),
		},
		{
			model: expect.objectContaining({
				id: "example-api-served",
				viaPlan: false,
			}),
		},
	]);
	metadata.answerSnapshot = {
		provider: "OPENAI_DIRECT",
		modelString: "example-later",
	};
	expect(result.getAnswerModel(0)).toMatchObject({
		id: "example-plan-served",
		viaPlan: true,
	});
	expect(result.getAnswerModel(1)).toMatchObject({
		id: "example-api-served",
		viaPlan: false,
	});
});

function input(
	forwardedProps: unknown,
	messages: Message[] = [QUESTION],
): RunAgentInput {
	return {
		threadId: THREAD,
		runId: RUN,
		messages,
		tools: [],
		context: [],
		state: {},
		forwardedProps,
	};
}

function collector(): RunStream & { events: AGUIEvent[] } {
	const events: AGUIEvent[] = [];
	return {
		events,
		emit: (event) => events.push(event),
		isClosed: () => false,
		deadline: Date.now() + 60_000,
	};
}

async function run(
	forwardedProps: unknown,
	{
		caller = CALLER,
		messages,
	}: { caller?: RuntimeCaller; messages?: Message[] } = {},
): Promise<AGUIEvent[]> {
	const stream = collector();
	await new SidekickEngine(caller).run(
		{ threadId: THREAD, input: input(forwardedProps, messages) },
		stream,
	);
	return stream.events;
}

function verified(events: AGUIEvent[]): Promise<BaseEvent[]> {
	return lastValueFrom(
		from(events as BaseEvent[]).pipe(verifyEvents(false), toArray()),
	);
}

function refusal(code: string, message: string = expect.any(String)) {
	return [{ type: EventType.RUN_ERROR, code, message }];
}

function expectNoModelCall() {
	expect(m.getAIModelWithMetadata).not.toHaveBeenCalled();
	expect(tools).not.toHaveBeenCalled();
	expect(model.doStreamCalls).toHaveLength(0);
}

function sidekickRateLimitChecks(): unknown[][] {
	return m.checkRateLimit.mock.calls.filter(
		([key]) => key === `sidekick-stream:${USER}`,
	);
}

function toolResults(events: AGUIEvent[]): string[] {
	return events.flatMap((event) =>
		event.type === EventType.TOOL_CALL_RESULT ? [event.content] : [],
	);
}

function membership(deletedAt: Date | null = null, role = "member") {
	return { role, organization: { deletedAt } };
}

function usageLimit(): AiUsageLimitExceededError {
	return new AiUsageLimitExceededError({
		message: "AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
		limitId: "limit-1",
		dimension: "TOKENS",
		window: "MONTHLY",
		used: BigInt(100),
		max: BigInt(100),
		manageLimitsUrl: "https://example.com/limits",
	});
}

beforeEach(() => {
	vi.restoreAllMocks();
	for (const mock of Object.values(m)) {
		mock.mockReset();
	}
	tools.mockClear();
	expect(process.env.RBAC_DRY_RUN).toBeUndefined();
	m.isFeatureEnabled.mockResolvedValue(true);
	m.checkRateLimit.mockResolvedValue({
		allowed: true,
		remaining: 19,
		resetInSeconds: 60,
	});
	m.getOrganizationMembership.mockResolvedValue(membership());
	m.countPendingSuggestionsByKind.mockResolvedValue(0);
	m.markRegisteredAgentSuggestionsOutdated.mockResolvedValue(undefined);
	m.createRegisteredAgentSuggestions.mockResolvedValue([
		{ id: "suggestion-example-1" },
	]);
	model = new MockLanguageModelV4({ doStream: [] });
});

describe("SidekickEngine admission", () => {
	it("refuses while its flag is off for the organization on screen, before anything else", async () => {
		m.isFeatureEnabled.mockResolvedValue(false);

		const events = await run(NEW_AGENT);

		expect(events).toEqual(refusal("FEATURE_DISABLED"));
		expect(m.isFeatureEnabled).toHaveBeenCalledWith(
			"COPILOTKIT_SIDEKICK_CHAT",
			ORG,
		);
		// Only the runtime's request floor ran; the Sidekick's own budget did not.
		expect(m.checkRateLimit.mock.calls.map(([key]) => key)).toEqual([
			`rpc:user:${USER}`,
		]);
		expect(m.getRegisteredAgentById).not.toHaveBeenCalled();
		expect(m.findInstance).not.toHaveBeenCalled();
		expect(m.getOrganizationMembership).not.toHaveBeenCalled();
		expectNoModelCall();
	});

	it("refuses over the route's rate limit, which both transports share", async () => {
		m.checkRateLimit.mockImplementation(async (key: string) =>
			key.startsWith("sidekick-stream:")
				? { allowed: false, remaining: 0, resetInSeconds: 42 }
				: { allowed: true, remaining: 999, resetInSeconds: 60 },
		);

		const events = await run(NEW_AGENT);

		expect(events).toEqual(
			refusal(
				"RATE_LIMITED",
				"Rate limit exceeded. Please try again in 42 seconds.",
			),
		);
		expect(sidekickRateLimitChecks()).toEqual([
			[`sidekick-stream:${USER}`, 20, 60_000],
		]);
		expectNoModelCall();
	});

	it("refuses props without a form snapshot", async () => {
		const events = await run({ agentId: "new", entityType: "new" });

		expect(events).toEqual(refusal("INVALID_REQUEST"));
		expectNoModelCall();
	});

	it.each([
		[
			"an assistant message",
			[QUESTION, { id: "a-1", role: "assistant", content: "Hi" }],
		],
		["a blank question", [{ id: "u-2", role: "user", content: "   " }]],
	] satisfies Array<[string, Message[]]>)(
		"refuses a run that ends with %s, before any lookup",
		async (_label, messages) => {
			const events = await run(
				{
					agentId: "agent-example-1",
					entityType: "registered",
					formSnapshot: SNAPSHOT,
				},
				{ messages },
			);

			expect(events).toEqual(
				refusal("NO_MESSAGE", "A run needs a new user message."),
			);
			expect(m.getRegisteredAgentById).not.toHaveBeenCalled();
			expect(m.findInstance).not.toHaveBeenCalled();
			expect(m.getOrganizationMembership).not.toHaveBeenCalled();
			expectNoModelCall();
		},
	);

	it("refuses what the route refuses, with its message and no model call", async () => {
		const registered = {
			agentId: "agent-example-1",
			entityType: "registered",
			formSnapshot: SNAPSHOT,
		};
		m.getRegisteredAgentById.mockResolvedValue({
			id: "agent-example-1",
			scope: "SYSTEM",
			organizationId: null,
			userId: null,
		});
		expect(await run(registered)).toEqual(
			refusal(
				"FORBIDDEN",
				"System agents cannot be modified via Sidekick",
			),
		);

		m.getRegisteredAgentById.mockResolvedValue({
			id: "agent-example-1",
			scope: "ORGANIZATION",
			organizationId: "org-example-3",
			userId: "user-example-9",
		});
		m.getOrganizationMembership.mockResolvedValue(null);
		expect(await run(registered)).toEqual(
			refusal("FORBIDDEN", "Forbidden"),
		);

		m.findInstance.mockResolvedValue(null);
		expect(
			await run({
				agentId: "instance-example-1",
				entityType: "instance",
				formSnapshot: SNAPSHOT,
			}),
		).toEqual(refusal("NOT_FOUND", "Agent not found"));

		expectNoModelCall();
	});

	it("refuses a registered organization agent of a deleted organization to its member", async () => {
		m.getRegisteredAgentById.mockResolvedValue({
			id: "agent-example-1",
			scope: "ORGANIZATION",
			organizationId: "org-example-3",
			userId: USER,
		});
		m.getOrganizationMembership.mockResolvedValue(
			membership(new Date(0), "owner"),
		);

		const events = await run({
			agentId: "agent-example-1",
			entityType: "registered",
			formSnapshot: SNAPSHOT,
		});

		expect(events).toEqual(refusal("FORBIDDEN", "Forbidden"));
		expect(m.getOrganizationMembership).toHaveBeenCalledWith(
			"org-example-3",
			USER,
		);
		expectNoModelCall();
	});

	it.each([
		["no membership", null],
		[
			"membership in a deleted organization",
			membership(new Date(0), "owner"),
		],
	])(
		"refuses an existing instance with %s in its stored organization",
		async (_label, row) => {
			m.findInstance.mockResolvedValue({
				userId: USER,
				organizationId: "org-example-instance",
			});
			m.getOrganizationMembership.mockResolvedValue(row);

			const events = await run({
				agentId: "instance-example-1",
				entityType: "instance",
				formSnapshot: SNAPSHOT,
			});

			expect(events).toEqual(refusal("FORBIDDEN", "Forbidden"));
			expect(m.getOrganizationMembership).toHaveBeenCalledWith(
				"org-example-instance",
				USER,
			);
			expect(m.getRegisteredAgentById).not.toHaveBeenCalled();
			expect(m.trackUsage).not.toHaveBeenCalled();
			expectNoModelCall();
		},
	);

	// A new agent is named either way: agentId "new" for any entity type, or
	// entityType "new" with any agentId.
	it.each([
		[
			"no membership (a project-guest tie only)",
			null,
			{ agentId: "new", entityType: "registered" },
		],
		[
			"a membership in a deleted organization",
			membership(new Date(0)),
			{ agentId: "new", entityType: "registered" },
		],
		[
			"no membership, naming a new agent by entityType",
			null,
			{ agentId: "agent-example-1", entityType: "new" },
		],
	])(
		"refuses a new agent for a caller with %s in the organization on screen",
		async (_label, row, agent) => {
			m.getOrganizationMembership.mockResolvedValue(row);

			const events = await run({ ...agent, formSnapshot: SNAPSHOT });

			expect(events).toEqual(refusal("FORBIDDEN", "Forbidden"));
			expect(m.getOrganizationMembership).toHaveBeenCalledWith(ORG, USER);
			expect(m.getRegisteredAgentById).not.toHaveBeenCalled();
			expect(m.findInstance).not.toHaveBeenCalled();
			expectNoModelCall();
		},
	);

	it("ends an unexpected access failure as a generic error", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		m.getRegisteredAgentById.mockRejectedValue(
			new Error("Example lookup failure"),
		);

		const events = await run({
			agentId: "agent-example-1",
			entityType: "registered",
			formSnapshot: SNAPSHOT,
		});

		expect(events).toEqual(refusal("RUN_FAILED"));
		expect(JSON.stringify(events)).not.toContain("Example lookup failure");
		expect(log).toHaveBeenCalled();
		expectNoModelCall();
	});
});

describe("SidekickEngine turn", () => {
	it("streams a new agent's turn with the real tools, in the organization on screen, billed as the route bills it", async () => {
		useModel(suggestingModel());

		const events = await run({
			agentId: "new",
			entityType: "registered",
			formSnapshot: SNAPSHOT,
		});

		expect(events.map((event) => event.type)).toEqual([
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.TOOL_CALL_START,
			EventType.TOOL_CALL_ARGS,
			EventType.TOOL_CALL_END,
			EventType.TOOL_CALL_RESULT,
			EventType.CUSTOM,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.CUSTOM,
			EventType.RUN_FINISHED,
		]);
		expect(events[1]).toMatchObject({ messageId: `${RUN}:s0:m0` });
		expect(events[4]).toMatchObject({
			toolCallName: "suggest_tools",
			parentMessageId: `${RUN}:s0:m0`,
		});
		expect(events[9]).toMatchObject({ messageId: `${RUN}:s1:m1` });
		const [result] = toolResults(events);
		expect(JSON.parse(result?.match(APPLY_TOOLS)?.[1] ?? "null")).toEqual(
			SUGGEST_TOOLS_INPUT.suggestions,
		);
		expect(tools).toHaveBeenCalledWith({
			agentId: "new",
			entityType: "new",
			userId: USER,
			organizationId: ORG,
		});
		expect(m.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "CHAT" },
			{
				userId: USER,
				organizationId: ORG,
				featureKey: "chat-agent",
				planEligible: true,
			},
		);
		expect(m.trackUsage).toHaveBeenCalledTimes(1);
		expect(m.getRegisteredAgentById).not.toHaveBeenCalled();
		await verified(events);
	});

	it("serves an instance in another organization under that organization", async () => {
		m.findInstance.mockResolvedValue({
			userId: "user-example-9",
			organizationId: "org-example-2",
		});
		m.getOrganizationMembership.mockResolvedValue(
			membership(null, "viewer"),
		);
		useModel(suggestingModel());

		const events = await run({
			agentId: "instance-example-1",
			entityType: "instance",
			formSnapshot: SNAPSHOT,
		});

		expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
		expect(m.getOrganizationMembership).toHaveBeenCalledWith(
			"org-example-2",
			USER,
		);
		expect(m.getAIModelWithMetadata).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ organizationId: "org-example-2" }),
		);
		expect(tools).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "instance-example-1",
				entityType: "instance",
				organizationId: "org-example-2",
			}),
		);
	});

	it("serves a registered organization agent to a member under the agent's organization, saving its suggestions", async () => {
		const agent = {
			id: "agent-example-1",
			scope: "ORGANIZATION",
			organizationId: "org-example-3",
			userId: "user-example-9",
		};
		m.getRegisteredAgentById.mockResolvedValue(agent);
		useModel(suggestingModel());

		const events = await run({
			agentId: "agent-example-1",
			entityType: "registered",
			formSnapshot: SNAPSHOT,
		});

		expect(m.getOrganizationMembership).toHaveBeenCalledWith(
			"org-example-3",
			USER,
		);
		expect(tools).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-example-1",
				entityType: "registered",
				organizationId: "org-example-3",
			}),
		);
		expect(m.getAIModelWithMetadata).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ organizationId: "org-example-3" }),
		);
		expect(m.createRegisteredAgentSuggestions).toHaveBeenCalledWith(
			expect.objectContaining({ agent }),
		);
		expect(toolResults(events)).toEqual([
			":agent_suggestion[]{sId=suggestion-example-1 kind=tools}",
		]);
		expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
	});

	it("resolves the model inside the caller's own interactive request", async () => {
		const seen: boolean[] = [];
		m.getAIModelWithMetadata.mockImplementationOnce(async () => {
			seen.push(
				isAiInteractiveRequestFor(USER),
				isAiImpersonatedRequest(),
			);
			model = suggestingModel();
			return {
				model,
				metadata: { provider: "OPENAI", modelString: "gpt-example" },
				trackUsage: m.trackUsage,
			};
		});

		await run(NEW_AGENT);

		expect(seen).toEqual([true, false]);
	});

	it("never marks an impersonated caller's turn as the member's own", async () => {
		const seen: boolean[] = [];
		m.getAIModelWithMetadata.mockImplementationOnce(async () => {
			seen.push(
				isAiInteractiveRequestFor(USER),
				isAiImpersonatedRequest(),
			);
			model = suggestingModel();
			return {
				model,
				metadata: { provider: "OPENAI", modelString: "gpt-example" },
				trackUsage: m.trackUsage,
			};
		});

		await run(NEW_AGENT, {
			caller: {
				...CALLER,
				audit: {
					session: {
						id: "session-example-1",
						impersonatedBy: "admin-example-1",
					},
				},
			},
		});

		expect(seen).toEqual([false, true]);
	});

	it("sends a second run's history to the model as the route does, with the route's cache markers", async () => {
		const { reference, agUi } = await scriptedReply();
		const anthropic = {
			provider: "ANTHROPIC_DIRECT",
			modelString: "claude-sonnet-5-5",
		};
		const follow = "Rename the agent";

		const runtimeModel = useModel(suggestingModel(), anthropic);
		await run(NEW_AGENT, {
			messages: [
				...agUi,
				{ id: "user-2", role: "user", content: follow },
			],
		});

		const routeModel = useModel(suggestingModel(), anthropic);
		const routeHistory: UIMessage[] = [
			...reference,
			{
				id: "user-2",
				role: "user",
				parts: [{ type: "text", text: follow }],
			},
		];
		const result = await streamSidekickTurn({
			userId: USER,
			agentId: "new",
			entityType: "new",
			organizationId: ORG,
			messages: routeHistory,
			formSnapshot: SNAPSHOT,
		});
		await result.consumeStream();

		const runtimePrompts = runtimeModel.doStreamCalls.map(
			(call) => call.prompt,
		);
		const routePrompts = routeModel.doStreamCalls.map(
			(call) => call.prompt,
		);
		expect(runtimePrompts).toHaveLength(2);
		expect(runtimePrompts[0]).toEqual(routePrompts[0]);
		expect(JSON.stringify(runtimePrompts[0])).toContain(
			"sidekick_apply_tools",
		);
		// Step 2 keeps the history marker and rolls one over this turn's tool round.
		const marked = (runtimePrompts[1] ?? []).flatMap((message, index) =>
			message.providerOptions?.anthropic?.cacheControl ? [index] : [],
		);
		expect(marked.at(-1)).toBe((runtimePrompts[1]?.length ?? 0) - 1);
		expect(runtimePrompts[1]?.at(-1)?.role).toBe("tool");
		expect(marked.length).toBeGreaterThanOrEqual(3);
	});
});

describe("SidekickEngine failures", () => {
	it("ends a usage limit met while resolving the model with its limits", async () => {
		m.getAIModelWithMetadata.mockRejectedValueOnce(usageLimit());

		const events = await run(NEW_AGENT);

		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: "AI_USAGE_LIMIT_EXCEEDED",
			metadata: {
				fabric: {
					data: { limitId: "limit-1", used: "100", max: "100" },
				},
			},
		});
		expect(tools).not.toHaveBeenCalled();
	});

	it("sends step 1, then ends a usage limit met before step 2 with its limits", async () => {
		let checks = 0;
		const limited = wrapModelWithUsageLimits(
			suggestingModel(),
			async () => {
				checks += 1;
				if (checks > 1) {
					throw usageLimit();
				}
			},
		);
		m.getAIModelWithMetadata.mockResolvedValueOnce({
			model: limited,
			metadata: { provider: "OPENAI", modelString: "gpt-example" },
			trackUsage: m.trackUsage,
		});

		const events = await run(NEW_AGENT);

		expect(
			events.flatMap((event) =>
				event.type === EventType.TEXT_MESSAGE_CONTENT
					? [event.delta]
					: [],
			),
		).toEqual(["Adding a tool."]);
		expect(toolResults(events)).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: "AI_USAGE_LIMIT_EXCEEDED",
			metadata: { fabric: { data: { limitId: "limit-1" } } },
		});
		expect(
			events.some((event) => event.type === EventType.RUN_FINISHED),
		).toBe(false);
	});

	it.each([
		[
			"a ChatGPT plan that needs reconnecting",
			new ChatGptPlanAuthError(
				"refresh token reused",
				"refresh_token_reused",
				true,
			),
			{
				code: "CHATGPT_PLAN_UNAVAILABLE",
				metadata: { fabric: { status: 409 } },
			},
		],
		[
			"a model the ChatGPT plan does not serve",
			new ChatGptPlanModelNotServedError("model-example"),
			{
				code: "CHATGPT_PLAN_MODEL_NOT_SERVED",
				metadata: { fabric: { status: 409 } },
			},
		],
		[
			"a spent ChatGPT plan",
			new SubscriptionPlanExhaustedError(
				"Your ChatGPT plan has no usage left until 15:00.",
				new Date("2026-10-30T15:00:00.000Z"),
			),
			{
				code: "subscription_sharing_usage_limit_exceeded",
				metadata: {
					fabric: {
						status: 429,
						resetAt: "2026-10-30T15:00:00.000Z",
					},
				},
			},
		],
	])("ends %s with the route's refusal", async (_label, error, expected) => {
		m.getAIModelWithMetadata.mockRejectedValueOnce(error);

		const events = await run(NEW_AGENT);

		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			...expected,
		});
	});

	it("answers a tool that throws with the route's masked error, and goes on", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		m.getRegisteredAgentById.mockResolvedValue({
			id: "agent-example-1",
			scope: "USER",
			organizationId: null,
			userId: USER,
		});
		m.createRegisteredAgentSuggestions.mockRejectedValue(
			new Error("Example write failure"),
		);
		useModel(suggestingModel());

		const events = await run({
			agentId: "agent-example-1",
			entityType: "registered",
			formSnapshot: SNAPSHOT,
		});

		expect(toolResults(events)).toEqual(["An error occurred."]);
		expect(JSON.stringify(events)).not.toContain("Example write failure");
		expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
		expect(model.doStreamCalls).toHaveLength(2);
	});

	it("stops the model call on stop, and ends the run", async () => {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = new MockLanguageModelV4({
			doStream: async () => ({
				stream: new ReadableStream<ModelChunk>({
					async start(controller) {
						controller.enqueue({
							type: "stream-start",
							warnings: [],
						});
						controller.enqueue({ type: "text-start", id: "t1" });
						controller.enqueue({
							type: "text-delta",
							id: "t1",
							delta: "Working",
						});
						await held;
					},
				}),
			}),
		});
		useModel(slow);
		const engine = new SidekickEngine(CALLER);
		const stream = collector();

		const running = engine.run(
			{ threadId: THREAD, input: input(NEW_AGENT) },
			stream,
		);
		await vi.waitFor(() =>
			expect(
				stream.events.some(
					(event) => event.type === EventType.TEXT_MESSAGE_CONTENT,
				),
			).toBe(true),
		);
		expect(await engine.isRunning(THREAD)).toBe(true);

		expect(await engine.stop(THREAD)).toBe(true);
		await running;
		release();

		expect(slow.doStreamCalls[0]?.abortSignal?.aborted).toBe(true);
		expect(stream.events.at(-2)).toMatchObject({
			type: EventType.TEXT_MESSAGE_END,
		});
		expect(stream.events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
		});
		expect(await engine.isRunning(THREAD)).toBe(false);
	});
});
