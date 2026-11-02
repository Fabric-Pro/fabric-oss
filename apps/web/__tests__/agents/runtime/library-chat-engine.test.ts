// @vitest-environment node
/**
 * The runtime's `library-chat` engine: a library's Chat with Documents,
 * streamed.
 *
 *   - refused (`FEATURE_DISABLED`) while `COPILOTKIT_LIBRARY_CHAT` is off for
 *     the caller's organization, (`NO_MESSAGE`) without a new question,
 *     (`FORBIDDEN`) when `hasWorkspaceAccess` says no and (`NOT_FOUND`) for
 *     a missing workspace; none resolves a model or retrieves anything;
 *   - an answer arrives as RUN_STARTED, the sources (CUSTOM
 *     `fabric.library-chat.sources`), the streamed text, RUN_FINISHED, and
 *     passes AG-UI's `verifyEvents`; an empty answer is the route's fallback;
 *   - a failed request ends with RUN_ERROR: a usage limit or a spent plan as
 *     the member's refusal, anything else generic; neither is billed;
 *   - after a stop, or the client going away, nothing more is sent, the
 *     message and run still end, and the request already made is billed
 *     once; a client gone before the model is asked means no model call
 *     and no answer billed;
 *   - billing is the route's: model and embedding tracked, embedding and
 *     answer usage logged against the workspace's tenant (none for a
 *     personal library), with the conversation so far as history.
 */
import {
	type AGUIEvent,
	type BaseEvent,
	EventType,
	type RunAgentInput,
	verifyEvents,
} from "@ag-ui/client";
import {
	CHATGPT_PLAN_EXHAUSTED_CODE,
	SubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import type { RunStream } from "@saas/agents/runtime/engine";
import { RetryError } from "ai";
import { from, lastValueFrom, toArray } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	workspaceOrganizationId: "org-example-1" as string | null,
	workspaceExists: true,
	/**
	 * What the mocked `streamText` answers: its text deltas, an error it
	 * reports through `onError` once they are sent (as the AI SDK reports a
	 * failed request), and a pause after the first delta.
	 */
	answer: {
		deltas: [] as string[],
		error: undefined as unknown,
		pauseAfterFirst: undefined as (() => Promise<void>) | undefined,
	},
	streamText: vi.fn(),
	embed: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	getAIEmbeddingModelWithMetadata: vi.fn(),
	trackModel: vi.fn(),
	trackEmbedding: vi.fn(),
	logEmbeddingUsageAsync: vi.fn(),
	logModelUsageAsync: vi.fn(),
	searchWorkspaceChunks: vi.fn(),
	isFeatureEnabled: vi.fn(),
	hasWorkspaceAccess: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	enhancePromptWithFabric: async () => ({ fabricUsed: false }),
	streamText: (...args: unknown[]) => m.streamText(...args),
	getAIModelWithMetadata: (...args: unknown[]) =>
		m.getAIModelWithMetadata(...args),
	getAIEmbeddingModelWithMetadata: (...args: unknown[]) =>
		m.getAIEmbeddingModelWithMetadata(...args),
	getCurrentDateContext: () => "",
	logEmbeddingUsageAsync: (...args: unknown[]) =>
		m.logEmbeddingUsageAsync(...args),
	logModelUsageAsync: (...args: unknown[]) => m.logModelUsageAsync(...args),
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: (...args: unknown[]) => m.isFeatureEnabled(...args),
	hasWorkspaceAccess: (...args: unknown[]) => m.hasWorkspaceAccess(...args),
	db: {
		workspace: {
			findUnique: async () =>
				m.workspaceExists
					? {
							id: "workspace-example-1",
							organizationId: m.workspaceOrganizationId,
							type: "TEAM",
							_count: { documents: 1 },
						}
					: null,
		},
		workspaceDocumentChunk: {
			count: async () => 0,
			findMany: async () => [
				{
					id: "chunk-1",
					documentId: "doc-1",
					content: "The plan ships in May.",
					chunkIndex: 0,
					pageNumber: 2,
					document: { id: "doc-1", filename: "plan.pdf" },
				},
			],
		},
	},
}));

vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: async () => ({
		allowed: true,
		remaining: 999,
		resetInSeconds: 60,
	}),
}));

vi.mock("@repo/rag", () => ({
	generateSparseVector: () => ({ indices: [], values: [] }),
	searchWorkspaceChunks: (...args: unknown[]) =>
		m.searchWorkspaceChunks(...args),
}));

vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	embed: (...args: unknown[]) => m.embed(...args),
}));

