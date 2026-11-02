import {
	type AGUIEvent,
	contentToText,
	EventType,
	type Message,
	type RunAgentInput,
} from "@ag-ui/client";
import { ORPCError } from "@orpc/client";
import {
	chatGptPlanExhaustedChatResponse,
	chatGptPlanReconnectRefusal,
} from "@repo/ai/lib/chatgpt-plan/agent-config";
import { aiUsageLimitToORPCError } from "@repo/api/lib/ai-usage-limit-errors";
import { rpcRateLimitRefusal } from "@repo/api/orpc/middleware/rpc-rate-limit-middleware";
import { RetryError } from "ai";
import type { z } from "zod";
import type { RunStream, RuntimeCaller, RuntimeEngine } from "./engine";
import { refuse, refuseWithResponse } from "./run-errors";

/**
 * The engine for a request/reply chat that has no Temporal workflow (library
 * chat, Sidekick, refinement): the run happens inside the request. Most such
 * chats save nothing; a chat may persist through its own service (Atlas).
 * Its thread is not an `AgentConversation`, so the endpoint lets it through
 * and the engine checks its own resource (a workspace, a project, an agent)
 * in `admit`, before any model call.
 *
 * - `run`: charges the request to the caller's oRPC budget
 *   (`rpc:user:<id>`), validates `forwardedProps` with the agent's schema,
 *   admits the request, then streams the turn's AG-UI events between
 *   RUN_STARTED and RUN_FINISHED. A refusal or a throw, before or during the
 *   turn, ends the run with RUN_ERROR (`fail`): a refusal the member can act
 *   on worded and coded as the chat routes answer it, anything else a
 *   generic failure.
 * - `connect`: replays nothing and finishes: there is no run to reattach to.
 * - `stop`, or the client closing the response: aborts the turn's signal;
 *   the turn decides what it still owes (a model call already sent is still
 *   billed).
 * - `isRunning`: true only while the request that runs the turn is open; a
 *   closed response frees the thread for the next run at once.
 *
 * Running turns are kept per process, so a stop reaches a turn only on the
 * instance that runs it; elsewhere it finds nothing and the client's own
 * abort ends the response.
 */

/** A refusal a turn (or `admit`) throws: the run ends with its code and message. */
export class InProcessTurnError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "InProcessTurnError";
	}
}

/** A request the engine refused before its turn started. */
interface InProcessRefusal {
	code: string;
	message: string;
}

export type InProcessAdmission<Turn> =
	| { ok: true; turn: Turn }
	| ({ ok: false } & InProcessRefusal)
	/** A stream route's own refusal (its JSON error response), sent as is. */
	| { ok: false; refusal: Response };

/** The run a turn streams into. */
export interface InProcessRun {
	threadId: string;
	runId: string;
	/** Aborted by `stop`, or once the client closed the response. */
	signal: AbortSignal;
}

/** A text message of a request/reply chat's conversation. */
export interface RequestReplyMessage {
	role: "user" | "assistant";
	content: string;
}

/**
 * A request/reply run's conversation: its question (the last text message,
 * the person's, not blank) and the text messages before it. Null when the
 * run carries no new question.
 */
export function requestReplyConversation(messages: readonly Message[]): {
	question: string;
	history: RequestReplyMessage[];
} | null {
	const conversation = messages.flatMap((message): RequestReplyMessage[] =>
		message.role === "user" || message.role === "assistant"
			? [{ role: message.role, content: contentToText(message.content) }]
			: [],
	);
	const last = conversation.at(-1);
	const question = last?.role === "user" ? last.content.trim() : "";
	return question ? { question, history: conversation.slice(0, -1) } : null;
}

interface RunningTurn {
	userId: string;
	organizationId: string;
	runId: string;
	controller: AbortController;
}

const running = new Map<string, RunningTurn>();

/** How often a running turn checks whether its client went away. */
const CLOSE_POLL_MS = 250;

function runningKey(agentId: string, threadId: string): string {
	return `${agentId}\u0000${threadId}`;
}

