/**
 * One durable AG-UI agent run (`agUiAgentRunWorkflow`): runs a LangGraph
 * agent over AG-UI exactly as `/api/copilotkit` does in the request, and
 * appends every event it emits to the run's Redis stream for the web runtime
 * to replay and tail (`lib/agui-run-stream.ts`).
 *
 * The request the agent sees is the route's own: the run's `RunAgentInput`
 * and the AI token the route minted for the request (both taken by reference
 * from the run's input record, which is deleted as it is read), and the
 * headers the route builds — service auth from this worker's `AGENT_API_KEY`,
 * the caller's tenant ids, that token, and the model hints the route
 * resolved. No secret crosses the workflow boundary, and the worker mints no
 * token.
 *
 * The stream always ends with exactly one terminal event: the agent's own
 * `RUN_FINISHED` / `RUN_ERROR`, or one synthesized here when the agent's
 * stream ends without one, fails, or the run is cancelled — after closing any
 * message or tool call the agent left open, as CopilotKit's runner does. A run
 * that fails before the agent's first event (no input record, no agent
 * credentials or address, an agent request that never answered) ends with
 * `AGUI_RUN_SETUP_FAILED_CODE`, which tells the web runtime nothing ran and
 * the turn can still be run in the request.
 */

import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { LangGraphHttpAgent } from "@ag-ui/langgraph";
import { AI_TOKEN_HEADER } from "@repo/ai-token";
import { logger } from "@repo/logs";
import { Context } from "@temporalio/activity";
import { resolveAgentUrl } from "../lib/agent-url-resolver";
import {
	AGUI_RUN_SETUP_FAILED_CODE,
	type AgUiAgentRunResult,
	type AgUiAgentRunWorkflowInput,
	type AgUiModelHints,
	type AgUiRunInputRecord,
	type AgUiRunOutcome,
	type AgUiRunStore,
	openAgUiRunStore,
} from "../lib/agui-run-stream";

/**
 * Where an agent listens when no `*_URL` override names it: the same local
 * defaults `/api/copilotkit` falls back to.
 */
const LOCAL_AGENT_URLS: Readonly<Record<string, string>> = {
	project_document_generator: "http://localhost:8125",
};

/** A heartbeat at least this often while the agent is quiet (thinking, tools). */
const QUIET_HEARTBEAT_MS = 10_000;

/**
 * The headers `/api/copilotkit` sends its agents, in the same shape: service
 * auth, tenant, AI token, then the model hints.
 */
export function buildAgUiAgentHeaders(params: {
	userId: string;
	organizationId: string;
	aiToken: string;
	agentApiKey: string | undefined;
	modelHints: AgUiModelHints;
}): Record<string, string> {
	const { modelHints } = params;
	return {
		...(modelHints.isReasoning !== undefined && {
			"X-AI-Is-Reasoning": String(modelHints.isReasoning),
		}),
		...(params.agentApiKey && {
			Authorization: `Bearer ${params.agentApiKey}`,
		}),
		"X-Tenant-User-ID": params.userId,
		"X-Tenant-Organization-ID": params.organizationId,
		[AI_TOKEN_HEADER]: params.aiToken,
		...(modelHints.model && { "X-AI-Model": modelHints.model }),
		...(modelHints.baseUrl && { "X-AI-Base-URL": modelHints.baseUrl }),
		...(modelHints.provider && { "X-AI-Provider": modelHints.provider }),
		...(modelHints.deploymentName && {
			"X-AI-Deployment-Name": modelHints.deploymentName,
		}),
	};
}

function stringField(event: BaseEvent, field: string): string | undefined {
	const value = event[field];
	return typeof value === "string" ? value : undefined;
}

/**
 * Appends a run's events in order, and ends the stream with exactly one
 * terminal event. Tracks what the agent opened so a synthesized end closes
 * it first.
 */
export class RunEventWriter {
	private appended = 0;
	private agentEvents = 0;
	private started = false;
	private terminal: BaseEvent | null = null;
	private readonly openMessages = new Set<string>();
	private readonly openToolCalls = new Set<string>();
	private pending: Promise<void> = Promise.resolve();

	constructor(
		private readonly store: AgUiRunStore,
		private readonly runId: string,
		private readonly input: RunAgentInput | null,
	) {}

