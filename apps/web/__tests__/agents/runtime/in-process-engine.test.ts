// @vitest-environment node
/**
 * InProcessEngine, the base of the runtime's request/reply chats, through a
 * minimal engine:
 *
 *   - the caller's oRPC request budget (`rpc:user:<id>`) is charged first:
 *     a spent budget, or a limiter that cannot be reached, ends the run
 *     before the props check, `admit` or the turn; a limit of 0 skips it;
 *   - invalid `forwardedProps`, a refused admission (a code and message, or
 *     a stream route's JSON response) and a throw from `admit` end the run
 *     with RUN_ERROR before RUN_STARTED, and the turn never runs;
 *   - an admitted turn's events arrive between RUN_STARTED and RUN_FINISHED,
 *     and the run passes AG-UI's `verifyEvents`;
 *   - `connect` replays nothing; `isRunning` is true only while the request
 *     runs the turn; `stop` aborts the caller's own turn only; a closed
 *     response frees the thread at once and counts as a stop, and never
 *     frees it again once a retry holds it;
 *   - a failure ends the run, first match wins: the engine's own
 *     `InProcessTurnError`; a ChatGPT plan refusal (spent, to reconnect, a
 *     model it does not serve); a usage limit; a procedure's `ORPCError`; a
 *     missing AI provider or an unsupported embedding model; anything else
 *     a generic error;
 *   - `requestReplyConversation` takes the last text message, a person's
 *     non-blank question, and the text messages before it.
 */
import {
	type AGUIEvent,
	type BaseEvent,
	EventType,
	type Message,
	type RunAgentInput,
	verifyEvents,
} from "@ag-ui/client";
import { ORPCError } from "@orpc/client";
import {
	CHATGPT_PLAN_EXHAUSTED_CODE,
	SubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { ChatGptPlanModelNotServedError } from "@repo/ai/lib/chatgpt-plan/models";
import {
	CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
	ChatGptPlanAuthError,
} from "@repo/ai/lib/chatgpt-plan/oauth";
import { UnsupportedEmbeddingModelError } from "@repo/ai/lib/embedding-dimensions";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import type { RunStream, RuntimeCaller } from "@saas/agents/runtime/engine";
import {
	type InProcessAdmission,
	InProcessEngine,
	type InProcessRun,
	InProcessTurnError,
	requestReplyConversation,
} from "@saas/agents/runtime/in-process-engine";
import { RetryError } from "ai";
import { from, lastValueFrom, toArray } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const m = vi.hoisted(() => ({ checkRateLimit: vi.fn() }));

vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: (...args: unknown[]) => m.checkRateLimit(...args),
}));

const THREAD = "thread-example-0001";
const CALLER: RuntimeCaller = {
	userId: "user-example-1",
	organizationId: "org-example-1",
	audit: {},
};

type Script = (run: InProcessRun) => AsyncIterable<AGUIEvent>;
type Admit = (topic: string) => Promise<InProcessAdmission<string>>;

const admitted: Admit = async (topic) => ({ ok: true, turn: topic });

class EchoEngine extends InProcessEngine<{ topic: string }, string> {
	readonly agentId = "echo-example";
	protected readonly propsSchema = z.object({ topic: z.string().min(1) });
	readonly turns: string[] = [];
	admits = 0;

	constructor(
		caller: RuntimeCaller,
		private readonly script: Script,
		private readonly admission: Admit = admitted,
	) {
		super(caller);
	}

	protected async admit({
		props,
	}: {
		props: { topic: string };
	}): Promise<InProcessAdmission<string>> {
		this.admits += 1;
		return this.admission(props.topic);
	}

	protected turn(topic: string, run: InProcessRun): AsyncIterable<AGUIEvent> {
		this.turns.push(topic);
		return this.script(run);
	}
}