const { LibraryChatEngine } = await import(
	"@saas/agents/runtime/library-chat-engine"
);
const { EMPTY_WORKSPACE_CHAT_ANSWER } = await import(
	"../../../app/api/workspaces/chat/workspace-chat-turn"
);

const CALLER = {
	userId: "user-example-1",
	organizationId: "org-example-1",
	audit: {},
};
const THREAD = "thread-example-0001";
const RUN = "run-example-0001";
const USAGE = { inputTokens: 10, outputTokens: 4, totalTokens: 14 };
const SEARCH_HITS = [
	{
		chunkId: "doc-1-0",
		documentId: "doc-1",
		workspaceId: "workspace-example-1",
		score: 0.82,
		filename: "plan.pdf",
		chunkIndex: 0,
		pageNumber: 2,
	},
];
const CONVERSATION: RunAgentInput["messages"] = [
	{ id: "m-1", role: "user", content: "What is in the plan?" },
	{ id: "m-2", role: "assistant", content: "A launch." },
	{ id: "m-3", role: "user", content: "When does it ship?" },
];

function input(messages = CONVERSATION): RunAgentInput {
	return {
		threadId: THREAD,
		runId: RUN,
		messages,
		tools: [],
		context: [],
		state: {},
		forwardedProps: { workspaceId: "workspace-example-1" },
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

/** A pause the mocks hold the turn at, until `release`. */
function pause(): {
	hold: () => Promise<void>;
	reached: Promise<void>;
	release: () => void;
} {
	let reach = () => {};
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		hold: () => {
			reach();
			return gate;
		},
		reached,
		release: () => release(),
	};
}

/**
 * The client closes the response while the turn is held at `at`; the
 * engine's close watch (a 250 ms poll) sees it before the turn goes on.
 */
async function closeWhileHeld(
	at: ReturnType<typeof pause>,
): Promise<AGUIEvent[]> {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	try {
		const stream = collector();
		const running = new LibraryChatEngine(CALLER).run(
			{ threadId: THREAD, input: input() },
			stream,
		);
		await at.reached;
		stream.close();
		vi.advanceTimersByTime(250);
		at.release();
		await running;
		return stream.events;
	} finally {
		vi.useRealTimers();
	}
}

async function run(messages = CONVERSATION): Promise<AGUIEvent[]> {
	const stream = collector();
	await new LibraryChatEngine(CALLER).run(
		{ threadId: THREAD, input: input(messages) },
		stream,
	);
	return stream.events;
}

function deltasOf(events: AGUIEvent[]): string[] {
	return events.flatMap((event) =>
		event.type === EventType.TEXT_MESSAGE_CONTENT ? [event.delta] : [],
	);
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
	vi.clearAllMocks();
	m.workspaceOrganizationId = "org-example-1";
	m.workspaceExists = true;
	m.answer = {
		deltas: ["It ships ", "in May."],
		error: undefined,
		pauseAfterFirst: undefined,
	};
	m.embed.mockResolvedValue({ embedding: [0.1, 0.2], usage: { tokens: 3 } });
	m.isFeatureEnabled.mockResolvedValue(true);
	m.hasWorkspaceAccess.mockResolvedValue(true);
	m.getAIModelWithMetadata.mockResolvedValue({
		model: { id: "model-example" },
		metadata: { modelString: "model-example" },
		trackUsage: m.trackModel,
	});
	m.getAIEmbeddingModelWithMetadata.mockResolvedValue({
		model: { id: "embedding-example" },
		metadata: {},
		trackUsage: m.trackEmbedding,
	});
	m.searchWorkspaceChunks.mockResolvedValue(SEARCH_HITS);
	m.streamText.mockImplementation(
		({ onError }: { onError: (event: { error: unknown }) => void }) => ({
			textStream: (async function* () {
				for (const [index, delta] of m.answer.deltas.entries()) {
					yield delta;
					if (index === 0) {
						await m.answer.pauseAfterFirst?.();
					}
				}
				if (m.answer.error !== undefined) {
					onError({ error: m.answer.error });
				}
			})(),
			usage: Promise.resolve(USAGE),
		}),
	);
});

