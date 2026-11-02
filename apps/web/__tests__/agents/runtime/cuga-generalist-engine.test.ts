// @vitest-environment node
/**
 * The runtime's `cuga-generalist` engine: the A2A relay `POST
 * /api/agents/a2a/send` runs, with the reply as runtime events.
 *
 *   - refused before RUN_STARTED, with no lookup, model, token or send,
 *     while `COPILOTKIT_CUGA_CHAT` is off (`FEATURE_DISABLED`), for invalid
 *     props (`INVALID_REQUEST`) or no new question (`NO_MESSAGE`); then, in
 *     the route's order and with its texts, for a missing SYSTEM agent
 *     (`NOT_FOUND`), an endpoint the guard rejects (`AGENT_ENDPOINT_REFUSED`)
 *     and a caller who is not a member (`FORBIDDEN`), none with a model or
 *     token;
 *   - the model and AI token are the route's: the person's interactive
 *     work, a plan with no base URL, an impersonated token while an admin
 *     acts as the member; a usage limit ends the run with its limits and
 *     sends nothing, any other token failure sends no AI config;
 *   - the message goes to the SYSTEM agent's URL with the tenant context
 *     only, the conversation so far as its history and the chat's
 *     conversation id;
 *   - the reply arrives as the conversation id, the reasoning, one
 *     assistant message with the agent's tool calls, then the artifacts,
 *     and passes AG-UI's `verifyEvents`; the route's fallbacks apply;
 *   - a stop, or the client going away, ends the request and the run with
 *     no answer; the relay deadline and any other failure end it with a
 *     generic failure that never names the agent's URL;
 *   - the engine takes the A2A client from `@repo/agent-core/a2a`, so the
 *     runtime route never loads the package root.
 */
import {
	type AGUIEvent,
	type BaseEvent,
	EventType,
	type RunAgentInput,
	verifyEvents,
} from "@ag-ui/client";
import type { RunStream, RuntimeCaller } from "@saas/agents/runtime/engine";
import { from, lastValueFrom, toArray } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	getActiveSystemRegisteredAgent: vi.fn(),
	isOrganizationMember: vi.fn(),
	clientOptions: vi.fn(),
	sendMessageSecure: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	getRAGProviderConfigForModel: vi.fn(),
	buildEffectiveBaseUrl: vi.fn(),
	issueAIToken: vi.fn(),
	checkRateLimit: vi.fn(),
	/** Set once anything in the engine's graph loads the package root. */
	agentCoreRootLoaded: false,
	/** What the agent answers. */
	task: {} as unknown,
	/** Holds the send until released, or until its signal aborts. */
	hold: null as null | {
		reach: () => void;
		gate: Promise<void>;
	},
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: (...args: unknown[]) => m.isFeatureEnabled(...args),
	getActiveSystemRegisteredAgent: (...args: unknown[]) =>
		m.getActiveSystemRegisteredAgent(...args),
	isOrganizationMember: (...args: unknown[]) =>
		m.isOrganizationMember(...args),
}));
vi.mock("@repo/agent-core", () => {
	m.agentCoreRootLoaded = true;
	return {};
});
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
	getAIModelWithMetadata: (...args: unknown[]) =>
		m.getAIModelWithMetadata(...args),
	getRAGProviderConfigForModel: (...args: unknown[]) =>
		m.getRAGProviderConfigForModel(...args),
	buildEffectiveBaseUrl: (...args: unknown[]) =>
		m.buildEffectiveBaseUrl(...args),
}));
vi.mock("@repo/ai-token", () => ({
	issueAIToken: (...args: unknown[]) => m.issueAIToken(...args),
}));
vi.mock("@repo/payments", async () => ({
	AiUsageLimitExceededError: (
		await import("@repo/payments/lib/ai-usage-limit-error")
	).AiUsageLimitExceededError,
}));
vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: (...args: unknown[]) => m.checkRateLimit(...args),
}));

const { CUGA_RELAY_DEADLINE_MS, CugaGeneralistEngine } = await import(
	"@saas/agents/runtime/cuga-generalist-engine"
);
const { AiUsageLimitExceededError } = await import(
	"@repo/payments/lib/ai-usage-limit-error"
);