function input(forwardedProps: unknown = { topic: "plans" }): RunAgentInput {
	return {
		threadId: THREAD,
		runId: "run-example-0001",
		messages: [{ id: "m-1", role: "user", content: "Hi" }],
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

/** A turn that fails with `error` before it sends anything. */
function failing(error: unknown): Script {
	return async function* () {
		yield* [];
		throw error;
	};
}

/** The run's last event when the turn fails with `error`. */
async function failureOf(error: unknown): Promise<AGUIEvent | undefined> {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const stream = collector();
	await new EchoEngine(CALLER, failing(error)).run(
		{ threadId: THREAD, input: input() },
		stream,
	);
	return stream.events.at(-1);
}

/** A turn held until `release` is called. */
function held(): { script: Script; release: () => void } {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		script: async function* () {
			await gate;
			yield* answer();
		},
		release: () => release(),
	};
}

async function* answer(): AsyncIterable<AGUIEvent> {
	yield {
		type: EventType.TEXT_MESSAGE_START,
		messageId: "answer",
		role: "assistant",
	};
	yield {
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: "answer",
		delta: "Hello",
	};
	yield { type: EventType.TEXT_MESSAGE_END, messageId: "answer" };
}

function verified(events: AGUIEvent[]): Promise<BaseEvent[]> {
	return lastValueFrom(
		from(events as BaseEvent[]).pipe(verifyEvents(false), toArray()),
	);
}

beforeEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	m.checkRateLimit.mockReset().mockResolvedValue({
		allowed: true,
		remaining: 999,
		resetInSeconds: 60,
	});
});