export abstract class InProcessEngine<Props, Turn> implements RuntimeEngine {
	/** The runtime agent id this engine serves. */
	abstract readonly agentId: string;
	/** The agent's `forwardedProps`: the request context its turn needs. */
	protected abstract readonly propsSchema: z.ZodType<Props>;

	constructor(protected readonly caller: RuntimeCaller) {}

	/**
	 * Check the caller may run this turn (rollout flag, the resource's own
	 * access check) and gather what the turn needs. Runs before RUN_STARTED
	 * and before any model call; a throw ends the run as `fail` maps it.
	 */
	protected abstract admit(request: {
		threadId: string;
		input: RunAgentInput;
		props: Props;
	}): Promise<InProcessAdmission<Turn>>;

	/** The turn's events between RUN_STARTED and RUN_FINISHED. */
	protected abstract turn(
		turn: Turn,
		run: InProcessRun,
	): AsyncIterable<AGUIEvent>;

	async run(
		{ threadId, input }: { threadId: string; input: RunAgentInput },
		stream: RunStream,
	): Promise<void> {
		let admission: InProcessAdmission<Turn>;
		try {
			admission = await this.admitRequest(threadId, input);
		} catch (error) {
			await this.fail(stream, error);
			return;
		}
		if (!admission.ok) {
			if ("refusal" in admission) {
				await refuseWithResponse(stream, admission.refusal);
			} else {
				refuse(stream, admission.code, admission.message);
			}
			return;
		}
		if (stream.isClosed()) {
			return;
		}
		const key = runningKey(this.agentId, threadId);
		if (running.has(key)) {
			refuse(
				stream,
				"THREAD_ALREADY_RUNNING",
				"This chat is still answering.",
			);
			return;
		}
		const controller = new AbortController();
		running.set(key, {
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
			runId: input.runId,
			controller,
		});
		// The thread is free again once its request ends, however it ends:
		// a response the client closed counts as a stop.
		const release = () => {
			if (running.get(key)?.controller === controller) {
				running.delete(key);
			}
		};
		const watch = setInterval(() => {
			if (stream.isClosed()) {
				controller.abort();
				release();
			}
		}, CLOSE_POLL_MS);
		const { runId } = input;
		try {
			stream.emit({ type: EventType.RUN_STARTED, threadId, runId });
			for await (const event of this.turn(admission.turn, {
				threadId,
				runId,
				signal: controller.signal,
			})) {
				stream.emit(event);
			}
			stream.emit({ type: EventType.RUN_FINISHED, threadId, runId });
		} catch (error) {
			await this.fail(stream, error);
		} finally {
			clearInterval(watch);
			release();
		}
	}

	async connect(_threadId: string, _stream: RunStream): Promise<void> {}

	async isRunning(threadId: string): Promise<boolean> {
		return this.ownRun(threadId) !== null;
	}

	async stop(threadId: string, runId?: string): Promise<boolean> {
		const turn = this.ownRun(threadId);
		if (!turn || (runId && turn.runId !== runId)) {
			return false;
		}
		turn.controller.abort();
		return true;
	}

	/**
	 * Everything a request must pass before its turn: the caller's request
	 * budget (the oRPC floor; an engine with a stricter limit adds it in
	 * `admit`), the agent's props, then the engine's own `admit`.
	 */
	private async admitRequest(
		threadId: string,
		input: RunAgentInput,
	): Promise<InProcessAdmission<Turn>> {
		const limited = await rpcRateLimitRefusal(
			{
				headers: this.caller.audit.headers ?? new Headers(),
				user: { id: this.caller.userId },
			},
			`agents.runtime.${this.agentId}`,
		);
		if (limited) {
			return { ok: false, refusal: procedureResponse(limited) };
		}
		const props = this.propsSchema.safeParse(input.forwardedProps ?? {});
		if (!props.success) {
			return {
				ok: false,
				code: "INVALID_REQUEST",
				message: "The run's options are invalid.",
			};
		}
		return this.admit({ threadId, input, props: props.data });
	}

