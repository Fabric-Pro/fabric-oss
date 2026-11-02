/**
 * The CUGA chat's two transports (`cuga-chat-client.ts`), through a stubbed
 * `fetch`:
 *
 *   - the runtime asks the `cuga-generalist` agent in the organization on
 *     screen, on a new thread per message, with the SYSTEM agent and the
 *     agent's conversation in `forwardedProps` and the conversation so far
 *     as its messages; it reads the answer, the reasoning, the conversation
 *     id and the artifacts from the run's events;
 *   - a RUN_ERROR rejects with its message, a usage limit with the limits
 *     the shared toast shows; an HTTP refusal with its message; an abort as
 *     an AbortError; a reply that ends without finishing as lost;
 *   - the route keeps today's request body and error text, and lets go of
 *     its request with an AbortError as the runtime does.
 */
import { type AGUIEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { RequestReplyRunError } from "@saas/agents/lib/request-reply-outcome";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askCugaRoute, askCugaRuntime } from "../cuga-chat-client";

const RUNTIME_URL = "/api/agents/runtime/agent/cuga-generalist/run";

const USAGE_LIMIT = {
	limitId: "limit-1",
	dimension: "TOKENS",
	window: "MONTHLY",
	used: "10",
	max: "10",
	manageLimitsUrl: "https://example.com/limits",
};

const fetchMock = vi.fn<typeof fetch>();

/** A runtime response carrying `events` for the request's run. */
function sse(events: Array<Record<string, unknown>>): Response {
	return new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{ status: 200, headers: { "Content-Type": "text/event-stream" } },
	);
}

/** The run's events between RUN_STARTED and RUN_FINISHED, for its ids. */
function answering(events: Array<Record<string, unknown>>) {
	return async (_input: RequestInfo | URL, init?: RequestInit) => {
		const { threadId, runId } = JSON.parse(String(init?.body));
		return sse([
			{ type: EventType.RUN_STARTED, threadId, runId },
			...events,
			{ type: EventType.RUN_FINISHED, threadId, runId },
		]);
	};
}

/** A request held until its signal aborts, when `fetch` rejects. */
function heldUntilAborted(
	_input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	return new Promise<Response>((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () =>
			reject(
				Object.assign(new Error("The operation was aborted."), {
					name: "AbortError",
				}),
			),
		);
	});
}

function sentRun(call = 0): {
	url: string;
	init: RequestInit;
	input: RunAgentInput;
} {
	const [url, init] = fetchMock.mock.calls[call] ?? [];
	return {
		url: String(url),
		init: init ?? {},
		input: JSON.parse(String(init?.body)),
	};
}

const QUESTION = {
	agentId: "cuga_generalist",
	content: "When does it ship?",
	contextId: "ctx-example-1",
	history: [
		{ role: "user" as const, content: "What is in the plan?" },
		{ role: "assistant" as const, content: "A launch." },
	],
};