	/**
	 * Open the run with its `RUN_STARTED` before the agent is set up. The
	 * web runtime reads the first event as the worker's pickup: a run with
	 * none within its pickup timeout is taken back and run in the request.
	 * The agent's own `RUN_STARTED` is then dropped as a duplicate.
	 */
	async start(run: { threadId: string; runId: string }): Promise<void> {
		await this.flush();
		await this.write({
			type: EventType.RUN_STARTED,
			threadId: run.threadId,
			runId: run.runId,
		});
	}

	/** Queue an agent event; events after the terminal one are dropped. */
	push(event: BaseEvent): void {
		this.agentEvents += 1;
		this.pending = this.pending.then(() => this.write(event));
	}

	/**
	 * Whether the agent has sent anything yet (its own `RUN_STARTED`
	 * included): until then, a failure is a setup failure.
	 */
	get agentResponded(): boolean {
		return this.agentEvents > 0;
	}

	/** Wait for every queued event to be stored. */
	async flush(): Promise<void> {
		await this.pending;
	}

	get ended(): boolean {
		return this.terminal !== null;
	}

	/**
	 * End a run the agent did not end: close what it left open, then the
	 * terminal event. A no-op once the stream has its terminal event.
	 */
	async end(terminal: BaseEvent): Promise<void> {
		await this.flush();
		if (this.terminal) {
			return;
		}
		for (const toolCallId of this.openToolCalls) {
			await this.write({ type: EventType.TOOL_CALL_END, toolCallId });
		}
		for (const messageId of this.openMessages) {
			await this.write({ type: EventType.TEXT_MESSAGE_END, messageId });
		}
		await this.write(terminal);
	}

	result(): AgUiAgentRunResult {
		return { outcome: outcomeOf(this.terminal), events: this.appended };
	}

	private async write(event: BaseEvent): Promise<void> {
		if (this.terminal) {
			return;
		}
		if (event.type === EventType.RUN_STARTED) {
			if (this.started) {
				return;
			}
			this.started = true;
		}
		this.observe(event);
		await this.store.appendEvent(this.runId, this.withRunInput(event));
		this.appended += 1;
	}

	private observe(event: BaseEvent): void {
		const messageId = stringField(event, "messageId");
		const toolCallId = stringField(event, "toolCallId");
		switch (event.type) {
			case EventType.TEXT_MESSAGE_START:
				if (messageId) {
					this.openMessages.add(messageId);
				}
				break;
			case EventType.TEXT_MESSAGE_END:
				if (messageId) {
					this.openMessages.delete(messageId);
				}
				break;
			case EventType.TOOL_CALL_START:
				if (toolCallId) {
					this.openToolCalls.add(toolCallId);
				}
				break;
			case EventType.TOOL_CALL_END:
				if (toolCallId) {
					this.openToolCalls.delete(toolCallId);
				}
				break;
			case EventType.RUN_FINISHED:
			case EventType.RUN_ERROR:
				this.terminal = event;
				break;
			default:
				break;
		}
	}

	/**
	 * `RUN_STARTED` with the run's messages, as CopilotKit's in-memory runner
	 * sends it: a client reattaching to the run learns the question from it.
	 * Only the messages — the state carries the whole document and nothing
	 * reads it from here.
	 */
	private withRunInput(event: BaseEvent): BaseEvent {
		if (
			event.type !== EventType.RUN_STARTED ||
			event.input !== undefined ||
			!this.input
		) {
			return event;
		}
		return {
			...event,
			input: {
				threadId: this.input.threadId,
				runId: this.input.runId,
				state: {},
				messages: this.input.messages,
				tools: [],
				context: [],
				forwardedProps: {},
			},
		};
	}
}

function outcomeOf(terminal: BaseEvent | null): AgUiRunOutcome {
	if (!terminal || terminal.type === EventType.RUN_ERROR) {
		return "error";
	}
	const outcome = terminal.outcome;
	return typeof outcome === "object" &&
		outcome !== null &&
		"type" in outcome &&
		outcome.type === "cancelled"
		? "cancelled"
		: "finished";
}

function runError(message: string, code: string): BaseEvent {
	return { type: EventType.RUN_ERROR, message, code };
}

/** The run stopped: CopilotKit's own stop terminal (`finalizeRunEvents`). */
function runCancelled(
	input: Pick<RunAgentInput, "threadId" | "runId"> &
		Partial<Pick<RunAgentInput, "protocolVersion">>,
): BaseEvent {
	return {
		type: EventType.RUN_FINISHED,
		threadId: input.threadId,
		runId: input.runId,
		...(input.protocolVersion !== undefined && {
			outcome: { type: "cancelled" },
		}),
	};
}