const AGENT_URL = "https://agent.example.com";
const THREAD = "thread-example-0001";
const RUN = "run-example-0001";
const CALLER: RuntimeCaller = {
	userId: "user-example-1",
	organizationId: "org-example-1",
	audit: { session: { id: "s" } },
};
const CONVERSATION: RunAgentInput["messages"] = [
	{ id: "m-1", role: "user", content: "What is in the plan?" },
	{ id: "m-2", role: "assistant", content: "A launch." },
	{ id: "m-3", role: "user", content: "When does it ship?" },
];
const HISTORY = [
	{ role: "user", content: "What is in the plan?" },
	{ role: "assistant", content: "A launch." },
];

function input(
	forwardedProps: unknown = {
		agentId: "cuga_generalist",
		contextId: "ctx-example-1",
	},
	messages = CONVERSATION,
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

function collector(): RunStream & {
	events: AGUIEvent[];
	/** The client goes away. */
	close: () => void;
} {
	const events: AGUIEvent[] = [];
	let closed = false;
	return {
		events,
		emit: (event) => events.push(event),
		isClosed: () => closed,
		close: () => {
			closed = true;
		},
		deadline: Date.now() + 60_000,
	};
}

async function run(
	request: RunAgentInput = input(),
	caller: RuntimeCaller = CALLER,
): Promise<AGUIEvent[]> {
	const stream = collector();
	await new CugaGeneralistEngine(caller).run(
		{ threadId: THREAD, input: request },
		stream,
	);
	return stream.events;
}

function verified(events: AGUIEvent[]): Promise<BaseEvent[]> {
	return lastValueFrom(
		from(events as BaseEvent[]).pipe(verifyEvents(false), toArray()),
	);
}

/** The send waits here until released or aborted. */
function holdSend(): { reached: Promise<void>; release: () => void } {
	let reach = () => {};
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	m.hold = { reach, gate };
	return { reached, release: () => release() };
}

function sentOptions(): Record<string, unknown> {
	return m.sendMessageSecure.mock.calls[0]?.[3];
}

function typesOf(events: AGUIEvent[]): EventType[] {
	return events.map((event) => event.type);
}

function textOf(events: AGUIEvent[]): string[] {
	return events.flatMap((event) =>
		event.type === EventType.TEXT_MESSAGE_CONTENT ? [event.delta] : [],
	);
}

function contextOf(events: AGUIEvent[]): unknown {
	const context = events.find(
		(event) =>
			event.type === EventType.CUSTOM &&
			event.name === "fabric.cuga-generalist.context",
	);
	return context?.type === EventType.CUSTOM ? context.value : undefined;
}

function resolvesTo(provider: string) {
	m.getAIModelWithMetadata.mockResolvedValue({
		metadata: { modelString: "model-example", provider },
		trackUsage: () => {},
	});
}

function expectNothingResolvedOrSent() {
	expect(m.getAIModelWithMetadata).not.toHaveBeenCalled();
	expect(m.issueAIToken).not.toHaveBeenCalled();
	expect(m.sendMessageSecure).not.toHaveBeenCalled();
}

beforeEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.stubEnv("AGENT_DISCOVERY_ALLOWED_HOSTS", "");
	m.hold = null;
	m.task = {
		id: "task-1",
		contextId: "ctx-agent-1",
		status: "completed",
		messages: [
			{ role: "agent", parts: [{ type: "text", text: "In May." }] },
		],
	};
	m.checkRateLimit.mockResolvedValue({
		allowed: true,
		remaining: 999,
		resetInSeconds: 60,
	});
	m.isFeatureEnabled.mockResolvedValue(true);
	m.getActiveSystemRegisteredAgent.mockResolvedValue({
		deploymentUrl: AGENT_URL,
	});
	m.isOrganizationMember.mockResolvedValue(true);
	resolvesTo("AZURE_AI_FOUNDRY");
	m.getRAGProviderConfigForModel.mockResolvedValue({
		baseUrl: "https://org-gateway.example.com",
	});
	m.buildEffectiveBaseUrl.mockImplementation(
		(_provider: string, custom?: string) =>
			custom ?? "https://provider.example.com",
	);
	m.issueAIToken.mockResolvedValue("ai-token");
	m.sendMessageSecure.mockImplementation(
		async (
			_url: string,
			_message: unknown,
			_tenant: unknown,
			options: { signal?: AbortSignal },
		) => {
			const { signal } = options;
			if (m.hold) {
				const { reach, gate } = m.hold;
				await new Promise<void>((resolve, reject) => {
					signal?.addEventListener(
						"abort",
						() => reject(signal.reason),
						{
							once: true,
						},
					);
					gate.then(resolve);
					reach();
				});
			}
			if (signal?.aborted) {
				throw signal.reason;
			}
			return m.task;
		},
	);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("the cuga-generalist engine's imports", () => {
	it("never loads the @repo/agent-core package root, which the runtime route would then load for every agent", () => {
		expect(CugaGeneralistEngine).toBeDefined();
		expect(m.agentCoreRootLoaded).toBe(false);
	});
});

describe("the cuga-generalist engine's admission", () => {
	it("refuses while COPILOTKIT_CUGA_CHAT is off for the caller's organization, before any lookup", async () => {
		m.isFeatureEnabled.mockResolvedValue(false);

		const events = await run();

		expect(events).toEqual([
			{
				type: EventType.RUN_ERROR,
				code: "FEATURE_DISABLED",
				message:
					"The CUGA chat is not enabled on the agent runtime for this organization.",
			},
		]);
		expect(m.isFeatureEnabled).toHaveBeenCalledWith(
			"COPILOTKIT_CUGA_CHAT",
			"org-example-1",
		);
		expect(m.getActiveSystemRegisteredAgent).not.toHaveBeenCalled();
		expectNothingResolvedOrSent();
	});

	it.each([{}, { agentId: "  " }, { agentId: 123 }])(
		"refuses invalid props %j before any lookup",
		async (forwardedProps) => {
			const events = await run(input(forwardedProps));

			expect(events).toEqual([
				expect.objectContaining({
					type: EventType.RUN_ERROR,
					code: "INVALID_REQUEST",
				}),
			]);
			expect(m.getActiveSystemRegisteredAgent).not.toHaveBeenCalled();
			expectNothingResolvedOrSent();
		},
	);

	it.each([
		["an assistant's last message", CONVERSATION.slice(0, 2)],
		[
			"a blank question",
			[
				...CONVERSATION,
				{ id: "m-4", role: "user" as const, content: "  " },
			],
		],
	])("refuses %s before any lookup", async (_case, messages) => {
		const events = await run(input(undefined, messages));

		expect(events).toEqual([
			{
				type: EventType.RUN_ERROR,
				code: "NO_MESSAGE",
				message: "A run needs a new user message.",
			},
		]);
		expect(m.getActiveSystemRegisteredAgent).not.toHaveBeenCalled();
		expectNothingResolvedOrSent();
	});

	it.each([null, { deploymentUrl: null }])(
		"hides an agent it cannot find (%j) with no model or token",
		async (agent) => {
			m.getActiveSystemRegisteredAgent.mockResolvedValue(agent);

			const events = await run();

			expect(events).toEqual([
				{
					type: EventType.RUN_ERROR,
					code: "NOT_FOUND",
					message: "Agent not found",
				},
			]);
			expect(m.getActiveSystemRegisteredAgent).toHaveBeenCalledWith(
				"cuga_generalist",
			);
			expectNothingResolvedOrSent();
		},
	);

	it.each([
		["loopback", "http://127.0.0.1:8080"],
		[
			"link-local cloud metadata",
			"http://169.254.169.254/latest/meta-data",
		],
		["a private LAN address", "http://10.0.0.5:9000"],
	])(
		"refuses %s with the endpoint guard's text, and never sends",
		async (_label, deploymentUrl) => {
			m.getActiveSystemRegisteredAgent.mockResolvedValue({
				deploymentUrl,
			});

			const events = await run();

			expect(events).toEqual([
				{
					type: EventType.RUN_ERROR,
					code: "AGENT_ENDPOINT_REFUSED",
					message: expect.stringContaining("Agent endpoint rejected"),
				},
			]);
			expectNothingResolvedOrSent();
		},
	);

	it("refuses a caller who is not a member, however the endpoint let them in", async () => {
		// A project guest has a tie to the organization, which the endpoint
		// accepts; the route refuses one, and so does the engine.
		m.isOrganizationMember.mockResolvedValue(false);

		const events = await run();

		expect(events).toEqual([
			{
				type: EventType.RUN_ERROR,
				code: "FORBIDDEN",
				message:
					"Access denied: you are not a member of organization org-example-1",
			},
		]);
		expect(m.isOrganizationMember).toHaveBeenCalledWith(
			"user-example-1",
			"org-example-1",
		);
		expectNothingResolvedOrSent();
	});

	it("always checks membership", async () => {
		const events = await run();

		expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
		expect(m.isOrganizationMember).toHaveBeenCalledTimes(1);
	});
});

describe("the cuga-generalist engine's model and token", () => {
	it("resolves the model as the person's own interactive work", async () => {
		await run();

		expect(m.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "TOOL_CALLING" },
			expect.objectContaining({
				userId: "user-example-1",
				organizationId: "org-example-1",
				planEligible: true,
			}),
		);
	});

	it("hands the agent a plan-eligible token and no base URL when a plan serves it", async () => {
		resolvesTo("OPENAI_CHATGPT_PLAN");

		await run();

		expect(m.issueAIToken).toHaveBeenCalledWith({
			userId: "user-example-1",
			organizationId: "org-example-1",
			impersonated: false,
			source: "a2a-proxy",
			planEligible: true,
		});
		expect(sentOptions().aiConfig).toStrictEqual({
			token: "ai-token",
			model: "model-example",
			provider: "OPENAI_CHATGPT_PLAN",
			baseUrl: undefined,
		});
	});

	it("keeps the token off any plan, with the organization's base URL, when its provider serves it", async () => {
		await run();

		expect(m.issueAIToken).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "a2a-proxy",
				planEligible: false,
			}),
		);
		expect(sentOptions().aiConfig).toStrictEqual({
			token: "ai-token",
			model: "model-example",
			provider: "AZURE_AI_FOUNDRY",
			baseUrl: "https://org-gateway.example.com",
		});
	});

	it("marks the token impersonated while an admin acts as the member", async () => {
		await run(input(), {
			...CALLER,
			audit: { session: { id: "s", impersonatedBy: "admin-example-1" } },
		});

		expect(m.issueAIToken).toHaveBeenCalledWith(
			expect.objectContaining({
				impersonated: true,
				planEligible: false,
			}),
		);
	});

	it("ends a HARD usage limit at token issuance with its limits, and sends nothing", async () => {
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

		const events = await run();

		expect(typesOf(events)).toEqual([
			EventType.RUN_STARTED,
			EventType.RUN_ERROR,
		]);
		expect(events[1]).toMatchObject({
			code: "AI_USAGE_LIMIT_EXCEEDED",
			message: "AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
			metadata: {
				fabric: {
					data: {
						limitId: "limit-1",
						dimension: "TOKENS",
						window: "MONTHLY",
						used: "10",
						max: "10",
						manageLimitsUrl: "https://example.com/limits",
					},
				},
			},
		});
		expect(m.sendMessageSecure).not.toHaveBeenCalled();
	});

	it("goes on with no AI config when the token cannot be issued for another reason", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		m.issueAIToken.mockRejectedValue(new Error("token service down"));

		const events = await run();

		expect(sentOptions().aiConfig).toBeUndefined();
		expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
	});
});