describe("InProcessEngine", () => {
	it("charges the run to the caller's oRPC request budget", async () => {
		const stream = collector();

		await new EchoEngine(CALLER, answer).run(
			{ threadId: THREAD, input: input() },
			stream,
		);

		expect(m.checkRateLimit).toHaveBeenCalledWith(
			"rpc:user:user-example-1",
			1000,
			60_000,
		);
		expect(stream.events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
		});
	});

	it("refuses a spent request budget before the props check, admission or turn", async () => {
		m.checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 30,
		});
		const engine = new EchoEngine(CALLER, answer);
		const stream = collector();

		await engine.run({ threadId: THREAD, input: input({}) }, stream);

		expect(stream.events).toEqual([
			{
				type: EventType.RUN_ERROR,
				code: "TOO_MANY_REQUESTS",
				message: "Rate limit exceeded. Please try again in 30 seconds.",
				metadata: {
					fabric: {
						status: 429,
						error: "Rate limit exceeded. Please try again in 30 seconds.",
						code: "TOO_MANY_REQUESTS",
						data: { retryAfter: 30 },
					},
				},
			},
		]);
		expect(engine.admits).toBe(0);
		expect(engine.turns).toEqual([]);
	});

	it("fails closed when the limiter cannot be reached", async () => {
		m.checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 60,
			statusCode: 503,
		});
		const engine = new EchoEngine(CALLER, answer);
		const stream = collector();

		await engine.run({ threadId: THREAD, input: input() }, stream);

		expect(stream.events).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "SERVICE_UNAVAILABLE",
				metadata: { fabric: expect.objectContaining({ status: 503 }) },
			}),
		]);
		expect(engine.admits).toBe(0);
	});

	it("skips the request budget when the limit is 0", async () => {
		vi.stubEnv("RPC_RATE_LIMIT_PER_MINUTE", "0");
		const stream = collector();

		await new EchoEngine(CALLER, answer).run(
			{ threadId: THREAD, input: input() },
			stream,
		);

		expect(m.checkRateLimit).not.toHaveBeenCalled();
		expect(stream.events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
		});
	});

	it("refuses invalid forwardedProps before the turn runs", async () => {
		const engine = new EchoEngine(CALLER, answer);
		const stream = collector();

		await engine.run({ threadId: THREAD, input: input({}) }, stream);

		expect(stream.events).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "INVALID_REQUEST",
			}),
		]);
		expect(engine.admits).toBe(0);
		expect(engine.turns).toEqual([]);
	});

	it("ends a refused admission with its code and never runs the turn", async () => {
		const engine = new EchoEngine(CALLER, answer, async () => ({
			ok: false,
			code: "FEATURE_DISABLED",
			message: "Refused.",
		}));
		const stream = collector();

		await engine.run({ threadId: THREAD, input: input() }, stream);

		expect(stream.events).toEqual([
			{
				type: EventType.RUN_ERROR,
				code: "FEATURE_DISABLED",
				message: "Refused.",
			},
		]);
		expect(engine.turns).toEqual([]);
	});

	it("ends an admission refused with a stream route's response as that route answers it", async () => {
		const engine = new EchoEngine(CALLER, answer, async () => ({
			ok: false,
			refusal: Response.json(
				{ error: "Project not found", code: "NOT_FOUND" },
				{ status: 404 },
			),
		}));
		const stream = collector();

		await engine.run({ threadId: THREAD, input: input() }, stream);

		expect(stream.events).toEqual([
			{
				type: EventType.RUN_ERROR,
				code: "NOT_FOUND",
				message: "Project not found",
				metadata: {
					fabric: {
						status: 404,
						error: "Project not found",
						code: "NOT_FOUND",
					},
				},
			},
		]);
		expect(engine.turns).toEqual([]);
	});

	it("ends an admission that throws with a generic error before RUN_STARTED, its detail kept to the server log", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const engine = new EchoEngine(CALLER, answer, async () => {
			throw new Error("connection refused by db.example.com");
		});
		const stream = collector();

		await engine.run({ threadId: THREAD, input: input() }, stream);

		expect(stream.events).toEqual([
			{
				type: EventType.RUN_ERROR,
				code: "RUN_FAILED",
				message: "The reply failed. Please try again.",
			},
		]);
		expect(log).toHaveBeenCalled();
		expect(engine.turns).toEqual([]);
	});

	it("streams an admitted turn between RUN_STARTED and RUN_FINISHED", async () => {
		const engine = new EchoEngine(CALLER, answer);
		const stream = collector();

		await engine.run({ threadId: THREAD, input: input() }, stream);

		expect(engine.turns).toEqual(["plans"]);
		expect(stream.events.map((event) => event.type)).toEqual([
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.RUN_FINISHED,
		]);
		await expect(verified(stream.events)).resolves.toHaveLength(5);
	});

	it("replays nothing on connect", async () => {
		const stream = collector();

		await new EchoEngine(CALLER, answer).connect(THREAD, stream);

		expect(stream.events).toEqual([]);
	});

	it("runs only while the request does, and stops only the caller's own turn", async () => {
		const turn = held();
		let aborted = false;
		const engine = new EchoEngine(CALLER, async function* (run) {
			yield* turn.script(run);
			aborted = run.signal.aborted;
		});
		const someoneElse = new EchoEngine(
			{ ...CALLER, userId: "user-example-2" },
			answer,
		);
		const stream = collector();

		const running = engine.run(
			{ threadId: THREAD, input: input() },
			stream,
		);
		await vi.waitFor(async () =>
			expect(await engine.isRunning(THREAD)).toBe(true),
		);

		expect(await someoneElse.isRunning(THREAD)).toBe(false);
		expect(await someoneElse.stop(THREAD)).toBe(false);
		expect(await engine.stop(THREAD, "run-example-other")).toBe(false);
		expect(await engine.stop(THREAD, "run-example-0001")).toBe(true);
		turn.release();
		await running;

		expect(aborted).toBe(true);
		expect(await engine.isRunning(THREAD)).toBe(false);
		expect(await engine.stop(THREAD)).toBe(false);
	});

	it("ends the engine's own refusal with its code and message, from the turn or from admit", async () => {
		const refusal = new InProcessTurnError(
			"SESSION_EXPIRED",
			"This session has ended. Start a new one.",
		);
		const expected = {
			type: EventType.RUN_ERROR,
			code: "SESSION_EXPIRED",
			message: "This session has ended. Start a new one.",
		};
		const stream = collector();

		await new EchoEngine(CALLER, answer, async () => {
			throw refusal;
		}).run({ threadId: THREAD, input: input() }, stream);

		expect(await failureOf(refusal)).toEqual(expected);
		expect(stream.events).toEqual([expected]);
	});

	it("ends a usage-limit refusal with its limits, as the chat routes answer it", async () => {
		const limit = new AiUsageLimitExceededError({
			message: "AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
			limitId: "limit-1",
			dimension: "TOKENS",
			window: "MONTHLY",
			used: BigInt(100),
			max: BigInt(100),
			manageLimitsUrl: "https://example.com/limits",
		});

		expect(await failureOf(limit)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: "AI_USAGE_LIMIT_EXCEEDED",
			message: limit.message,
			metadata: {
				fabric: {
					status: 429,
					code: "AI_USAGE_LIMIT_EXCEEDED",
					data: { limitId: "limit-1", used: "100", max: "100" },
				},
			},
		});
	});

	it("ends a spent ChatGPT plan with its own message, reset time and personal-key option, even inside a RetryError", async () => {
		const exhausted = new SubscriptionPlanExhaustedError(
			"Your ChatGPT plan has no usage left until 15:00.",
			new Date("2026-10-30T15:00:00.000Z"),
			{ personalKeyOption: true },
		);
		const expected = {
			type: EventType.RUN_ERROR,
			code: CHATGPT_PLAN_EXHAUSTED_CODE,
			message: "Your ChatGPT plan has no usage left until 15:00.",
			metadata: {
				fabric: {
					status: 429,
					code: CHATGPT_PLAN_EXHAUSTED_CODE,
					resetAt: "2026-10-30T15:00:00.000Z",
					personalKeyOption: true,
				},
			},
		};

		expect(await failureOf(exhausted)).toMatchObject(expected);
		expect(
			await failureOf(
				new RetryError({
					message: "Failed after 2 attempts.",
					reason: "errorNotRetryable",
					errors: [new Error("provider overloaded"), exhausted],
				}),
			),
		).toMatchObject(expected);
	});

	it("ends a ChatGPT plan that needs reconnecting, or does not serve the model, with the routes' refusal", async () => {
		expect(
			await failureOf(
				new ChatGptPlanAuthError(
					"refresh token reused",
					"refresh_token_reused",
					true,
				),
			),
		).toMatchObject({
			type: EventType.RUN_ERROR,
			code: "CHATGPT_PLAN_UNAVAILABLE",
			message: CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
			metadata: { fabric: { status: 409 } },
		});
		const notServed = new ChatGptPlanModelNotServedError("model-example");
		expect(await failureOf(notServed)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: "CHATGPT_PLAN_MODEL_NOT_SERVED",
			message: notServed.message,
			metadata: { fabric: { status: 409 } },
		});
	});

	it("ends a procedure's refusal thrown inside the turn as the procedure answers it", async () => {
		expect(
			await failureOf(
				new ORPCError("NOT_FOUND", {
					message: "Session not found",
					data: { sessionId: "session-example-1" },
				}),
			),
		).toEqual({
			type: EventType.RUN_ERROR,
			code: "NOT_FOUND",
			message: "Session not found",
			metadata: {
				fabric: {
					status: 404,
					error: "Session not found",
					code: "NOT_FOUND",
					data: { sessionId: "session-example-1" },
				},
			},
		});
	});

	it("passes on a missing AI provider's own guidance", async () => {
		const missing = new Error(
			"No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
		);
		missing.name = "AIProviderNotConfiguredError";

		expect(await failureOf(missing)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: "AI_PROVIDER_NOT_CONFIGURED",
			message: missing.message,
			metadata: { fabric: { status: 400 } },
		});
	});

	it("passes on an unsupported embedding model's own guidance", async () => {
		const unsupported = new UnsupportedEmbeddingModelError(
			"text-embedding-3-large",
		);

		expect(await failureOf(unsupported)).toEqual({
			type: EventType.RUN_ERROR,
			code: "EMBEDDING_MODEL_UNSUPPORTED",
			message: unsupported.message,
			metadata: {
				fabric: {
					status: 412,
					error: unsupported.message,
					code: "EMBEDDING_MODEL_UNSUPPORTED",
				},
			},
		});
		expect(unsupported.message).toContain(
			"Choose a compatible embedding model",
		);
	});

	it("ends any other failure with a generic error", async () => {
		expect(
			await failureOf(new Error("provider unavailable at internal-host")),
		).toEqual({
			type: EventType.RUN_ERROR,
			code: "RUN_FAILED",
			message: "The reply failed. Please try again.",
		});
	});

	it("frees the thread as soon as the client closes the response, takes that as a stop, and leaves a retry's run alone", async () => {
		const first = held();
		let aborted = false;
		const engine = new EchoEngine(CALLER, async function* (run) {
			yield* first.script(run);
			aborted = run.signal.aborted;
		});
		const stream = collector();
		const running = engine.run(
			{ threadId: THREAD, input: input() },
			stream,
		);
		await vi.waitFor(async () =>
			expect(await engine.isRunning(THREAD)).toBe(true),
		);

		stream.close();
		await vi.waitFor(async () =>
			expect(await engine.isRunning(THREAD)).toBe(false),
		);
		// A retry on the same thread is admitted while the first turn drains.
		const second = held();
		const retryEngine = new EchoEngine(CALLER, second.script);
		const retry = collector();
		const retrying = retryEngine.run(
			{ threadId: THREAD, input: input() },
			retry,
		);
		await vi.waitFor(async () =>
			expect(await retryEngine.isRunning(THREAD)).toBe(true),
		);
		// The closed run's watch polls again, then its request ends: neither
		// frees the thread the retry now holds.
		await new Promise((resolve) => setTimeout(resolve, 300));
		first.release();
		await running;

		expect(aborted).toBe(true);
		expect(await retryEngine.isRunning(THREAD)).toBe(true);
		const third = collector();
		await new EchoEngine(CALLER, answer).run(
			{ threadId: THREAD, input: input() },
			third,
		);
		expect(third.events).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "THREAD_ALREADY_RUNNING",
			}),
		]);

		second.release();
		await retrying;
		expect(retry.events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
		});
		expect(await retryEngine.isRunning(THREAD)).toBe(false);
	});

	it("refuses a second run on a thread whose request is still open", async () => {
		const first = held();
		const engine = new EchoEngine(CALLER, first.script);
		const running = engine.run(
			{ threadId: THREAD, input: input() },
			collector(),
		);
		await vi.waitFor(async () =>
			expect(await engine.isRunning(THREAD)).toBe(true),
		);
		const second = collector();

		await new EchoEngine(CALLER, answer).run(
			{ threadId: THREAD, input: input() },
			second,
		);
		first.release();
		await running;

		expect(second.events).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "THREAD_ALREADY_RUNNING",
			}),
		]);
	});
});