describe("the library-chat engine", () => {
	it("refuses while its flag is off for the caller's organization, before any access check or model call", async () => {
		m.isFeatureEnabled.mockResolvedValue(false);

		const events = await run();

		expect(events).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "FEATURE_DISABLED",
			}),
		]);
		expect(m.isFeatureEnabled).toHaveBeenCalledWith(
			"COPILOTKIT_LIBRARY_CHAT",
			"org-example-1",
		);
		expect(m.hasWorkspaceAccess).not.toHaveBeenCalled();
		expect(m.getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(m.streamText).not.toHaveBeenCalled();
	});

	it("refuses a workspace the caller may not read, with no model call", async () => {
		m.hasWorkspaceAccess.mockResolvedValue(false);

		const events = await run();

		expect(events).toEqual([
			{
				type: EventType.RUN_ERROR,
				code: "FORBIDDEN",
				message: "You don't have access to this workspace",
			},
		]);
		expect(m.hasWorkspaceAccess).toHaveBeenCalledWith(
			"workspace-example-1",
			"user-example-1",
		);
		expect(m.getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(m.getAIEmbeddingModelWithMetadata).not.toHaveBeenCalled();
		expect(m.searchWorkspaceChunks).not.toHaveBeenCalled();
		expect(m.streamText).not.toHaveBeenCalled();
	});

	it("streams the sources, then the answer, and bills as the route does", async () => {
		const events = await run();

		await expect(
			lastValueFrom(
				from(events as BaseEvent[]).pipe(
					verifyEvents(false),
					toArray(),
				),
			),
		).resolves.toHaveLength(events.length);
		expect(events.map((event) => event.type)).toEqual([
			EventType.RUN_STARTED,
			EventType.CUSTOM,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.RUN_FINISHED,
		]);
		expect(events[1]).toEqual({
			type: EventType.CUSTOM,
			name: "fabric.library-chat.sources",
			value: {
				sources: [
					{
						filename: "plan.pdf",
						pageNumber: 2,
						chunkIndex: 0,
						score: 0.82,
						content: "The plan ships in May.",
					},
				],
			},
		});
		expect(deltasOf(events)).toEqual(["It ships ", "in May."]);

		expect(m.streamText).toHaveBeenCalledWith(
			expect.objectContaining({
				model: { id: "model-example" },
				instructions: expect.stringContaining("The plan ships in May."),
				messages: [
					{ role: "user", content: "What is in the plan?" },
					{ role: "assistant", content: "A launch." },
					{ role: "user", content: "When does it ship?" },
				],
			}),
		);
		expect(m.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "CHAT" },
			{
				userId: "user-example-1",
				organizationId: "org-example-1",
				planEligible: true,
			},
		);
		expect(m.trackModel).toHaveBeenCalledTimes(1);
		expect(m.trackEmbedding).toHaveBeenCalledTimes(1);
		expect(m.logEmbeddingUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({ usageTokens: 3 }),
		);
		expect(m.logModelUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				context: {
					userId: "user-example-1",
					organizationId: "org-example-1",
				},
				taskType: "CHAT",
				usage: USAGE,
			}),
		);
	});

	it("serves a personal library under the caller's organization, billed to no organization", async () => {
		m.workspaceOrganizationId = null;

		const events = await run();

		expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
		expect(m.isFeatureEnabled).toHaveBeenCalledWith(
			"COPILOTKIT_LIBRARY_CHAT",
			"org-example-1",
		);
		expect(m.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "CHAT" },
			expect.objectContaining({ organizationId: undefined }),
		);
		expect(m.logModelUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				context: {
					userId: "user-example-1",
					organizationId: undefined,
				},
			}),
		);
	});

	it("refuses a run whose last message is not a new question, before any access check or model call", async () => {
		const events = await run(CONVERSATION.slice(0, 2));

		expect(events).toEqual([
			{
				type: EventType.RUN_ERROR,
				code: "NO_MESSAGE",
				message: "A run needs a new user message.",
			},
		]);
		expect(m.hasWorkspaceAccess).not.toHaveBeenCalled();
		expect(m.getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(m.embed).not.toHaveBeenCalled();
		expect(m.streamText).not.toHaveBeenCalled();
	});

	it("refuses a workspace that does not exist, with no model call or retrieval", async () => {
		m.workspaceExists = false;

		const events = await run();

		expect(events).toEqual([
			{
				type: EventType.RUN_ERROR,
				code: "NOT_FOUND",
				message: "Workspace not found",
			},
		]);
		expect(m.getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(m.getAIEmbeddingModelWithMetadata).not.toHaveBeenCalled();
		expect(m.embed).not.toHaveBeenCalled();
		expect(m.searchWorkspaceChunks).not.toHaveBeenCalled();
		expect(m.streamText).not.toHaveBeenCalled();
	});

	it("answers an empty reply with the route's fallback, and still bills it", async () => {
		m.answer.deltas = [];

		const events = await run();

		expect(deltasOf(events)).toEqual([EMPTY_WORKSPACE_CHAT_ANSWER]);
		expect(events.at(-2)).toMatchObject({
			type: EventType.TEXT_MESSAGE_END,
		});
		expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
		expect(m.logModelUsageAsync).toHaveBeenCalledTimes(1);
		expect(m.logModelUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({ usage: USAGE }),
		);
	});

	it("ends a usage limit the request hit with its limits, never as an empty answer, and bills nothing", async () => {
		m.answer.deltas = [];
		m.answer.error = new RetryError({
			message: "Failed after 2 attempts.",
			reason: "errorNotRetryable",
			errors: [new Error("provider overloaded"), usageLimit()],
		});

		const events = await run();

		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: "AI_USAGE_LIMIT_EXCEEDED",
			message: "AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
			metadata: {
				fabric: {
					code: "AI_USAGE_LIMIT_EXCEEDED",
					data: { limitId: "limit-1", used: "100", max: "100" },
				},
			},
		});
		expect(deltasOf(events)).toEqual([]);
		expect(m.logModelUsageAsync).not.toHaveBeenCalled();
	});

	it("ends a spent ChatGPT plan met while resolving the model with the plan's own message and reset time", async () => {
		m.getAIModelWithMetadata.mockRejectedValue(
			new SubscriptionPlanExhaustedError(
				"Your ChatGPT plan has no usage left until 15:00.",
				new Date("2026-10-30T15:00:00.000Z"),
			),
		);

		const events = await run();

		expect(events.map((event) => event.type)).toEqual([
			EventType.RUN_STARTED,
			EventType.RUN_ERROR,
		]);
		expect(events[1]).toMatchObject({
			code: CHATGPT_PLAN_EXHAUSTED_CODE,
			message: "Your ChatGPT plan has no usage left until 15:00.",
			metadata: {
				fabric: { resetAt: "2026-10-30T15:00:00.000Z" },
			},
		});
		expect(m.streamText).not.toHaveBeenCalled();
	});

	it("ends a failed request with a generic failure, its detail kept to the server log", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		m.answer.error = new Error("upstream 502 from https://example.com/v1");

		const events = await run();

		expect(events.at(-1)).toEqual({
			type: EventType.RUN_ERROR,
			code: "RUN_FAILED",
			message: "The reply failed. Please try again.",
		});
		expect(JSON.stringify(events)).not.toContain("upstream 502");
		expect(log).toHaveBeenCalled();
		expect(m.logModelUsageAsync).not.toHaveBeenCalled();
		log.mockRestore();
	});

	it("sends nothing more once stopped, still ends the message and the run, and bills the whole request once", async () => {
		const afterFirst = pause();
		m.answer.pauseAfterFirst = afterFirst.hold;
		const engine = new LibraryChatEngine(CALLER);
		const stream = collector();

		const running = engine.run(
			{ threadId: THREAD, input: input() },
			stream,
		);
		await afterFirst.reached;
		expect(await engine.stop(THREAD, RUN)).toBe(true);
		afterFirst.release();
		await running;

		expect(deltasOf(stream.events)).toEqual(["It ships "]);
		expect(stream.events.slice(-2).map((event) => event.type)).toEqual([
			EventType.TEXT_MESSAGE_END,
			EventType.RUN_FINISHED,
		]);
		expect(m.logModelUsageAsync).toHaveBeenCalledTimes(1);
		expect(m.logModelUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({ usage: USAGE }),
		);
	});

	it("makes no model call, and bills no answer, when the client goes away before the model is asked", async () => {
		const retrieval = pause();
		m.searchWorkspaceChunks.mockImplementation(async () => {
			await retrieval.hold();
			return SEARCH_HITS;
		});

		const events = await closeWhileHeld(retrieval);

		expect(events.map((event) => event.type)).toEqual([
			EventType.RUN_STARTED,
			EventType.CUSTOM,
			EventType.RUN_FINISHED,
		]);
		expect(m.streamText).not.toHaveBeenCalled();
		expect(m.logModelUsageAsync).not.toHaveBeenCalled();
		// The question's embedding was already made, and is billed.
		expect(m.logEmbeddingUsageAsync).toHaveBeenCalledTimes(1);
	});

	it("sends nothing more after the client goes away mid-answer, but drains the request and bills it once", async () => {
		const afterFirst = pause();
		m.answer.pauseAfterFirst = afterFirst.hold;

		const events = await closeWhileHeld(afterFirst);

		expect(deltasOf(events)).toEqual(["It ships "]);
		expect(m.logModelUsageAsync).toHaveBeenCalledTimes(1);
		expect(m.logModelUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({ usage: USAGE }),
		);
	});
});