describe("the cuga-generalist engine's send", () => {
	it("sends to the SYSTEM agent's URL with the tenant context only", async () => {
		await run();

		expect(m.clientOptions).toHaveBeenCalledWith({
			timeout: 120000,
			sourceAgent: "fabric-web",
		});
		const [url, message, tenant, options] =
			m.sendMessageSecure.mock.calls[0] ?? [];
		expect(url).toBe(AGENT_URL);
		expect(message).toStrictEqual({
			role: "user",
			parts: [{ type: "text", text: "When does it ship?" }],
			metadata: { history: HISTORY },
		});
		expect(tenant).toStrictEqual({
			userId: "user-example-1",
			organizationId: "org-example-1",
		});
		expect(Object.keys(options).sort()).toEqual([
			"aiConfig",
			"contextId",
			"metadata",
			"signal",
		]);
		expect(options.trustedDestination).not.toBe(true);
		expect(options).not.toHaveProperty("agentApiKey");
		expect(options.signal).toBeInstanceOf(AbortSignal);
		expect(options.contextId).toBe("ctx-example-1");
		expect(options.metadata).toBeUndefined();
	});

	it("sends the earlier messages as the history, without the question", async () => {
		await run(
			input(undefined, [
				{ id: "s-1", role: "system", content: "Be brief." },
				...CONVERSATION,
			]),
		);

		const message = m.sendMessageSecure.mock.calls[0]?.[1];
		expect(message.parts).toEqual([
			{ type: "text", text: "When does it ship?" },
		]);
		expect(message.metadata.history).toEqual(HISTORY);
	});

	it("sends no conversation id on a chat's first message", async () => {
		await run(input({ agentId: "cuga_generalist", contextId: null }));

		expect(sentOptions().contextId).toBeUndefined();
	});
});