describe("requestReplyConversation", () => {
	const conversation: Message[] = [
		{ id: "m-1", role: "user", content: "What is in the plan?" },
		{ id: "m-2", role: "assistant", content: "A launch." },
		{ id: "m-3", role: "user", content: "  When does it ship?  " },
	];

	it("takes the last message as the question and the text before it as history", () => {
		expect(requestReplyConversation(conversation)).toEqual({
			question: "When does it ship?",
			history: [
				{ role: "user", content: "What is in the plan?" },
				{ role: "assistant", content: "A launch." },
			],
		});
	});

	it("leaves out messages that are not the person's or the assistant's", () => {
		expect(
			requestReplyConversation([
				{ id: "s-1", role: "system", content: "Be brief." },
				...conversation,
				{
					id: "t-1",
					role: "tool",
					content: "{}",
					toolCallId: "call-1",
				},
			]),
		).toEqual({
			question: "When does it ship?",
			history: [
				{ role: "user", content: "What is in the plan?" },
				{ role: "assistant", content: "A launch." },
			],
		});
	});

	it.each([
		["no message", []],
		["an assistant's last message", conversation.slice(0, 2)],
		[
			"a blank question",
			[...conversation, { id: "m-4", role: "user", content: "   " }],
		],
	] as const)("is null for %s", (_case, messages: readonly Message[]) => {
		expect(requestReplyConversation(messages)).toBeNull();
	});
});
