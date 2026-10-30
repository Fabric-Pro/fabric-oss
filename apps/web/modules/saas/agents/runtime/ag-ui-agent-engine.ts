/**
 * The durable engine for CopilotKit's LangGraph assistants: one AG-UI run is
 * one Temporal workflow (`agUiAgentRunWorkflow`, id `agui-run-<runId>`) whose
 * activity runs the agent on the worker and appends its events to a Redis
 * stream (`@repo/temporal/agui-run-stream`). A response replays and tails
 * that stream, so a closed tab never ends the run, and the next mount's
 * `connect` reattaches to it.
 *
 * Thread. The assistants' thread id is their persisted conversation's id
 * (`assistant-thread.tsx`). A thread that names an `AgentConversation` must
 * be the caller's, in the caller's organization; beyond that, a Redis record
 * per thread (`agui:thread:<threadId>`: owner, organization, latest run,
 * workflow) is written on each run and must name the caller too. Anything
 * else is someone else's thread and is refused on run, connect and stop.
 *
 * Run. The input is parked in Redis (it carries the whole document; Temporal
 * payloads stop at 2 MB) together with the AI token the route minted for the
 * request, and the workflow gets a reference, the caller's ids and the model
 * hints the route resolved — nothing secret. The worker holds no
 * token-signing secret: it takes the record (deleting it) on pickup and reads
 * its own `AGENT_API_KEY`. A retried
 * run id attaches to its workflow (after checking the workflow is this
 * caller's run on this thread) and never runs the agent twice. A new run
 * while the thread's latest run is still producing is refused with
 * `THREAD_ALREADY_RUNNING`, as CopilotKit's own runner refuses it.
 *
 * Connect. A live run is replayed from its start and tailed. A finished run
 * is replayed only when its assistant messages are not in the conversation
 * yet — the tab died before the client's persistence hook saved them, and the
 * hook saves them from the replay (idempotent by message id); otherwise
 * history is already on the page, rendered from the database, and a replay
 * would duplicate it. A replay leaves out messages the conversation has.
 * "Saved" includes the conversations continuing the thread's (a spill at the
 * turn cap, or a fork of it), where the page saves turns after a spill.
 *
 * Window. A response tails for at most the runner's window. The v1 client
 * does not reconnect when a run stream ends without a terminal event, so the
 * route sizes the window to cover a whole run; a run that outlives it keeps
 * running and the next mount's `connect` picks it up.
 *
 * Fallback. The durable path never leaves an assistant worse off than the
 * in-request run it replaces. When the run store cannot be opened or written,
 * the workflow cannot be started, or a started run shows no first event
 * within `AGUI_RUN_PICKUP_TIMEOUT_MS` (a web deploy that reached the browser
 * before the worker learned `agUiAgentRunWorkflow`, or a worker that is down
 * or saturated), the not-yet-picked-up workflow is terminated (best effort)
 * and the request's agent runs in-process on CopilotKit's runner, exactly as
 * before durable runs. That happens only before the client has seen any
 * event of the durable run, never mid-stream, and it writes no thread
 * record, so `connect`, `isRunning` and `stop` treat the thread as before.
 *
 * A worker that picked the run up can still fail its setup (the input record
 * gone, no `AGENT_API_KEY`, no agent URL, an agent that never answered): its
 * activity then ends the run with `AGUI_RUN_SETUP_FAILED`. A run this request
 * started holds the activity's `RUN_STARTED` back until the next event, so on
 * that terminal the client has still seen nothing and the turn runs
 * in-process as above. The thread record already names the failed run; its
 * stream holds only those two events, so `connect` and `isRunning` treat it
 * as an ended run with nothing to replay.
 *
 * Known race: a worker that picks the run up in the instant between the
 * pickup timeout and the terminate starts the agent and then aborts it on
 * its next heartbeat (at most ~10 s), while the in-process run also runs.
 */
