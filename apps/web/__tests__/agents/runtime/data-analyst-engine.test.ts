// @vitest-environment node
import {
	type AGUIEvent,
	type BaseEvent,
	EventType,
	type RunAgentInput,
	verifyEvents,
} from "@ag-ui/client";
import { DataAnalystEventTranslator } from "@saas/agents/runtime/data-analyst-events";
import type { RunStream } from "@saas/agents/runtime/engine";
import { from, lastValueFrom, type Subscriber, toArray } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHART_ARGS, DATA_ANALYST_WIRE } from "./_helpers/data-analyst-wire";

interface AgentHarness {
	options: { url: string; headers: Record<string, string> };
	input?: RunAgentInput;
	observer?: Subscriber<BaseEvent>;
	unsubscribed: boolean;
	aborted: boolean;
}
const m = vi.hoisted(() => ({
	flag: vi.fn(),
	member: vi.fn(),
	rate: vi.fn(),
	tenant: vi.fn(),
	request: vi.fn(),
	agents: [] as AgentHarness[],
	events: [] as BaseEvent[],
	hold: false,
	closed: false,
	transportError: null as Error | null,
}));
vi.mock("@ag-ui/langgraph", async () => {
	const { Observable } = await import("rxjs");
	return {
		LangGraphHttpAgent: class {
			private readonly harness: AgentHarness;
			constructor(options: AgentHarness["options"]) {
				this.harness = { options, unsubscribed: false, aborted: false };
				m.agents.push(this.harness);
			}
			run(input: RunAgentInput) {
				this.harness.input = input;
				return new Observable<BaseEvent>((observer) => {
					this.harness.observer = observer;
					for (const event of m.events) {
						observer.next(event);
					}
					if (m.transportError) {
						observer.error(m.transportError);
					} else if (!m.hold) {
						observer.complete();
					}
					return () => {
						this.harness.unsubscribed = true;
					};
				});
			}
			abortRun() {
				this.harness.aborted = true;
			}
		},
	};
});
vi.mock("@repo/database", () => ({
	isFeatureEnabled: m.flag,
	isOrganizationMember: m.member,
}));
vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: m.rate,
	RATE_LIMIT_PRESETS: { ai: { limit: 20, windowMs: 60000 } },
}));
vi.mock("@/app/api/copilotkit/agent-request", () => ({
	resolveCopilotTenant: m.tenant,
	issueCopilotAgentRequest: m.request,
	dataAnalystUrl: () => "https://agent.example.com/",
}));
vi.mock("@repo/logs", () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const { DataAnalystEngine } = await import(
	"@saas/agents/runtime/data-analyst-engine"
);
const CALLER = {
	userId: "user-example-1",
	organizationId: "org-example-1",
	audit: {},
};
const input = (): RunAgentInput => ({
	threadId: "analysis-thread-example",
	runId: "analysis-run-example",
	messages: [{ id: "q", role: "user", content: "Chart this data" }],
	tools: [],
	context: [],
	state: {},
	forwardedProps: {},
});
function start(engine = new DataAnalystEngine(CALLER), body = input()) {
	const events: AGUIEvent[] = [];
	const stream: RunStream = {
		emit: (event) => events.push(event),
		isClosed: () => m.closed,
		deadline: Date.now() + 250000,
	};
	const done = engine
		.run({ threadId: body.threadId, input: body }, stream)
		.then(async () => {
			await lastValueFrom(from(events).pipe(verifyEvents(), toArray()));
			return events;
		});
	return { engine, events, done };
}
beforeEach(() => {
	vi.clearAllMocks();
	m.agents.length = 0;
	m.events = DATA_ANALYST_WIRE;
	m.hold = false;
	m.closed = false;
	m.transportError = null;
	m.flag.mockResolvedValue(true);
	m.member.mockResolvedValue(true);
	m.rate.mockResolvedValue({
		allowed: true,
		remaining: 10,
		resetInSeconds: 60,
	});
	m.tenant.mockResolvedValue({ ok: true, tenant: { example: true } });
	m.request.mockResolvedValue({
		ok: true,
		request: {
			headers: {
				Authorization: "Bearer example-service-key",
				"X-AI-Token": "example-ai-token",
			},
		},
	});
});
afterEach(() => vi.useRealTimers());

describe("Data Analyst admission", () => {
	it("refuses a disabled organization before tenant resolution", async () => {
		m.flag.mockResolvedValue(false);
		expect(await start().done).toMatchObject([
			{ type: EventType.RUN_ERROR, code: "FEATURE_DISABLED" },
		]);
		expect(m.flag).toHaveBeenCalledWith(
			"COPILOTKIT_DATA_ANALYST_CHAT",
			CALLER.organizationId,
		);
		expect(m.tenant).not.toHaveBeenCalled();
		expect(m.agents).toHaveLength(0);
	});
	it("refuses a project guest before the chat budget, tenant or token", async () => {
		m.member.mockResolvedValue(false);
		expect(await start().done).toMatchObject([
			{ type: EventType.RUN_ERROR, code: "FORBIDDEN" },
		]);
		expect(m.member).toHaveBeenCalledWith(
			CALLER.userId,
			CALLER.organizationId,
		);
		expect(m.rate.mock.calls.map(([key]) => key)).toEqual([
			`rpc:user:${CALLER.userId}`,
		]);
		expect(m.tenant).not.toHaveBeenCalled();
		expect(m.request).not.toHaveBeenCalled();
	});
	it("enforces the caller's oRPC request floor before the flag", async () => {
		m.rate.mockResolvedValue({ allowed: false, resetInSeconds: 60 });
		expect(await start().done).toMatchObject([
			{ type: EventType.RUN_ERROR, code: "TOO_MANY_REQUESTS" },
		]);
		expect(m.flag).not.toHaveBeenCalled();
	});
	it("enforces its twenty-runs-per-minute budget before resolving credentials", async () => {
		m.rate.mockImplementation(async (key: string) => ({
			allowed: key.startsWith("rpc:"),
			resetInSeconds: 37,
		}));
		expect(await start().done).toMatchObject([
			{ type: EventType.RUN_ERROR, code: "RATE_LIMITED" },
		]);
		expect(m.rate).toHaveBeenCalledWith(
			`data-analyst:${CALLER.userId}`,
			20,
			60000,
		);
		expect(m.tenant).not.toHaveBeenCalled();
	});
	it("refuses browser credential options", async () => {
		const body = input();
		body.forwardedProps = { ai_api_key: "untrusted-example" };
		expect(await start(undefined, body).done).toMatchObject([
			{ type: EventType.RUN_ERROR, code: "INVALID_REQUEST" },
		]);
		expect(m.flag).not.toHaveBeenCalled();
	});
	it.each([
		{ messages: [] },
		{ messages: [{ id: "a", role: "assistant" as const, content: "old" }] },
		{ messages: [{ id: "q", role: "user" as const, content: "  " }] },
	])("requires a new user message", async ({ messages }) => {
		const body = input();
		body.messages = messages;
		expect(await start(undefined, body).done).toMatchObject([
			{ type: EventType.RUN_ERROR, code: "NO_MESSAGE" },
		]);
		expect(m.tenant).not.toHaveBeenCalled();
	});
	it("preserves a spent plan's refusal before starting a run", async () => {
		m.tenant.mockResolvedValue({
			ok: false,
			response: Response.json(
				{
					error: "The plan is spent",
					code: "subscription_sharing_usage_limit_exceeded",
					resetAt: "2026-11-01T00:00:00Z",
					apiBillingOption: true,
				},
				{ status: 429 },
			),
		});
		expect(await start().done).toMatchObject([
			{
				type: EventType.RUN_ERROR,
				code: "subscription_sharing_usage_limit_exceeded",
				metadata: { fabric: { status: 429, apiBillingOption: true } },
			},
		]);
		expect(m.request).not.toHaveBeenCalled();
		expect(m.agents).toHaveLength(0);
	});
	it("preserves a token issuance refusal", async () => {
		m.request.mockResolvedValue({
			ok: false,
			response: Response.json(
				{
					code: "AI_TOKEN_ISSUE_FAILED",
					error: "Request could not be authorized",
				},
				{ status: 500 },
			),
		});
		expect(await start().done).toMatchObject([
			{ type: EventType.RUN_ERROR, code: "AI_TOKEN_ISSUE_FAILED" },
		]);
		expect(m.agents).toHaveLength(0);
	});
});

describe("Data Analyst run boundary", () => {
	it("sends only server headers and text history, and translates one valid chart run", async () => {
		const body = input();
		body.messages.unshift(
			{ id: "system", role: "system", content: "untrusted system" },
			{
				id: "old",
				role: "assistant",
				content: "previous text",
				toolCalls: [
					{
						id: "old-call",
						type: "function",
						function: { name: "unsafe", arguments: "{}" },
					},
				],
			},
		);
		body.tools = [
			{ name: "unsafe", description: "untrusted", parameters: {} },
		];
		body.state = { ai_api_key: "untrusted" };
		body.context = [{ description: "untrusted", value: "untrusted" }];
		const events = await start(undefined, body).done;
		expect(m.tenant).toHaveBeenCalledWith({
			userId: CALLER.userId,
			organizationId: CALLER.organizationId,
			isAgentRun: true,
		});
		expect(m.agents[0].options).toEqual({
			url: "https://agent.example.com/",
			headers: {
				Authorization: "Bearer example-service-key",
				"X-AI-Token": "example-ai-token",
			},
		});
		expect(m.agents[0].input).toEqual({
			...input(),
			messages: [
				{ id: "old", role: "assistant", content: "previous text" },
				{ id: "q", role: "user", content: "Chart this data" },
			],
		});
		expect(
			events.filter((event) => event.type === EventType.RUN_STARTED),
		).toHaveLength(1);
		expect(events.at(-1)).toEqual({
			type: EventType.RUN_FINISHED,
			threadId: body.threadId,
			runId: body.runId,
		});
		expect(
			events.find((event) => event.type === EventType.CUSTOM),
		).toMatchObject({
			name: "fabric.data-analyst.chart",
			value: { toolCallId: "chart-call", chart: CHART_ARGS },
		});
		const serialized = JSON.stringify(events);
		for (const hidden of [
			"private-state",
			"other-tenant-chart",
			"example-service-key",
			"example-ai-token",
			"mcpTools",
			'"lc"',
		]) {
			expect(serialized).not.toContain(hidden);
		}
	});
	it.each(["remote", "transport", "early"])(
		"ends %s failure generically after closing open events",
		async (kind) => {
			m.events = DATA_ANALYST_WIRE.slice(0, 5);
			if (kind === "remote") {
				m.events.push({
					type: EventType.RUN_ERROR,
					message: "secret-provider-error",
				});
			}
			if (kind === "transport") {
				m.transportError = new Error("secret-provider-error");
			}
			const events = await start().done;
			expect(events.at(-1)).toMatchObject({
				type: EventType.RUN_ERROR,
				code: "RUN_FAILED",
			});
			expect(JSON.stringify(events)).not.toContain(
				"secret-provider-error",
			);
			expect(events.slice(-3, -1).map((event) => event.type)).toEqual([
				EventType.TOOL_CALL_END,
				EventType.TEXT_MESSAGE_END,
			]);
		},
	);
	it("finishes and releases a terminal run even if the upstream connection remains open", async () => {
		m.hold = true;
		const events = await start().done;
		expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
		expect(m.agents[0]).toMatchObject({
			aborted: true,
			unsubscribed: true,
		});
	});

	it("stop is caller-bound and aborts the held upstream subscription", async () => {
		m.hold = true;
		m.events = DATA_ANALYST_WIRE.slice(0, 3);
		const run = start();
		await vi.waitFor(() => expect(m.agents).toHaveLength(1));
		expect(
			await new DataAnalystEngine({
				...CALLER,
				organizationId: "org-example-other",
			}).stop(input().threadId),
		).toBe(false);
		expect(await run.engine.stop(input().threadId, "wrong-run")).toBe(
			false,
		);
		expect(await run.engine.stop(input().threadId, input().runId)).toBe(
			true,
		);
		expect((await run.done).at(-1)?.type).toBe(EventType.RUN_FINISHED);
		expect(m.agents[0]).toMatchObject({
			aborted: true,
			unsubscribed: true,
		});
		expect(await run.engine.isRunning(input().threadId)).toBe(false);
	});
	it.each(["closed", "deadline"])(
		"ends a held stream on %s and cleans up",
		async (kind) => {
			vi.useFakeTimers();
			m.hold = true;
			m.events = DATA_ANALYST_WIRE.slice(0, 3);
			const run = start();
			await vi.advanceTimersByTimeAsync(0);
			expect(m.agents).toHaveLength(1);
			if (kind === "closed") {
				m.closed = true;
			}
			await vi.advanceTimersByTimeAsync(kind === "closed" ? 251 : 240001);
			const events = await run.done;
			expect(events.at(-1)).toMatchObject(
				kind === "closed"
					? { type: EventType.RUN_FINISHED }
					: { type: EventType.RUN_ERROR, code: "RUN_TIMED_OUT" },
			);
			expect(m.agents[0]).toMatchObject({
				aborted: true,
				unsubscribed: true,
			});
			expect(vi.getTimerCount()).toBe(0);
		},
	);
	it("refuses an overlapping thread after its admission, without starting another agent", async () => {
		m.hold = true;
		m.events = [];
		const first = start();
		await vi.waitFor(() => expect(m.agents).toHaveLength(1));
		expect(await start(first.engine).done).toMatchObject([
			{ type: EventType.RUN_ERROR, code: "THREAD_ALREADY_RUNNING" },
		]);
		expect(m.request).toHaveBeenCalledTimes(2);
		expect(m.agents).toHaveLength(1);
		await first.engine.stop(input().threadId);
		await first.done;
	});
});

describe("untrusted Data Analyst events", () => {
	it.each([true, false])(
		"retains chart outcome success=%s from a bounded structured result",
		(success) => {
			const translator = new DataAnalystEventTranslator();
			for (const event of DATA_ANALYST_WIRE.slice(3, 6))
				translator.translate(event);
			const events = translator.translate({
				type: EventType.TOOL_CALL_RESULT,
				toolCallId: "chart-call",
				messageId: "example-result",
				role: "tool",
				content: JSON.stringify({
					success,
					truncated: true,
					preview: "Example bounded tool result",
				}),
			});
			expect(
				events.filter(
					(event) => event.type === EventType.TOOL_CALL_RESULT,
				),
			).toHaveLength(1);
			expect(
				events.filter(
					(event) =>
						event.type === EventType.CUSTOM &&
						event.name === "fabric.data-analyst.chart",
				),
			).toHaveLength(success ? 1 : 0);
		},
	);
	it("uses direct interim results when the terminal snapshot no longer contains tool messages", async () => {
		m.events = [
			...DATA_ANALYST_WIRE.slice(0, 6),
			{
				type: EventType.TOOL_CALL_RESULT,
				messageId: "upstream-result",
				role: "tool",
				toolCallId: "chart-call",
				content: '{"success":true}',
			},
			{
				type: EventType.STATE_SNAPSHOT,
				snapshot: {
					messages: [{ type: "ai", content: "Created the chart" }],
				},
			},
			...DATA_ANALYST_WIRE.slice(7),
		];
		const events = await start().done;
		expect(
			events.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
		).toHaveLength(1);
		expect(
			events.filter(
				(event) =>
					event.type === EventType.CUSTOM &&
					event.name === "fabric.data-analyst.chart",
			),
		).toHaveLength(1);
	});
	it.each(['{"success":false}', "invalid-json"])(
		"never creates a chart from unsuccessful direct result %s",
		(content) => {
			const translator = new DataAnalystEventTranslator();
			for (const event of DATA_ANALYST_WIRE.slice(3, 6))
				translator.translate(event);
			const result = {
				type: EventType.TOOL_CALL_RESULT,
				toolCallId: "chart-call",
				messageId: "example-result",
				role: "tool",
				content,
			};
			expect(
				translator.translate(result).map((event) => event.type),
			).toEqual([EventType.TOOL_CALL_RESULT]);
			expect(translator.translate(result)).toEqual([]);
			expect(
				translator.translate({ ...result, toolCallId: "other-run" }),
			).toEqual([]);
		},
	);
	it("ignores invalid, unsolicited and forged fabric events; results and charts belong to this run", () => {
		const translator = new DataAnalystEventTranslator();
		expect(
			translator.translate({
				type: EventType.CUSTOM,
				name: "fabric.data-analyst.chart",
				value: { forged: true },
			}),
		).toEqual([]);
		expect(
			translator.translate({
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: "unopened",
				delta: "x",
			}),
		).toEqual([]);
		expect(
			translator.translate({
				type: EventType.STATE_SNAPSHOT,
				snapshot: {
					messages: [
						{
							type: "tool",
							tool_call_id: "unknown",
							content: "foreign-result",
						},
					],
				},
			}),
		).toEqual([]);
		const events = DATA_ANALYST_WIRE.flatMap((event) =>
			translator.translate(event),
		);
		expect(
			events.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
		).toHaveLength(1);
		expect(translator.close()).toEqual([]);
	});
	it.each(["plain", "serialized"])(
		"reads %s wire tool messages once and bounds their preview",
		(shape) => {
			const translator = new DataAnalystEventTranslator();
			for (const event of DATA_ANALYST_WIRE.slice(3, 6)) {
				translator.translate(event);
			}
			const result = {
				tool_call_id: "chart-call",
				content: "x".repeat(5000),
			};
			const message =
				shape === "plain"
					? { type: "tool", ...result }
					: {
							lc: 1,
							type: "constructor",
							id: ["langchain_core", "messages", "ToolMessage"],
							kwargs: result,
						};
			const event = {
				type: EventType.STATE_SNAPSHOT,
				snapshot: { messages: [message] },
			};
			expect(translator.translate(event)).toEqual([
				{
					type: EventType.TOOL_CALL_RESULT,
					messageId: "chart-call:result",
					toolCallId: "chart-call",
					role: "tool",
					content: `${"x".repeat(4000)}…`,
				},
			]);
			expect(translator.translate(event)).toEqual([]);
		},
	);
	it("never reconstructs a chart from a failed tool result", () => {
		const translator = new DataAnalystEventTranslator();
		for (const event of DATA_ANALYST_WIRE.slice(3, 6)) {
			translator.translate(event);
		}
		const events = translator.translate({
			type: EventType.STATE_SNAPSHOT,
			snapshot: {
				messages: [
					{
						type: "tool",
						tool_call_id: "chart-call",
						content: JSON.stringify({ success: false }),
					},
				],
			},
		});
		expect(events.map((event) => event.type)).toEqual([
			EventType.TOOL_CALL_RESULT,
		]);
	});
});