	/** The thread's running turn, when the caller started it. */
	private ownRun(threadId: string): RunningTurn | null {
		const turn = running.get(runningKey(this.agentId, threadId));
		return turn &&
			turn.userId === this.caller.userId &&
			turn.organizationId === this.caller.organizationId
			? turn
			: null;
	}

	/**
	 * A failed request's end: the engine's own refusal, a refusal written for
	 * the member, worded and coded as the chat routes answer it, or a
	 * generic failure, its detail kept to the server log.
	 */
	private async fail(stream: RunStream, error: unknown): Promise<void> {
		if (error instanceof InProcessTurnError) {
			refuse(stream, error.code, error.message);
			return;
		}
		const refusal =
			planRefusal(error) ??
			usageLimitRefusal(error) ??
			(error instanceof ORPCError ? procedureResponse(error) : null) ??
			providerRefusal(error);
		if (refusal) {
			await refuseWithResponse(stream, refusal);
			return;
		}
		console.error(`[Agent Runtime] ${this.agentId} turn failed`, error);
		refuse(stream, "RUN_FAILED", "The reply failed. Please try again.");
	}
}

/** The errors a model call can end with, as thrown or inside the AI SDK's `RetryError`. */
function causesOf(error: unknown): unknown[] {
	return RetryError.isInstance(error)
		? [error, error.lastError, ...error.errors]
		: [error];
}

/**
 * The chat routes' answer to a ChatGPT plan that cannot serve the call: one
 * to reconnect or a model it does not serve (409), or a spent plan with its
 * reset time and the provider's own code, which the client's limit
 * classifier reads (429).
 */
function planRefusal(error: unknown): Response | null {
	for (const cause of causesOf(error)) {
		const reconnect = chatGptPlanReconnectRefusal(cause);
		if (reconnect) {
			return Response.json(reconnect.body, { status: reconnect.status });
		}
		const exhausted = chatGptPlanExhaustedChatResponse(cause);
		if (exhausted) {
			return exhausted;
		}
	}
	return null;
}

/**
 * A HARD AI usage limit as the chat routes answer it (429), with the limits
 * the shared limit toast reads.
 */
function usageLimitRefusal(error: unknown): Response | null {
	const limit = aiUsageLimitToORPCError(error);
	return limit
		? Response.json(
				{ error: limit.message, code: limit.code, data: limit.data },
				{ status: 429 },
			)
		: null;
}

/**
 * An oRPC refusal (the request floor, or one a procedure's own code threw
 * inside a turn) as the procedure answers it.
 */
function procedureResponse(error: ORPCError<string, unknown>): Response {
	return Response.json(
		{ error: error.message, code: error.code, data: error.data },
		{ status: error.status },
	);
}

/**
 * The AI configuration cannot serve the call (no AI provider, or an
 * embedding model whose vectors the document index cannot store): its
 * message tells the member what to configure. Matched by name (`@repo/ai`
 * sets it), so the base does not load the `@repo/ai` index.
 */
function providerRefusal(error: unknown): Response | null {
	if (!(error instanceof Error)) {
		return null;
	}
	const refusal = PROVIDER_REFUSALS.get(error.name);
	return refusal
		? Response.json(
				{ error: error.message, code: refusal.code },
				{ status: refusal.status },
			)
		: null;
}

/** The configuration errors `providerRefusal` passes on, by name. */
const PROVIDER_REFUSALS: ReadonlyMap<string, { code: string; status: number }> =
	new Map([
		[
			"AIProviderNotConfiguredError",
			{ code: "AI_PROVIDER_NOT_CONFIGURED", status: 400 },
		],
		// The 412 the procedures answer it with (PRECONDITION_FAILED).
		[
			"UnsupportedEmbeddingModelError",
			{ code: "EMBEDDING_MODEL_UNSUPPORTED", status: 412 },
		],
	]);