function askRuntime(signal = new AbortController().signal) {
	return askCugaRuntime({
		...QUESTION,
		organizationId: "org-example-1",
		signal,
	});
}

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("askCugaRuntime", () => {
	it("asks the cuga-generalist agent in the organization on screen and reads its whole reply", async () => {
		const artifacts = [{ id: "artifact-1", name: "plan", parts: [] }];
		fetchMock.mockImplementation(
			answering([
				{
					type: EventType.CUSTOM,
					name: "fabric.cuga-generalist.context",
					value: { contextId: "ctx-agent-2" },
				},
				{ type: EventType.REASONING_START, messageId: "r" },
				{
					type: EventType.REASONING_MESSAGE_START,
					messageId: "r",
					role: "reasoning",
				},
				{
					type: EventType.REASONING_MESSAGE_CONTENT,
					messageId: "r",
					delta: "Checked the plan.",
				},
				{ type: EventType.REASONING_MESSAGE_END, messageId: "r" },
				{ type: EventType.REASONING_END, messageId: "r" },
				{
					type: EventType.TEXT_MESSAGE_START,
					messageId: "a",
					role: "assistant",
				},
				{
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "a",
					delta: "It ships ",
				},
				{
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "a",
					delta: "in May.",
				},
				{ type: EventType.TEXT_MESSAGE_END, messageId: "a" },
				{
					type: EventType.CUSTOM,
					name: "fabric.cuga-generalist.artifacts",
					value: { artifacts },
				},
			]),
		);

		const reply = await askRuntime();

		expect(reply).toEqual({
			response: "It ships in May.",
			contextId: "ctx-agent-2",
			reasoning: "Checked the plan.",
			artifacts,
		});
		const { url, init, input } = sentRun();
		expect(url).toBe(RUNTIME_URL);
		expect(new Headers(init.headers).get("x-fabric-organization-id")).toBe(
			"org-example-1",
		);
		expect(input.forwardedProps).toEqual({
			agentId: "cuga_generalist",
			contextId: "ctx-example-1",
		});
		expect(
			input.messages.map(({ role, content }) => ({ role, content })),
		).toEqual([
			{ role: "user", content: "What is in the plan?" },
			{ role: "assistant", content: "A launch." },
			{ role: "user", content: "When does it ship?" },
		]);
	});

	it("runs each message on its own thread", async () => {
		fetchMock.mockImplementation(answering([]));

		await askRuntime();
		await askRuntime();

		expect(sentRun(0).input.threadId).not.toBe(sentRun(1).input.threadId);
	});

	it("keeps the conversation from a context event alone, and the one sent when none arrives", async () => {
		fetchMock.mockImplementationOnce(
			answering([
				{
					type: EventType.CUSTOM,
					name: "fabric.cuga-generalist.context",
					value: { contextId: "ctx-odd-1" },
				},
			]),
		);
		fetchMock.mockImplementationOnce(answering([]));

		expect((await askRuntime()).contextId).toBe("ctx-odd-1");
		expect((await askRuntime()).contextId).toBe("ctx-example-1");
	});

	it("rejects a failed run with its message and no usage limit", async () => {
		fetchMock.mockImplementation(async () =>
			sse([
				{ type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
				{
					type: EventType.RUN_ERROR,
					code: "RUN_FAILED",
					message: "The reply failed. Please try again.",
				},
			]),
		);

		const failure = await askRuntime().catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(RequestReplyRunError);
		expect(failure).toMatchObject({
			message: "The reply failed. Please try again.",
			code: "RUN_FAILED",
			usageLimit: null,
		});
	});

	it("rejects a usage limit with the limits the shared toast shows", async () => {
		fetchMock.mockImplementation(async () =>
			sse([
				{ type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
				{
					type: EventType.RUN_ERROR,
					code: "AI_USAGE_LIMIT_EXCEEDED",
					message: "AI usage limit exceeded",
					metadata: {
						fabric: {
							status: 429,
							code: "AI_USAGE_LIMIT_EXCEEDED",
							data: USAGE_LIMIT,
						},
					},
				},
			]),
		);

		const failure = await askRuntime().catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(RequestReplyRunError);
		expect(failure).toMatchObject({
			message: "AI usage limit exceeded",
			usageLimit: USAGE_LIMIT,
		});
	});

	it("rejects the endpoint's refusal with its message", async () => {
		fetchMock.mockResolvedValue(
			Response.json(
				{
					error: "Forbidden",
					message: "You are not a member of this organization",
				},
				{ status: 403 },
			),
		);

		await expect(askRuntime()).rejects.toThrow(
			new Error("You are not a member of this organization"),
		);
	});

	it("rejects with an AbortError once the chat lets go of the message", async () => {
		fetchMock.mockImplementation(heldUntilAborted);
		const controller = new AbortController();

		const asked = askRuntime(controller.signal);
		controller.abort();

		await expect(asked).rejects.toMatchObject({ name: "AbortError" });
	});

	it("rejects a reply that ends without finishing as lost, never as an answer", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		fetchMock.mockImplementation(async () =>
			sse([
				{ type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
				{
					type: EventType.TEXT_MESSAGE_START,
					messageId: "a",
					role: "assistant",
				},
				{
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "a",
					delta: "Half an ans",
				},
			] satisfies AGUIEvent[]),
		);

		await expect(askRuntime()).rejects.toThrow(
			"The connection to this reply was lost. Please try again.",
		);
	});
});

describe("askCugaRoute", () => {
	it("keeps the relay's request body", async () => {
		fetchMock.mockResolvedValue(
			Response.json({
				response: "In May.",
				contextId: "ctx-agent-1",
				reasoning: "Checked.",
				artifacts: [{ id: "artifact-1" }],
			}),
		);

		const reply = await askCugaRoute({
			...QUESTION,
			organizationId: "org-example-1",
			signal: new AbortController().signal,
		});

		expect(reply).toEqual({
			response: "In May.",
			contextId: "ctx-agent-1",
			reasoning: "Checked.",
			artifacts: [{ id: "artifact-1" }],
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("/api/agents/a2a/send");
		expect(init?.method).toBe("POST");
		expect(init?.body).toBe(
			JSON.stringify({
				agentId: "cuga_generalist",
				message: { role: "user", content: "When does it ship?" },
				contextId: "ctx-example-1",
				history: QUESTION.history,
				organizationId: "org-example-1",
			}),
		);
	});

	it("rejects with the relay's error text", async () => {
		fetchMock.mockResolvedValue(
			Response.json({ error: "Agent not found" }, { status: 404 }),
		);

		await expect(
			askCugaRoute({
				...QUESTION,
				organizationId: null,
				signal: new AbortController().signal,
			}),
		).rejects.toThrow(new Error("Agent not found"));
	});

	it("rejects with an AbortError once the chat lets go of the message", async () => {
		fetchMock.mockImplementation(heldUntilAborted);
		const controller = new AbortController();

		const asked = askCugaRoute({
			...QUESTION,
			organizationId: null,
			signal: controller.signal,
		});
		controller.abort();

		expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
		await expect(asked).rejects.toMatchObject({ name: "AbortError" });
	});
});