import {
	type AbstractAgent,
	type AGUIEvent,
	type BaseEvent,
	EventType,
	type Message,
	type RunAgentInput,
} from "@ag-ui/client";
import { EventSchemas } from "@ag-ui/core/schemas";
import type { AgentRunner } from "@copilotkit/runtime/v2";
import { getTemporalClient } from "@repo/temporal";
import {
	AGUI_RUN_SETUP_FAILED_CODE,
	AGUI_RUN_TASK_QUEUE,
	AGUI_RUN_WORKFLOW,
	type AgUiAgentRunWorkflowInput,
	type AgUiModelHints,
	type AgUiRunStore,
	type AgUiThreadRecord,
	agUiRunWorkflowId,
	isTerminalRunEvent,
	openAgUiRunStore,
	STREAM_START,
	type StoredRunEvent,
} from "@repo/temporal/agui-run-stream";
import { classifyTemporalClientError } from "@repo/temporal/temporal-client-errors";
import type { Observable } from "rxjs";
import type { RunStream, RuntimeCaller, RuntimeEngine } from "./engine";
import { readThreadAccess, readThreadPersistedMessageIds } from "./thread";

/** The CopilotKit agent this engine runs durably. */
export const AG_UI_DURABLE_AGENT_ID = "project_document_generator";

/**
 * How long a started run may go without its first event before the request
 * takes it back and runs the agent in-process. The worker's activity writes
 * `RUN_STARTED` before it sets up or calls the agent, so this measures
 * the worker's pickup alone: a workflow type the worker does not know yet (the
 * web deploys separately from the worker), a worker that is down, or a full
 * activity queue.
 */
const AGUI_RUN_PICKUP_TIMEOUT_MS = 15_000;

/** The AG-UI run id names Redis keys and the workflow: the chat routes' key format. */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * How long one blocking stream read waits before the tail checks the
 * response and the workflow again.
 */
const TAIL_BLOCK_MS = 5000;

/** What the route resolved for this request's runs. */
export interface AgUiRunSettings {
	modelHints: AgUiModelHints;
	/**
	 * The AI token the route minted for this request. Secret: it goes to the
	 * worker only inside the run's Redis input record.
	 */
	aiToken: string;
}

export interface AgUiAgentEngineOptions {
	/**
	 * Runs the request's agent in-process when the durable path cannot take
	 * the run: CopilotKit's in-memory runner on `/api/copilotkit`.
	 */
	inProcess: AgentRunner;
	agentName?: string;
	pickupTimeoutMs?: number;
}

type EngineCaller = Pick<RuntimeCaller, "userId" | "organizationId">;

type ThreadAccess =
	| { kind: "allowed"; record: AgUiThreadRecord | null }
	| { kind: "forbidden" };

/** How a run's workflow was taken on, or why it could not be. */
type WorkflowStart =
	| { kind: "started" }
	| { kind: "attached" }
	| { kind: "forbidden" }
	| { kind: "unavailable"; reason: string; error: unknown };

interface RunRequest {
	threadId: string;
	input: RunAgentInput;
	agent: AbstractAgent;
}

/**
 * How a tail ended: the response got the run (or its window ended), or the
 * worker failed the run's setup before anything reached the response.
 */
type TailEnd = { kind: "ended" } | { kind: "setupFailed"; message: string };

const TAIL_ENDED: TailEnd = { kind: "ended" };

/** The activity's terminal for a run that failed before the agent's first event. */
function isSetupFailure(event: BaseEvent): boolean {
	return (
		event.type === EventType.RUN_ERROR &&
		event.code === AGUI_RUN_SETUP_FAILED_CODE
	);
}

const FORBIDDEN: AGUIEvent = {
	type: EventType.RUN_ERROR,
	message: "This thread is not accessible.",
	code: "FORBIDDEN",
};

function isAguiEvent(event: BaseEvent): event is AGUIEvent {
	return EventSchemas.safeParse(event).success;
}

/**
 * An event as the response sends it, unchanged, once it passes AG-UI's
 * event schemas; one that fails is left out.
 */
function emitChecked(stream: RunStream, event: BaseEvent): void {
	if (isAguiEvent(event)) {
		stream.emit(event);
	} else {
		console.warn("[Agent Runtime] Skipping an invalid run event", {
			type: event.type,
		});
	}
}