describe("the cuga-generalist engine's reply", () => {
	it("streams the conversation id, the reasoning, the answer with its tool calls, then the artifacts", async () => {
		const artifacts = [
			{
				id: "artifact-1",
				name: "plan",
				mimeType: "application/json",
				parts: [
					{
						type: "data",
						data: {
							toolCalls: [
								{
									name: "search",
									args: { query: "ship date" },
									result: { hits: 1 },
								},
							],
						},
					},
				],
			},
		];
		m.task = {
			id: "task-1",
			contextId: "ctx-agent-1",
			status: "completed",
			messages: [
				{
					role: "agent",
					parts: [
						{ type: "text", text: "It ships in May." },
						{
							type: "data",
							data: { reasoning: "Checked the plan." },
						},
					],
				},
			],
			artifacts,
		};

		const events = await run();

		await expect(verified(events)).resolves.toHaveLength(events.length);
		expect(events).toEqual([
			{ type: EventType.RUN_STARTED, threadId: THREAD, runId: RUN },
			{
				type: EventType.CUSTOM,
				name: "fabric.cuga-generalist.context",
				value: { contextId: "ctx-agent-1" },
			},
			{ type: EventType.REASONING_START, messageId: `${RUN}:reasoning` },
			{
				type: EventType.REASONING_MESSAGE_START,
				messageId: `${RUN}:reasoning`,
				role: "reasoning",
			},
			{
				type: EventType.REASONING_MESSAGE_CONTENT,
				messageId: `${RUN}:reasoning`,
				delta: "Checked the plan.",
			},
			{
				type: EventType.REASONING_MESSAGE_END,
				messageId: `${RUN}:reasoning`,
			},
			{ type: EventType.REASONING_END, messageId: `${RUN}:reasoning` },
			{
				type: EventType.TEXT_MESSAGE_START,
				messageId: `${RUN}:answer`,
				role: "assistant",
			},
			{
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: `${RUN}:answer`,
				delta: "It ships in May.",
			},
			{
				type: EventType.TOOL_CALL_START,
				toolCallId: `${RUN}:tool:0`,
				toolCallName: "search",
				parentMessageId: `${RUN}:answer`,
			},
			{
				type: EventType.TOOL_CALL_ARGS,
				toolCallId: `${RUN}:tool:0`,
				delta: '{"query":"ship date"}',
			},
			{ type: EventType.TOOL_CALL_END, toolCallId: `${RUN}:tool:0` },
			{
				type: EventType.TOOL_CALL_RESULT,
				messageId: `${RUN}:tool:0:result`,
				toolCallId: `${RUN}:tool:0`,
				role: "tool",
				content: '{"hits":1}',
			},
			{ type: EventType.TEXT_MESSAGE_END, messageId: `${RUN}:answer` },
			{
				type: EventType.CUSTOM,
				name: "fabric.cuga-generalist.artifacts",
				value: { artifacts },
			},
			{ type: EventType.RUN_FINISHED, threadId: THREAD, runId: RUN },
		]);
	});

	it.each([
		[
			"the agent's",
			{ contextId: "ctx-agent-1" },
			"ctx-example-1",
			"ctx-agent-1",
		],
		[
			"the one sent, when the agent names none",
			{},
			"ctx-example-1",
			"ctx-example-1",
		],
		["none, on a first message the agent names none for", {}, null, null],
	])(
		"keeps the chat's conversation id: %s",
		async (_case, task, sent, expected) => {
			m.task = {
				id: "task-1",
				status: "completed",
				messages: [],
				...task,
			};

			const events = await run(
				input({ agentId: "cuga_generalist", contextId: sent }),
			);

			expect(contextOf(events)).toEqual({ contextId: expected });
		},
	);

	it("keeps the conversation id of a reply with no task id and an odd status", async () => {
		m.task = { contextId: "ctx-odd-1", status: 7, messages: [] };

		const events = await run();

		expect(contextOf(events)).toEqual({ contextId: "ctx-odd-1" });
		expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
	});

	it.each([
		[
			"a completed task with no text",
			{ status: "completed" },
			"Task completed successfully.",
		],
		[
			"a failed task, with its error",
			{
				status: "failed",
				metadata: { error: { message: "The agent gave up." } },
			},
			"The agent gave up.",
		],
		[
			"a failed task with no error",
			{ status: "failed" },
			"Task failed with unknown error.",
		],
	])("answers %s with the route's fallback", async (_case, task, answer) => {
		m.task = { id: "task-1", messages: [], ...task };

		const events = await run();

		expect(textOf(events)).toEqual([answer]);
	});

	it("drops malformed tool calls but still answers", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		m.task = {
			id: "task-1",
			status: "completed",
			messages: [
				{ role: "agent", parts: [{ type: "text", text: "Done." }] },
			],
			artifacts: [
				{
					id: "artifact-1",
					name: "calls",
					mimeType: "application/json",
					parts: [
						{ type: "data", data: { toolCalls: [{ name: 1 }] } },
					],
				},
			],
		};

		const events = await run();

		await expect(verified(events)).resolves.toHaveLength(events.length);
		expect(textOf(events)).toEqual(["Done."]);
		expect(
			events.some((event) => event.type === EventType.TOOL_CALL_START),
		).toBe(false);
		expect(warn).toHaveBeenCalled();
	});
});

