// @vitest-environment node
/**
 * The runtime's `atlas-chat` engine: the Atlas tab's codebase chat, run in
 * the request on the conversation the thread id names.
 *
 *   - refused before RUN_STARTED, with no chat started: while
 *     `COPILOTKIT_ATLAS_CHAT` is off for the caller's organization
 *     (`FEATURE_DISABLED`), for options `atlas.chat` would refuse
 *     (`INVALID_REQUEST`), without a new question (`NO_MESSAGE`), over the
 *     caller's request budget, by any check `atlas.chat` makes (its own code
 *     and message), and for a thread that names a conversation the caller
 *     may not write to: another user's, or the caller's own seen from another
 *     organization or project (NOT_FOUND, without taking the thread);
 *   - an access refusal and a failure to start the chat write the
 *     procedure's failure audit row; a started chat writes its activity row;
 *     a spent request budget is refused by the base before the engine's
 *     checks and writes none (an accepted difference from `atlas.chat`);
 *   - an answer is one assistant text message between RUN_STARTED and
 *     RUN_FINISHED, then at most one note (persist-failed outranks
 *     interrupted), and passes AG-UI's `verifyEvents`;
 *   - a service refusal ends the run with the procedure's code and message;
 *   - a stop, the client going away, or an answer still streaming at the
 *     runtime route's time limit stops reading, so the service saves the
 *     part already written as interrupted.
 */
import {
	type AGUIEvent,
	type BaseEvent,
	EventType,
	type RunAgentInput,
	verifyEvents,
} from "@ag-ui/client";
import { ORPCError } from "@orpc/client";
import type { RunStream } from "@saas/agents/runtime/engine";
import { from, lastValueFrom, toArray } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	rateLimit: vi.fn(),
	authorize: vi.fn(),
	activity: vi.fn(),
	failure: vi.fn(),
	serviceCtx: vi.fn(),
	chat: vi.fn(),
	getConversation: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: (...args: unknown[]) => m.isFeatureEnabled(...args),
}));

vi.mock("@repo/api/orpc/middleware/rpc-rate-limit-middleware", () => ({
	rpcRateLimitRefusal: (...args: unknown[]) => m.rateLimit(...args),
}));

vi.mock("@repo/api/modules/atlas/chat-access", () => ({
	authorizeAtlasChat: (...args: unknown[]) => m.authorize(...args),
}));

vi.mock("@repo/api/orpc/middleware/audit-activity-middleware", () => ({
	recordProcedureActivity: (...args: unknown[]) => m.activity(...args),
}));

vi.mock("@repo/api/orpc/middleware/audit-error-middleware", () => ({
	recordProcedureFailure: (...args: unknown[]) => m.failure(...args),
}));

vi.mock("@repo/ai", () => {
	class AIProviderNotConfiguredError extends Error {
		constructor(message: string) {
			super(message);
			this.name = "AIProviderNotConfiguredError";
		}
	}
	return { AIProviderNotConfiguredError };
});

vi.mock("@repo/atlas", () => {
	class AtlasError extends Error {
		constructor(
			readonly code: string,
			message: string,
		) {
			super(message);
			this.name = "AtlasError";
		}
	}
	return {
		AtlasError,
		/** The service as the engine meets it, its conversation read included. */
		AtlasService: class {
			constructor(readonly ctx: { userId: string }) {
				m.serviceCtx(ctx);
			}
			chat = (input: unknown) => m.chat(input);
			getConversation = async (input: unknown) => {
				const conversation = await m.getConversation(this.ctx, input);
				if (!conversation) {
					throw new AtlasError(
						"NOT_FOUND",
						"Conversation not found.",
					);
				}
				return conversation;
			};
		},
	};
});

const { AtlasChatEngine } = await import(
	"@saas/agents/runtime/atlas-chat-engine"
);
const { AIProviderNotConfiguredError } = await import("@repo/ai");
const { AtlasError } = await import("@repo/atlas");