class RunCancelledError extends Error {}

/**
 * Stream the agent's run into the writer until it completes, fails, or the
 * activity is cancelled (which aborts the agent's HTTP call).
 */
function streamAgentRun(
	agent: LangGraphHttpAgent,
	input: RunAgentInput,
	writer: RunEventWriter,
	signal: AbortSignal,
	beat: () => void,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const quiet = setInterval(beat, QUIET_HEARTBEAT_MS);
		const settle = (done: () => void) => {
			clearInterval(quiet);
			signal.removeEventListener("abort", onAbort);
			done();
		};
		const subscription = agent.run(input).subscribe({
			next: (event) => {
				writer.push(event);
				beat();
			},
			error: (error: unknown) => settle(() => reject(error)),
			complete: () => settle(resolve),
		});
		function onAbort() {
			subscription.unsubscribe();
			agent.abortRun();
			settle(() => reject(new RunCancelledError()));
		}
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A failure before the agent was called: nothing ran. */
class RunSetupError extends Error {}

/**
 * The agent client the route would build, with the route's token. Throws a
 * `RunSetupError` when this worker cannot reach the agent: without
 * `AGENT_API_KEY` a self-hosted agent rejects the run, and without a URL
 * there is nothing to call.
 */
function createAgent(
	input: AgUiAgentRunWorkflowInput,
	aiToken: string,
): LangGraphHttpAgent {
	const agentApiKey = process.env.AGENT_API_KEY?.trim();
	if (!agentApiKey) {
		throw new RunSetupError("AGENT_API_KEY is not set on the worker");
	}
	const url = resolveAgentUrl(
		input.agentName,
		LOCAL_AGENT_URLS[input.agentName] ?? "",
	);
	if (!URL.canParse(url)) {
		throw new RunSetupError(
			`No agent URL is configured for "${input.agentName}"`,
		);
	}
	return new LangGraphHttpAgent({
		url,
		headers: buildAgUiAgentHeaders({
			userId: input.userId,
			organizationId: input.organizationId,
			aiToken,
			agentApiKey,
			modelHints: input.modelHints,
		}),
	});
}

/** The run's input record, when it is there and is this run's. */
async function takeRunInput(
	store: AgUiRunStore,
	input: AgUiAgentRunWorkflowInput,
): Promise<AgUiRunInputRecord | null> {
	const record = await store.takeInput(input.inputRef);
	return record &&
		record.input.runId === input.runId &&
		record.input.threadId === input.threadId
		? record
		: null;
}

export async function runAgUiAgentActivity(
	input: AgUiAgentRunWorkflowInput,
): Promise<AgUiAgentRunResult> {
	const context = Context.current();
	const store = await openAgUiRunStore();
	try {
		const record = await takeRunInput(store, input);
		const writer = new RunEventWriter(
			store,
			input.runId,
			record?.input ?? null,
		);
		await writer.start(input);
		try {
			if (!record) {
				throw new RunSetupError(
					"The run's input expired or was already taken before the run could start",
				);
			}
			await streamAgentRun(
				createAgent(input, record.aiToken),
				record.input,
				writer,
				context.cancellationSignal,
				() => context.heartbeat(),
			);
			if (!writer.agentResponded) {
				throw new RunSetupError(
					"The agent ended the run without a response",
				);
			}
			await writer.end(
				runError(
					"Run ended without emitting a terminal event",
					"INCOMPLETE_STREAM",
				),
			);
		} catch (error) {
			if (error instanceof RunCancelledError) {
				await writer.end(runCancelled(record?.input ?? input));
				// Report the cancellation to the workflow as Temporal's own
				// (`cancelled` rejects with the activity's CancelledFailure).
				return await context.cancelled;
			}
			const setupFailed =
				error instanceof RunSetupError || !writer.agentResponded;
			logger.warn(
				setupFailed
					? "[AgUiAgentRun] Run setup failed"
					: "[AgUiAgentRun] Agent run failed",
				{
					runId: input.runId,
					agentName: input.agentName,
					error: errorMessage(error),
				},
			);
			await writer.end(
				runError(
					errorMessage(error),
					setupFailed
						? AGUI_RUN_SETUP_FAILED_CODE
						: "AGENT_RUN_FAILED",
				),
			);
		}
		return writer.result();
	} finally {
		await store.close();
	}
}