/** Emit an in-process run's events into the response until it ends. */
function pipeTo(
	stream: RunStream,
	events: Observable<BaseEvent>,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		events.subscribe({
			next: (event) => emitChecked(stream, event),
			error: reject,
			complete: resolve,
		});
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function messageIdOf(event: BaseEvent): string | undefined {
	const value = event.messageId;
	return typeof value === "string" ? value : undefined;
}

function isMessageList(value: unknown): value is Message[] {
	return (
		Array.isArray(value) &&
		value.every(
			(message) =>
				typeof message === "object" &&
				message !== null &&
				"id" in message &&
				typeof message.id === "string",
		)
	);
}

/** The assistant message ids a run produced (its text, and its tool calls' parents). */
function assistantMessageIds(events: StoredRunEvent[]): Set<string> {
	const ids = new Set<string>();
	for (const { event } of events) {
		if (event.type === EventType.TEXT_MESSAGE_START) {
			const id = messageIdOf(event);
			if (id) {
				ids.add(id);
			}
		} else if (event.type === EventType.TOOL_CALL_START) {
			const parent = event.parentMessageId;
			if (typeof parent === "string") {
				ids.add(parent);
			}
		}
	}
	return ids;
}

/**
 * The event as a reattaching client should see it: without the messages the
 * conversation already holds, which the page renders from the database.
 */
function withoutPersisted(
	event: BaseEvent,
	persisted: ReadonlySet<string>,
): BaseEvent | null {
	const messageId = messageIdOf(event);
	if (messageId && persisted.has(messageId)) {
		return null;
	}
	if (event.type === EventType.MESSAGES_SNAPSHOT) {
		return isMessageList(event.messages)
			? {
					...event,
					messages: event.messages.filter(
						(message) => !persisted.has(message.id),
					),
				}
			: event;
	}
	if (event.type === EventType.RUN_STARTED) {
		const input = event.input;
		if (
			typeof input === "object" &&
			input !== null &&
			"messages" in input &&
			isMessageList(input.messages)
		) {
			return {
				...event,
				input: {
					...input,
					messages: input.messages.filter(
						(message) => !persisted.has(message.id),
					),
				},
			};
		}
	}
	return event;
}

export class AgUiAgentEngine implements RuntimeEngine {
	private readonly agentName: string;
	private readonly pickupTimeoutMs: number;

	constructor(
		private readonly caller: EngineCaller,
		private readonly settings: AgUiRunSettings,
		private readonly options: AgUiAgentEngineOptions,
	) {
		this.agentName = options.agentName ?? AG_UI_DURABLE_AGENT_ID;
		this.pickupTimeoutMs =
			options.pickupTimeoutMs ?? AGUI_RUN_PICKUP_TIMEOUT_MS;
	}

	async run(request: RunRequest, stream: RunStream): Promise<void> {
		const { threadId, input } = request;
		if (!RUN_ID_PATTERN.test(input.runId) || input.threadId !== threadId) {
			stream.emit({
				type: EventType.RUN_ERROR,
				message: "This run id is not valid.",
				code: "INVALID_RUN",
			});
			return;
		}
		let store: AgUiRunStore;
		try {
			store = await openAgUiRunStore();
		} catch (error) {
			if (
				(await readThreadAccess(threadId, this.caller)).kind ===
				"forbidden"
			) {
				stream.emit(FORBIDDEN);
				return;
			}
			await this.runInProcess(
				request,
				stream,
				"run store unavailable",
				error,
			);
			return;
		}
		try {
			const access = await this.access(threadId, store);
			switch (access.kind) {
				case "forbidden":
					stream.emit(FORBIDDEN);
					return;
				case "allowed":
					break;
				default: {
					const unhandled: never = access;
					throw new Error(
						`Unhandled thread access: ${JSON.stringify(unhandled)}`,
					);
				}
			}
			const { record } = access;
			if (
				record &&
				record.latestRunId !== input.runId &&
				(await this.isLive(store, record))
			) {
				stream.emit({
					type: EventType.RUN_ERROR,
					message:
						"The assistant is still answering in this conversation. Wait for it to finish, or stop it.",
					code: "THREAD_ALREADY_RUNNING",
				});
				return;
			}
			const workflowId = agUiRunWorkflowId(input.runId);
			const start = await this.startOrAttach(
				store,
				threadId,
				input,
				workflowId,
			);
			switch (start.kind) {
				case "forbidden":
					stream.emit(FORBIDDEN);
					return;
				case "unavailable":
					await this.runInProcess(
						request,
						stream,
						start.reason,
						start.error,
					);
					return;
				case "started":
					if (!(await this.pickedUp(store, input.runId))) {
						await this.abandon(workflowId);
						await this.runInProcess(
							request,
							stream,
							"the worker did not pick the run up",
							null,
						);
						return;
					}
					break;
				case "attached":
					break;
				default: {
					const unhandled: never = start;
					throw new Error(
						`Unhandled workflow start: ${JSON.stringify(unhandled)}`,
					);
				}
			}
			await store.writeThread(threadId, {
				userId: this.caller.userId,
				organizationId: this.caller.organizationId,
				latestRunId: input.runId,
				workflowId,
			});
			const end = await this.tail(
				store,
				input.runId,
				workflowId,
				STREAM_START,
				stream,
				start.kind === "started",
			);
			switch (end.kind) {
				case "ended":
					return;
				case "setupFailed":
					// Nothing reached the client: run the turn here instead.
					await this.runInProcess(
						request,
						stream,
						`worker setup failed: ${end.message}`,
						null,
					);
					return;
				default: {
					const unhandled: never = end;
					throw new Error(
						`Unhandled tail end: ${JSON.stringify(unhandled)}`,
					);
				}
			}
		} finally {
			await store.close();
		}
	}

	async connect(threadId: string, stream: RunStream): Promise<void> {
		let store: AgUiRunStore;
		try {
			store = await openAgUiRunStore();
		} catch (error) {
			// A reattach is best effort: the page already shows the saved
			// history, and a failed connect would only toast an error.
			console.error("[Agent Runtime] Durable run store unavailable", {
				error: errorMessage(error),
			});
			if (
				(await readThreadAccess(threadId, this.caller)).kind ===
				"forbidden"
			) {
				stream.emit(FORBIDDEN);
				return;
			}
			await this.connectInProcess(threadId, stream);
			return;
		}
		try {
			const access = await this.access(threadId, store);
			if (access.kind === "forbidden") {
				stream.emit(FORBIDDEN);
				return;
			}
			const { record } = access;
			if (!record) {
				await this.connectInProcess(threadId, stream);
				return;
			}
			const events = await store.readEvents(
				record.latestRunId,
				STREAM_START,
			);
			const finished = events.some(({ event }) =>
				isTerminalRunEvent(event),
			);
			const live =
				!finished && (await this.isWorkflowRunning(record.workflowId));
			const persisted =
				finished || live
					? await this.persistedMessageIds(threadId)
					: new Set<string>();
			if (
				!live &&
				(!finished ||
					[...assistantMessageIds(events)].every((id) =>
						persisted.has(id),
					))
			) {
				// No durable run to show: a run that fell back is the
				// in-process runner's to replay.
				await this.connectInProcess(threadId, stream);
				return;
			}
			for (const { event } of events) {
				const replayed = withoutPersisted(event, persisted);
				if (replayed) {
					emitChecked(stream, replayed);
				}
			}
			if (live) {
				await this.tail(
					store,
					record.latestRunId,
					record.workflowId,
					events.at(-1)?.id ?? STREAM_START,
					stream,
				);
			}
		} finally {
			await store.close();
		}
	}

	async isRunning(threadId: string): Promise<boolean> {
		const store = await this.openStoreQuietly();
		if (!store) {
			return false;
		}
		try {
			const record = await this.ownRecord(threadId, store);
			return record !== null && (await this.isLive(store, record));
		} finally {
			await store.close();
		}
	}

	async stop(threadId: string, runId?: string): Promise<boolean> {
		const store = await this.openStoreQuietly();
		if (!store) {
			return false;
		}
		try {
			const record = await this.ownRecord(threadId, store);
			if (
				!record ||
				(runId !== undefined && runId !== record.latestRunId) ||
				!(await this.isWorkflowRunning(record.workflowId))
			) {
				return false;
			}
			const temporal = await getTemporalClient();
			// The activity sees the cancellation on its next heartbeat, aborts
			// the agent's request and ends the stream with a cancelled run.
			await temporal.workflow.getHandle(record.workflowId).cancel();
			return true;
		} finally {
			await store.close();
		}
	}

	/**
	 * Whether the thread is someone else's, for the route's guard. With Redis
	 * unreachable only the conversation is checked: the engine itself serves
	 * nothing then, so the record has nothing to protect.
	 */
	async refusesThread(threadId: string): Promise<boolean> {
		if (
			(await readThreadAccess(threadId, this.caller)).kind === "forbidden"
		) {
			return true;
		}
		const store = await this.openStoreQuietly();
		if (!store) {
			return false;
		}
		try {
			const record = await store.readThread(threadId);
			return record !== null && !this.owns(record);
		} finally {
			await store.close();
		}
	}

	/**
	 * The run store, or null when Redis is unreachable: then no durable run
	 * exists to answer for, and the in-process runner answers instead.
	 */
	private async openStoreQuietly(): Promise<AgUiRunStore | null> {
		try {
			return await openAgUiRunStore();
		} catch {
			return null;
		}
	}

	/** Owner check: the conversation the id names, then the thread's run record. */
	private async access(
		threadId: string,
		store: AgUiRunStore,
	): Promise<ThreadAccess> {
		if (
			(await readThreadAccess(threadId, this.caller)).kind === "forbidden"
		) {
			return { kind: "forbidden" };
		}
		const record = await store.readThread(threadId);
		if (record && !this.owns(record)) {
			return { kind: "forbidden" };
		}
		return { kind: "allowed", record };
	}

	/** The thread's run record when the thread is the caller's, else null. */
	private async ownRecord(
		threadId: string,
		store: AgUiRunStore,
	): Promise<AgUiThreadRecord | null> {
		const access = await this.access(threadId, store);
		return access.kind === "allowed" ? access.record : null;
	}

	private owns(owner: {
		userId?: unknown;
		organizationId?: unknown;
	}): boolean {
		return (
			owner.userId === this.caller.userId &&
			owner.organizationId === this.caller.organizationId
		);
	}

	/**
	 * Start the run's workflow, or attach to the one a retry of this run id
	 * already started. Forbidden when that workflow is not this caller's run
	 * on this thread; unavailable when the input could not be parked or the
	 * workflow could not be started.
	 */
	private async startOrAttach(
		store: AgUiRunStore,
		threadId: string,
		input: RunAgentInput,
		workflowId: string,
	): Promise<WorkflowStart> {
		let inputRef: string;
		try {
			// Parked first: the activity may take it as soon as the workflow
			// runs. The request's AI token travels here, never in the
			// workflow's input or history.
			inputRef = await store.writeInput(input.runId, {
				input,
				aiToken: this.settings.aiToken,
			});
		} catch (error) {
			return { kind: "unavailable", reason: "input not stored", error };
		}
		const workflowInput: AgUiAgentRunWorkflowInput = {
			runId: input.runId,
			threadId,
			agentName: this.agentName,
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
			inputRef,
			modelHints: this.settings.modelHints,
		};
		try {
			const temporal = await getTemporalClient();
			await temporal.workflow.start(AGUI_RUN_WORKFLOW, {
				taskQueue: AGUI_RUN_TASK_QUEUE,
				workflowId,
				args: [workflowInput],
				memo: {
					userId: this.caller.userId,
					organizationId: this.caller.organizationId,
					threadId,
				},
				// An agent run is not idempotent: never re-run one, and never
				// start a second workflow under a finished run's id.
				retry: { maximumAttempts: 1 },
				workflowIdReusePolicy: "REJECT_DUPLICATE",
			});
			return { kind: "started" };
		} catch (error) {
			if (classifyTemporalClientError(error) !== "already_started") {
				return {
					kind: "unavailable",
					reason: "workflow not started",
					error,
				};
			}
		}
		const temporal = await getTemporalClient();
		const { memo } = await temporal.workflow
			.getHandle(workflowId)
			.describe();
		return memo !== undefined &&
			this.owns(memo) &&
			memo.threadId === threadId
			? { kind: "attached" }
			: { kind: "forbidden" };
	}

	/** Whether the worker wrote the run's first event within the pickup timeout. */
	private async pickedUp(
		store: AgUiRunStore,
		runId: string,
	): Promise<boolean> {
		try {
			const first = await store.readEvents(
				runId,
				STREAM_START,
				this.pickupTimeoutMs,
			);
			return first.length > 0;
		} catch (error) {
			console.warn("[Agent Runtime] Durable run pickup check failed", {
				runId,
				error: errorMessage(error),
			});
			return false;
		}
	}

	/** Best effort: end a workflow no worker picked up, so it never runs late. */
	private async abandon(workflowId: string): Promise<void> {
		try {
			const temporal = await getTemporalClient();
			await temporal.workflow
				.getHandle(workflowId)
				.terminate("Not picked up in time; the run went in-process.");
		} catch (error) {
			console.warn("[Agent Runtime] Could not terminate a durable run", {
				workflowId,
				error: errorMessage(error),
			});
		}
	}

	/**
	 * Run the request's agent in this request, on CopilotKit's runner, as
	 * `/api/copilotkit` did before durable runs.
	 */
	private async runInProcess(
		{ threadId, input, agent }: RunRequest,
		stream: RunStream,
		reason: string,
		error: unknown,
	): Promise<void> {
		console.warn(
			"[Agent Runtime] Durable run unavailable; running the agent in-process",
			{
				runId: input.runId,
				reason,
				...(error !== null && { error: errorMessage(error) }),
			},
		);
		await pipeTo(
			stream,
			this.options.inProcess.run({ threadId, agent, input }),
		);
	}

	/** Reattach as `/api/copilotkit` did before durable runs. */
	private connectInProcess(
		threadId: string,
		stream: RunStream,
	): Promise<void> {
		return pipeTo(
			stream,
			this.options.inProcess.connect({
				threadId,
				agentId: this.agentName,
			}),
		);
	}

	/** Whether the record's latest run is still producing events. */
	private async isLive(
		store: AgUiRunStore,
		record: AgUiThreadRecord,
	): Promise<boolean> {
		const last = await store.readLastEvent(record.latestRunId);
		if (last && isTerminalRunEvent(last.event)) {
			return false;
		}
		return this.isWorkflowRunning(record.workflowId);
	}

	private async isWorkflowRunning(workflowId: string): Promise<boolean> {
		const temporal = await getTemporalClient();
		try {
			const description = await temporal.workflow
				.getHandle(workflowId)
				.describe();
			return description.status.name === "RUNNING";
		} catch (error) {
			if (classifyTemporalClientError(error) === "not_found") {
				return false;
			}
			throw error;
		}
	}

	/**
	 * The thread's saved message ids, its continuations' included: after a
	 * spill at the turn cap the page saves a run's answer in the
	 * continuation, not in the conversation the thread id names.
	 */
	private persistedMessageIds(threadId: string): Promise<Set<string>> {
		return readThreadPersistedMessageIds(threadId, this.caller);
	}

	/**
	 * Emit the run's events after `fromId` until its terminal event, the
	 * client going away, or the window's end. A workflow that ended without a
	 * terminal event in the stream (a worker lost mid-run) ends the response
	 * with a `RUN_ERROR` of its own.
	 *
	 * With `holdOpening` (a run this request just started), the activity's
	 * `RUN_STARTED` is held back until the next event: when that is the
	 * activity's setup failure, neither reaches the client and the tail ends
	 * `setupFailed`, so the request can still run the turn itself.
	 */
	private async tail(
		store: AgUiRunStore,
		runId: string,
		workflowId: string,
		fromId: string,
		stream: RunStream,
		holdOpening = false,
	): Promise<TailEnd> {
		let cursor = fromId;
		let opening = holdOpening;
		let held: BaseEvent | null = null;
		const release = () => {
			if (held) {
				emitChecked(stream, held);
				held = null;
			}
		};
		const emitBatch = (batch: StoredRunEvent[]): TailEnd | null => {
			for (const { id, event } of batch) {
				cursor = id;
				if (opening) {
					if (!held && event.type === EventType.RUN_STARTED) {
						held = event;
						continue;
					}
					opening = false;
					if (isSetupFailure(event)) {
						return {
							kind: "setupFailed",
							message:
								typeof event.message === "string"
									? event.message
									: "unknown",
						};
					}
					release();
				}
				emitChecked(stream, event);
				if (isTerminalRunEvent(event)) {
					return TAIL_ENDED;
				}
			}
			return null;
		};
		while (!stream.isClosed()) {
			const remaining = stream.deadline - Date.now();
			if (remaining <= 0) {
				// The run goes on; the next mount's `connect` reattaches.
				release();
				stream.emit({
					type: EventType.CUSTOM,
					name: "fabric.reconnect",
					value: { runId },
				});
				return TAIL_ENDED;
			}
			const batch = await store.readEvents(
				runId,
				cursor,
				Math.min(remaining, TAIL_BLOCK_MS),
			);
			const end = emitBatch(batch);
			if (end) {
				return end;
			}
			if (
				batch.length === 0 &&
				!(await this.isWorkflowRunning(workflowId))
			) {
				// Events appended just before the workflow closed.
				const late = emitBatch(await store.readEvents(runId, cursor));
				if (late) {
					return late;
				}
				release();
				stream.emit({
					type: EventType.RUN_ERROR,
					message:
						"The assistant stopped before finishing its answer.",
					code: "RUN_ENDED",
				});
				return TAIL_ENDED;
			}
		}
		return TAIL_ENDED;
	}
}