const USER = "user-example-1";
const OTHER_USER = "user-example-2";
const ORG = "org-example-1";
const OTHER_ORG = "org-example-2";
const PROJECT = "project-example-1";
const OTHER_PROJECT = "project-example-2";
const THREAD = "conversation-example-1";
const RUN = "run-example-0001";

function callerOf(userId: string, organizationId = ORG) {
	return {
		userId,
		organizationId,
		audit: {
			headers: new Headers(),
			user: { id: userId, email: "dev@example.com" },
			session: {
				id: `session-${userId}`,
				activeOrganizationId: organizationId,
			},
		},
	};
}

/**
 * The service's conversation read: THREAD is USER's conversation in ORG's
 * PROJECT, and no other user, tenant or project sees it.
 */
function visibleConversation(
	ctx: { userId: string; organizationId: string | null },
	request: { conversationId: string; projectId: string },
) {
	return ctx.userId === USER &&
		ctx.organizationId === ORG &&
		request.projectId === PROJECT &&
		request.conversationId === THREAD
		? { id: THREAD }
		: null;
}

const CALLER = callerOf(USER);

const CONVERSATION: RunAgentInput["messages"] = [
	{ id: "m-1", role: "system", content: "Runtime instructions." },
	{ id: "m-2", role: "user", content: "What does the auth module do?" },
	{ id: "m-3", role: "assistant", content: "It handles sign-in." },
	{ id: "m-4", role: "user", content: "Where are sessions stored?" },
];

const PROPS = {
	projectId: PROJECT,
	repositoryIntegrationId: "integration-1",
	mode: "TECHNICAL",
	focusNodeKey: "node-a",
};

function input(
	overrides: Partial<Pick<RunAgentInput, "messages" | "forwardedProps">> = {},
): RunAgentInput {
	return {
		threadId: THREAD,
		runId: RUN,
		messages: CONVERSATION,
		tools: [],
		context: [],
		state: {},
		forwardedProps: PROPS,
		...overrides,
	};
}

function collector(onEmit?: (event: AGUIEvent) => void): RunStream & {
	events: AGUIEvent[];
	/** The client goes away. */
	close: () => void;
} {
	const events: AGUIEvent[] = [];
	let closed = false;
	return {
		events,
		emit: (event) => {
			events.push(event);
			onEmit?.(event);
		},
		isClosed: () => closed,
		close: () => {
			closed = true;
		},
		deadline: Date.now() + 60_000,
	};
}

async function run(runInput = input(), caller = CALLER): Promise<AGUIEvent[]> {
	const stream = collector();
	await new AtlasChatEngine(caller).run(
		{ threadId: THREAD, input: runInput },
		stream,
	);
	return stream.events;
}

/** A started chat: its text deltas, then how its assistant write settled. */
function started(
	deltas: string[],
	outcome = { persisted: true, interrupted: false },
) {
	return {
		textStream: (async function* () {
			yield* deltas;
		})(),
		persistOutcome: Promise.resolve(outcome),
	};
}

/**
 * A started chat whose stream the service wraps as it does: leaving it early
 * salvages the part already written, interrupted. It can hold the turn after
 * the first delta until `release`.
 */
function salvagingChat(deltas: string[], signal?: AbortSignal) {
	const state = { returned: false };
	let reach = () => {};
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let settle: (outcome: {
		persisted: boolean;
		interrupted: boolean;
	}) => void = () => {};
	const persistOutcome = new Promise<{
		persisted: boolean;
		interrupted: boolean;
	}>((resolve) => {
		settle = resolve;
	});
	let hold = false;
	const textStream = (async function* () {
		let finished = false;
		try {
			for (const [index, delta] of deltas.entries()) {
				yield delta;
				if (index === 0 && hold) {
					reach();
					await new Promise<void>((resolve) => {
						const onAbort = () => resolve();
						signal?.addEventListener("abort", onAbort, {
							once: true,
						});
						void gate.then(() => {
							signal?.removeEventListener("abort", onAbort);
							resolve();
						});
						if (signal?.aborted) {
							resolve();
						}
					});
					if (signal?.aborted) {
						return;
					}
				}
			}
			finished = true;
		} finally {
			state.returned = !finished;
			settle({ persisted: true, interrupted: !finished });
		}
	})();
	return {
		state,
		started: { textStream, persistOutcome },
		/** Hold the turn after the first delta. */
		holdAfterFirst: () => {
			hold = true;
		},
		reached,
		release: () => release(),
	};
}