describe("the cuga-generalist engine's ending", () => {
	it("ends the request and the run with no answer when stopped mid-send", async () => {
		const send = holdSend();
		const engine = new CugaGeneralistEngine(CALLER);
		const stream = collector();

		const running = engine.run(
			{ threadId: THREAD, input: input() },
			stream,
		);
		await send.reached;
		expect(await engine.stop(THREAD)).toBe(true);
		await running;

		expect(sentOptions().signal).toMatchObject({ aborted: true });
		expect(textOf(stream.events)).toEqual([]);
		expect(typesOf(stream.events)).toEqual([
			EventType.RUN_STARTED,
			EventType.RUN_FINISHED,
		]);
		await expect(verified(stream.events)).resolves.toHaveLength(2);
	});

	it("ends the request and the run with no answer when the client goes away mid-send", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const send = holdSend();
			const stream = collector();

			const running = new CugaGeneralistEngine(CALLER).run(
				{ threadId: THREAD, input: input() },
				stream,
			);
			await send.reached;
			stream.close();
			vi.advanceTimersByTime(250);
			await running;

			expect(sentOptions().signal).toMatchObject({ aborted: true });
			expect(typesOf(stream.events)).toEqual([
				EventType.RUN_STARTED,
				EventType.RUN_FINISHED,
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("ends an A2A failure with a generic failure that never names the agent's URL", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		m.sendMessageSecure.mockRejectedValue(
			new Error(
				`Network request to ${AGENT_URL}/a2a failed after 3 attempt(s): ECONNREFUSED`,
			),
		);

		const events = await run();

		expect(events.at(-1)).toEqual({
			type: EventType.RUN_ERROR,
			code: "RUN_FAILED",
			message: "The reply failed. Please try again.",
		});
		expect(JSON.stringify(events)).not.toContain("agent.example.com");
		expect(log).toHaveBeenCalled();
	});

	it("ends a relay past its deadline with a failure, not a silent finish", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const deadline = new AbortController();
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(deadline.signal);
		const send = holdSend();
		const stream = collector();

		const running = new CugaGeneralistEngine(CALLER).run(
			{ threadId: THREAD, input: input() },
			stream,
		);
		await send.reached;
		deadline.abort(new DOMException("timed out", "TimeoutError"));
		await running;

		expect(CUGA_RELAY_DEADLINE_MS).toBe(250000);
		expect(timeout).toHaveBeenCalledWith(250000);
		expect(typesOf(stream.events)).toEqual([
			EventType.RUN_STARTED,
			EventType.RUN_ERROR,
		]);
		expect(stream.events[1]).toMatchObject({ code: "RUN_FAILED" });
		expect(textOf(stream.events)).toEqual([]);
	});
});