function typesOf(events: AGUIEvent[]): EventType[] {
	return events.map((event) => event.type);
}

function deltasOf(events: AGUIEvent[]): string[] {
	return events.flatMap((event) =>
		event.type === EventType.TEXT_MESSAGE_CONTENT ? [event.delta] : [],
	);
}

async function expectVerified(events: AGUIEvent[]): Promise<void> {
	await expect(
		lastValueFrom(
			from(events as BaseEvent[]).pipe(verifyEvents(false), toArray()),
		),
	).resolves.toHaveLength(events.length);
}

beforeEach(() => {
	vi.clearAllMocks();
	m.isFeatureEnabled.mockResolvedValue(true);
	m.rateLimit.mockResolvedValue(null);
	m.authorize.mockResolvedValue(undefined);
	m.getConversation.mockImplementation(async (ctx, request) =>
		visibleConversation(ctx, request),
	);
	m.chat.mockImplementation(async () => started(["Hel", "lo"]));
});

describe("the atlas-chat engine — refusals before the turn", () => {
	it("refuses FEATURE_DISABLED while COPILOTKIT_ATLAS_CHAT is off for the caller's organization, before any check", async () => {
		m.isFeatureEnabled.mockResolvedValue(false);

		const events = await run();

		expect(events).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "FEATURE_DISABLED",
			}),
		]);
		expect(m.isFeatureEnabled).toHaveBeenCalledWith(
			"COPILOTKIT_ATLAS_CHAT",
			ORG,
		);
		expect(m.authorize).not.toHaveBeenCalled();
		expect(m.getConversation).not.toHaveBeenCalled();
		expect(m.chat).not.toHaveBeenCalled();
		expect(m.failure).not.toHaveBeenCalled();
		expect(m.activity).not.toHaveBeenCalled();
	});

	it.each([
		["no project", { mode: "TECHNICAL" }],
		["an unknown mode", { projectId: PROJECT, mode: "OTHER" }],
	])(
		"refuses INVALID_REQUEST for options atlas.chat would refuse (%s)",
		async (_label, forwardedProps) => {
			const events = await run(input({ forwardedProps }));

			expect(events).toEqual([
				expect.objectContaining({
					type: EventType.RUN_ERROR,
					code: "INVALID_REQUEST",
				}),
			]);
			expect(m.isFeatureEnabled).not.toHaveBeenCalled();
			expect(m.authorize).not.toHaveBeenCalled();
			expect(m.chat).not.toHaveBeenCalled();
			expect(m.activity).not.toHaveBeenCalled();
		},
	);

	it("refuses NO_MESSAGE when the last message is not the person's question", async () => {
		const events = await run(input({ messages: CONVERSATION.slice(0, 3) }));

		expect(events).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "NO_MESSAGE",
			}),
		]);
		expect(m.authorize).not.toHaveBeenCalled();
		expect(m.chat).not.toHaveBeenCalled();
		expect(m.activity).not.toHaveBeenCalled();
	});

	it("refuses a caller over the request budget with the middleware's code and message, charged to the oRPC bucket, before any access check", async () => {
		m.rateLimit.mockResolvedValue(
			new ORPCError("TOO_MANY_REQUESTS", {
				message: "Rate limit exceeded. Please try again in 7 seconds.",
				data: { retryAfter: 7 },
			}),
		);

		const events = await run();

		expect(events).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "TOO_MANY_REQUESTS",
				message: "Rate limit exceeded. Please try again in 7 seconds.",
			}),
		]);
		expect(m.rateLimit).toHaveBeenCalledWith(
			expect.objectContaining({ user: { id: USER } }),
			"agents.runtime.atlas-chat",
		);
		expect(m.isFeatureEnabled).not.toHaveBeenCalled();
		expect(m.authorize).not.toHaveBeenCalled();
		expect(m.chat).not.toHaveBeenCalled();
		// The base refuses before the engine's checks, so this refusal has no
		// failure row, where `atlas.chat` writes `error.rate_limited` (an
		// accepted difference, named in the flag note).
		expect(m.failure).not.toHaveBeenCalled();
	});

	it.each([
		["NOT_FOUND", "Project not found"],
		["FORBIDDEN", "Missing required permission: ai:chat"],
		["BAD_REQUEST", "organizationId does not match the project"],
		["PRECONDITION_FAILED", "Connect a repository to ask about the code."],
	] as const)(
		"ends each access refusal with the procedure's code and message, before RUN_STARTED, records the failure row, and never starts the chat (%s)",
		async (code, message) => {
			const refusal = new ORPCError(code, { message });
			m.authorize.mockRejectedValue(refusal);

			const events = await run();

			expect(events).toEqual([
				expect.objectContaining({
					type: EventType.RUN_ERROR,
					code,
					message,
				}),
			]);
			expect(m.failure).toHaveBeenCalledTimes(1);
			expect(m.failure).toHaveBeenCalledWith(
				refusal,
				CALLER.audit,
				expect.objectContaining({
					projectId: PROJECT,
					organizationId: ORG,
					conversationId: THREAD,
				}),
				["atlas", "chat"],
			);
			expect(m.getConversation).not.toHaveBeenCalled();
			expect(m.chat).not.toHaveBeenCalled();
			expect(m.activity).not.toHaveBeenCalled();
		},
	);

	it("authorizes the runtime caller for the project the options name", async () => {
		await run();

		expect(m.authorize).toHaveBeenCalledWith(
			{ userId: USER, organizationId: ORG },
			PROJECT,
		);
	});

	it("refuses a thread that names a conversation the caller may not use with NOT_FOUND before RUN_STARTED, without taking the thread", async () => {
		const owner = salvagingChat(["Sessions ", "live in Redis."]);
		owner.holdAfterFirst();
		m.chat.mockResolvedValueOnce(owner.started);
		const ownerStream = collector();
		const owning = new AtlasChatEngine(CALLER).run(
			{ threadId: THREAD, input: input() },
			ownerStream,
		);
		await owner.reached;
		const otherCaller = callerOf(OTHER_USER);

		const intruder = await run(input(), otherCaller);

		// Not THREAD_ALREADY_RUNNING: the conversation check comes first.
		expect(intruder).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "NOT_FOUND",
				message: "Conversation not found.",
			}),
		]);
		expect(m.failure).toHaveBeenCalledWith(
			expect.objectContaining({ code: "NOT_FOUND" }),
			otherCaller.audit,
			expect.objectContaining({ conversationId: THREAD }),
			["atlas", "chat"],
		);
		owner.release();
		await owning;
		expect(m.chat).toHaveBeenCalledTimes(1);
		expect(ownerStream.events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
		});
		expect(deltasOf(ownerStream.events)).toEqual([
			"Sessions ",
			"live in Redis.",
		]);
	});

	it.each([
		[
			"the caller's own conversation from another organization",
			callerOf(USER, OTHER_ORG),
			PROPS,
		],
		[
			"a run whose options name another project",
			CALLER,
			{ ...PROPS, projectId: OTHER_PROJECT },
		],
	])(
		"refuses %s with NOT_FOUND before RUN_STARTED, reading the conversation in that tenant and project",
		async (_label, caller, forwardedProps) => {
			const events = await run(input({ forwardedProps }), caller);

			expect(events).toEqual([
				expect.objectContaining({
					type: EventType.RUN_ERROR,
					code: "NOT_FOUND",
					message: "Conversation not found.",
				}),
			]);
			expect(m.getConversation).toHaveBeenCalledWith(
				{ userId: USER, organizationId: caller.organizationId },
				{ conversationId: THREAD, projectId: forwardedProps.projectId },
			);
			expect(m.chat).not.toHaveBeenCalled();
			expect(m.activity).not.toHaveBeenCalled();
		},
	);
});

describe("the atlas-chat engine — the answer", () => {
	it("streams an answer as one assistant message between RUN_STARTED and RUN_FINISHED", async () => {
		const events = await run();

		await expectVerified(events);
		expect(typesOf(events)).toEqual([
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.RUN_FINISHED,
		]);
		expect(events[1]).toEqual({
			type: EventType.TEXT_MESSAGE_START,
			messageId: `${RUN}:answer`,
			role: "assistant",
		});
		expect(deltasOf(events)).toEqual(["Hel", "lo"]);
		// The conversation check, then the chat, both as the caller in ORG.
		expect(m.serviceCtx.mock.calls).toEqual([
			[{ userId: USER, organizationId: ORG }],
			[{ userId: USER, organizationId: ORG }],
		]);
		expect(m.getConversation).toHaveBeenCalledTimes(1);
		expect(m.getConversation).toHaveBeenCalledWith(
			{ userId: USER, organizationId: ORG },
			{ conversationId: THREAD, projectId: PROJECT },
		);
		expect(m.chat).toHaveBeenCalledWith({
			abortSignal: expect.any(AbortSignal),
			projectId: PROJECT,
			repositoryIntegrationId: "integration-1",
			mode: "TECHNICAL",
			focusNodeKey: "node-a",
			conversationId: THREAD,
			messages: [
				{ role: "user", content: "What does the auth module do?" },
				{ role: "assistant", content: "It handles sign-in." },
				{ role: "user", content: "Where are sessions stored?" },
			],
		});
	});

	it("passes repositoryIntegrationId null when the options omit it", async () => {
		await run(
			input({ forwardedProps: { projectId: PROJECT, mode: "BUSINESS" } }),
		);

		expect(m.chat).toHaveBeenCalledWith(
			expect.objectContaining({
				repositoryIntegrationId: null,
				mode: "BUSINESS",
				focusNodeKey: undefined,
			}),
		);
	});

	it("a lost write ends with CUSTOM fabric.atlas-chat.persist-failed after TEXT_MESSAGE_END and before RUN_FINISHED", async () => {
		m.chat.mockImplementation(async () =>
			started(["Hello"], { persisted: false, interrupted: false }),
		);

		const events = await run();

		await expectVerified(events);
		expect(events.slice(-3)).toEqual([
			{ type: EventType.TEXT_MESSAGE_END, messageId: `${RUN}:answer` },
			{
				type: EventType.CUSTOM,
				name: "fabric.atlas-chat.persist-failed",
				value: {},
			},
			{ type: EventType.RUN_FINISHED, threadId: THREAD, runId: RUN },
		]);
	});

	it("a cut-short reply ends with CUSTOM fabric.atlas-chat.interrupted; an error before the first token sends no text message, only the note", async () => {
		m.chat.mockImplementation(async () =>
			started(["Partial"], { persisted: true, interrupted: true }),
		);
		const partial = await run();
		await expectVerified(partial);
		expect(typesOf(partial)).toEqual([
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.CUSTOM,
			EventType.RUN_FINISHED,
		]);
		expect(partial[4]).toMatchObject({
			name: "fabric.atlas-chat.interrupted",
		});

		m.chat.mockImplementation(async () =>
			started([], { persisted: true, interrupted: true }),
		);
		const nothing = await run();
		await expectVerified(nothing);
		expect(nothing).toEqual([
			{ type: EventType.RUN_STARTED, threadId: THREAD, runId: RUN },
			{
				type: EventType.CUSTOM,
				name: "fabric.atlas-chat.interrupted",
				value: {},
			},
			{ type: EventType.RUN_FINISHED, threadId: THREAD, runId: RUN },
		]);
	});

	it("a lost write outranks an interruption", async () => {
		m.chat.mockImplementation(async () =>
			started(["Part"], { persisted: false, interrupted: true }),
		);

		const events = await run();

		expect(
			events.flatMap((event) =>
				event.type === EventType.CUSTOM ? [event.name] : [],
			),
		).toEqual(["fabric.atlas-chat.persist-failed"]);
	});

	it("drops empty deltas", async () => {
		m.chat.mockImplementation(async () => started(["", "a", "", "b"]));

		const events = await run();

		await expectVerified(events);
		expect(deltasOf(events)).toEqual(["a", "b"]);
	});

	it.each([
		[
			"an analysis that is not ready",
			() =>
				new AtlasError(
					"NOT_FOUND",
					"This repository has not been analysed yet.",
				),
			"NOT_FOUND",
			"This repository has not been analysed yet.",
			404,
		],
		[
			"no AI provider",
			() =>
				new AIProviderNotConfiguredError(
					"No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
				),
			"PRECONDITION_FAILED",
			"No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
			412,
		],
		[
			"a question that could not be saved",
			() =>
				new AtlasError("PERSISTENCE_FAILED", "The turn was not saved."),
			"INTERNAL_SERVER_ERROR",
			"The turn was not saved.",
			500,
		],
	])(
		"a service refusal before the stream ends the run with the procedure's code and message and records the failure row (%s)",
		async (_label, refusal, code, message, status) => {
			m.chat.mockRejectedValue(refusal());

			const events = await run();

			expect(events).toEqual([
				{ type: EventType.RUN_STARTED, threadId: THREAD, runId: RUN },
				expect.objectContaining({
					type: EventType.RUN_ERROR,
					code,
					message,
					metadata: {
						fabric: expect.objectContaining({ status, code }),
					},
				}),
			]);
			expect(m.failure).toHaveBeenCalledTimes(1);
			const [recorded, audit, call, path] = m.failure.mock.calls[0] ?? [];
			expect(recorded).toBeInstanceOf(ORPCError);
			expect(recorded).toMatchObject({ code, message });
			expect(audit).toBe(CALLER.audit);
			expect(call).toMatchObject({
				projectId: PROJECT,
				organizationId: ORG,
			});
			expect(path).toEqual(["atlas", "chat"]);
			expect(m.activity).not.toHaveBeenCalled();
		},
	);

	it("records the procedure's activity row once the chat starts", async () => {
		await run();

		expect(m.activity).toHaveBeenCalledTimes(1);
		expect(m.activity).toHaveBeenCalledWith(CALLER.audit, {
			path: ["atlas", "chat"],
			input: expect.objectContaining({
				projectId: PROJECT,
				organizationId: ORG,
				conversationId: THREAD,
			}),
		});
		expect(m.failure).not.toHaveBeenCalled();
	});
});

describe("the atlas-chat engine — stopping", () => {
	it.each(["deadline", "stop", "closed response"] as const)(
		"ends and salvages a reply stalled between tokens on %s",
		async (cause) => {
			vi.useFakeTimers({
				toFake: [
					"Date",
					"setTimeout",
					"clearTimeout",
					"setInterval",
					"clearInterval",
				],
			});
			let chat: ReturnType<typeof salvagingChat> | undefined;
			let reached = () => {};
			const ready = new Promise<void>((resolve) => {
				reached = resolve;
			});
			m.chat.mockImplementation(
				async (options: { abortSignal?: AbortSignal }) => {
					chat = salvagingChat(
						["Partial", " late"],
						options.abortSignal,
					);
					chat.holdAfterFirst();
					void chat.reached.then(reached);
					return chat.started;
				},
			);
			const stream = collector();
			let finished = false;
			const engine = new AtlasChatEngine(CALLER);
			const running = engine
				.run({ threadId: THREAD, input: input() }, stream)
				.then(() => {
					finished = true;
				});
			try {
				await ready;
				if (cause === "deadline") {
					await vi.advanceTimersByTimeAsync(270_000);
				} else if (cause === "stop") {
					await engine.stop(THREAD);
					await vi.advanceTimersByTimeAsync(0);
				} else {
					stream.close();
					await vi.advanceTimersByTimeAsync(250);
				}
				expect(finished).toBe(true);
				expect(deltasOf(stream.events)).toEqual(["Partial"]);
				expect(stream.events).toContainEqual({
					type: EventType.CUSTOM,
					name: "fabric.atlas-chat.interrupted",
					value: {},
				});
				expect(stream.events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
				expect(chat?.state.returned).toBe(true);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				chat?.release();
				await running;
				vi.useRealTimers();
			}
		},
	);

	it("stop mid-answer stops reading; the service salvages the partial as interrupted", async () => {
		const chat = salvagingChat(["a", "b", "c"]);
		m.chat.mockResolvedValue(chat.started);
		const engine = new AtlasChatEngine(CALLER);
		const stream = collector((event) => {
			if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
				void engine.stop(THREAD);
			}
		});

		await engine.run({ threadId: THREAD, input: input() }, stream);

		expect(typesOf(stream.events)).toEqual([
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.CUSTOM,
			EventType.RUN_FINISHED,
		]);
		expect(deltasOf(stream.events)).toEqual(["a"]);
		expect(stream.events[4]).toMatchObject({
			name: "fabric.atlas-chat.interrupted",
		});
		expect(chat.state.returned).toBe(true);
	});

	it("a response the client closed stops reading the same way, and frees the thread", async () => {
		const chat = salvagingChat(["a", "b", "c"]);
		chat.holdAfterFirst();
		m.chat.mockResolvedValueOnce(chat.started);
		const engine = new AtlasChatEngine(CALLER);
		const stream = collector();

		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const running = engine.run(
				{ threadId: THREAD, input: input() },
				stream,
			);
			await chat.reached;
			stream.close();
			vi.advanceTimersByTime(250);
			expect(await engine.isRunning(THREAD)).toBe(false);
			chat.release();
			await running;
		} finally {
			vi.useRealTimers();
		}

		expect(chat.state.returned).toBe(true);
		expect(deltasOf(stream.events)).toEqual(["a"]);
		const next = await run();
		expect(next[0]).toMatchObject({ type: EventType.RUN_STARTED });
		expect(next.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
	});

	it("an answer still streaming at the route's time limit stops there: the client gets what is saved, marked interrupted, and the run finishes", async () => {
		const chat = salvagingChat(["a", "b", "c"]);
		chat.holdAfterFirst();
		m.chat.mockResolvedValueOnce(chat.started);
		const stream = collector();

		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const engine = new AtlasChatEngine(CALLER);
			const running = engine.run(
				{ threadId: THREAD, input: input() },
				stream,
			);
			await chat.reached;
			// 270 s after the request began: the runtime route's 300 s
			// maxDuration less the headroom to save and end the run.
			vi.setSystemTime(Date.now() + 270_000);
			chat.release();
			await running;
		} finally {
			vi.useRealTimers();
		}

		await expectVerified(stream.events);
		expect(typesOf(stream.events)).toEqual([
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.CUSTOM,
			EventType.RUN_FINISHED,
		]);
		expect(deltasOf(stream.events)).toEqual(["a", "b"]);
		expect(stream.events[5]).toMatchObject({
			name: "fabric.atlas-chat.interrupted",
		});
		expect(chat.state.returned).toBe(true);
	});
});
