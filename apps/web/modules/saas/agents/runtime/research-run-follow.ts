import { type AGUIEvent, EventType } from "@ag-ui/client";
import type { ConversationTurn } from "@repo/database";
import {
	type DeepResearcherOutput,
	type DeepResearcherProgress,
	getTemporalClient,
	type SubAgentResult,
} from "@repo/temporal";
import {
	RESEARCH_AGENT_ID,
	RESEARCH_RUN_EVENT,
	researchTurnMessageIds,
} from "@saas/agents/lib/research-runtime-protocol";
import {
	isTerminalTurnStatus,
	isWorkflowNotFound,
	reconcileTurnWithWorkflow,
} from "@saas/agents/lib/server/conversation-turn-admission";
import { buildWorkflowErrorEvent } from "../../../../app/api/agents/fabric-ai/stream/turn-events";
import type { RunStream, RuntimeCaller } from "./engine";
import {
	currentResearchTurn,
	latestResearchTurn,
	type ResearchRunEnding,
	researchEndingOf,
	settleResearchRun,
	settleUnwatchedResearchRun,
} from "./research-run-record";
import { ResearchRunTranslator } from "./research-translator";

/** The stream route's poll interval. */
const POLL_INTERVAL_MS = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Announce a response of one research run, then tail its workflow until it
 * ends, asks its clarifying question, the stream window ends, or the client
 * goes away. The run id is the request's; the message ids derive from the
 * run's key. `answered` names interrupts this response already answered, and
 * `announce` is sent right after the run's opening events.
 */
export async function observeResearchRun(args: {
	turn: ConversationTurn;
	runId: string;
	stream: RunStream;
	answered?: ReadonlySet<string>;
	announce?: AGUIEvent[];
}): Promise<void> {
	const { turn, runId, stream } = args;
	const executionId = turn.executionId;
	const threadId = turn.conversationId;
	if (!executionId || !threadId) {
		throw new Error("An observed run has an execution and a conversation");
	}
	stream.emit({
		type: EventType.RUN_STARTED,
		threadId,
		runId,
		input: {
			threadId,
			runId,
			messages: [
				{
					id: researchTurnMessageIds(turn.clientRequestKey).user,
					role: "user",
					content: turn.questionText ?? "",
				},
			],
			tools: [],
			context: [],
		},
	});
	stream.emit({
		type: EventType.STATE_SNAPSHOT,
		snapshot: { executionId, progress: null },
	});
	stream.emit({
		type: EventType.CUSTOM,
		name: RESEARCH_RUN_EVENT.execution,
		value: { executionId, templateSlug: RESEARCH_AGENT_ID },
	});
	for (const event of args.announce ?? []) {
		stream.emit(event);
	}
	await follow({
		turn,
		executionId,
		stream,
		translator: new ResearchRunTranslator({
			threadId,
			runId,
			key: turn.clientRequestKey,
			executionId,
			emit: stream.emit,
			answered: args.answered,
		}),
		runId,
	});
}

async function follow(args: {
	turn: ConversationTurn;
	executionId: string;
	runId: string;
	stream: RunStream;
	translator: ResearchRunTranslator;
}): Promise<void> {
	const { turn, executionId, runId, stream, translator } = args;
	const temporal = await getTemporalClient();
	const handle = temporal.workflow.getHandle(executionId);
	// Sub-agents ended so far, by the progress counts: null until the first
	// poll, which sends the ones a run in progress already has.
	let endedSubAgents: number | null = null;

	while (!stream.isClosed()) {
		const description = await handle.describe().catch((error: unknown) => {
			if (isWorkflowNotFound(error)) {
				return null;
			}
			throw error;
		});
		if (!description) {
			// Not started yet (its starter is still at it), or gone: the
			// reconcile decides which.
			const settled = await reconcileTurnWithWorkflow({
				turn,
				temporalClient: temporal,
				settleCompleted: settleUnwatchedResearchRun,
			});
			if (settled === "terminalized") {
				stream.emit({
					type: EventType.RUN_ERROR,
					message: "This research did not start.",
					code: "TURN_NOT_STARTED",
				});
				return;
			}
		} else {
			const end = await workflowEnd(handle, description.status.name);
			switch (end.kind) {
				case "running": {
					const progress = await handle
						.query<DeepResearcherProgress>("progress")
						// Not registered until the workflow's first task runs.
						.catch(() => null);
					if (progress) {
						if (translator.progress(progress) === "interrupted") {
							return;
						}
						const ended =
							progress.subAgentsCompleted +
							progress.subAgentsFailed;
						if (ended !== endedSubAgents) {
							endedSubAgents = ended;
							translator.subAgents(
								(await handle
									.query<SubAgentResult[]>("subAgentResults")
									.catch(() => null)) ?? [],
							);
						}
					}
					break;
				}
				case "completed": {
					translator.subAgents(end.output.subAgentResults ?? []);
					const ending = researchEndingOf(
						end.output,
						await currentResearchTurn(turn),
					);
					await settleResearchRun(turn, ending);
					translator.finish(ending);
					return;
				}
				case "failed": {
					const event = buildWorkflowErrorEvent(end.failure);
					await settleResearchRun(turn, {
						kind: "failed",
						message: event.message,
					});
					translator.fail(event);
					return;
				}
				case "cancelled":
					await settleResearchRun(turn, { kind: "cancelled" });
					translator.finish({ kind: "cancelled" });
					return;
				default: {
					const unhandled: never = end;
					throw new Error(
						`Unhandled workflow end: ${JSON.stringify(unhandled)}`,
					);
				}
			}
		}

		if (Date.now() >= stream.deadline) {
			// The response ends inside the function's window; the run goes on.
			stream.emit({
				type: EventType.CUSTOM,
				name: RESEARCH_RUN_EVENT.reconnect,
				value: { executionId, runId },
			});
			return;
		}
		await sleep(POLL_INTERVAL_MS);
	}
}

type WorkflowHandle = ReturnType<
	Awaited<ReturnType<typeof getTemporalClient>>["workflow"]["getHandle"]
>;
type WorkflowStatusName = Awaited<
	ReturnType<WorkflowHandle["describe"]>
>["status"]["name"];

/** Where a research workflow is, read from its status (and its result once it ended). */
type WorkflowEnd =
	| { kind: "running" }
	| { kind: "completed"; output: DeepResearcherOutput }
	/** The workflow itself failed: its result is the failure. */
	| { kind: "failed"; failure: unknown }
	| { kind: "cancelled" };

async function workflowEnd(
	handle: WorkflowHandle,
	status: WorkflowStatusName,
): Promise<WorkflowEnd> {
	switch (status) {
		case "COMPLETED": {
			const output: DeepResearcherOutput = await handle.result();
			return { kind: "completed", output };
		}
		case "FAILED":
		case "TIMED_OUT":
			return {
				kind: "failed",
				failure: await handle.result().then(
					() => new Error(`Workflow ${status.toLowerCase()}`),
					(error: unknown) => error,
				),
			};
		case "CANCELLED":
		case "TERMINATED":
			return { kind: "cancelled" };
		case "RUNNING":
		case "CONTINUED_AS_NEW":
		case "PAUSED":
		case "UNKNOWN":
		case "UNSPECIFIED":
			return { kind: "running" };
		default: {
			const unhandled: never = status;
			throw new Error(`Unhandled workflow status: ${unhandled}`);
		}
	}
}

/** What an ended workflow saves. */
async function endingOf(
	end: Exclude<WorkflowEnd, { kind: "running" }>,
	turn: ConversationTurn,
): Promise<ResearchRunEnding> {
	switch (end.kind) {
		case "completed":
			return researchEndingOf(
				end.output,
				await currentResearchTurn(turn),
			);
		case "failed":
			return {
				kind: "failed",
				message: buildWorkflowErrorEvent(end.failure).message,
			};
		case "cancelled":
			return { kind: "cancelled" };
		default: {
			const unhandled: never = end;
			throw new Error(
				`Unhandled workflow end: ${JSON.stringify(unhandled)}`,
			);
		}
	}
}

/**
 * Settle a live run whose workflow already ended while nobody watched it,
 * saving it the way a watched run is saved, so a reconnect's snapshot has
 * it. A workflow Temporal does not know is left to the shared reconcile (a
 * start still under way, or an orphan).
 */
export async function settleFinishedResearchRun(
	turn: ConversationTurn,
): Promise<"running" | "terminalized" | "unavailable"> {
	const executionId = turn.executionId;
	if (!executionId) {
		return "terminalized";
	}
	const temporal = await getTemporalClient();
	const handle = temporal.workflow.getHandle(executionId);
	let status: WorkflowStatusName;
	try {
		status = (await handle.describe()).status.name;
	} catch (error) {
		if (!isWorkflowNotFound(error)) {
			return "unavailable";
		}
		return reconcileTurnWithWorkflow({
			turn,
			temporalClient: temporal,
			settleCompleted: settleUnwatchedResearchRun,
		});
	}
	const end = await workflowEnd(handle, status);
	if (end.kind === "running") {
		return "running";
	}
	await settleResearchRun(turn, await endingOf(end, turn));
	return "terminalized";
}

/**
 * Settle the thread's latest research run when its workflow ended unwatched:
 * for another engine about to admit a turn on the thread (Direct continues a
 * Research thread in the drawer and in simple mode), so the run is saved
 * with its answer rather than ended without it. "none" when the latest turn
 * is no live research run.
 */
export async function settleLatestResearchRun(
	caller: Pick<RuntimeCaller, "userId" | "organizationId">,
	threadId: string,
): Promise<"none" | "running" | "terminalized" | "unavailable"> {
	const latest = await latestResearchTurn(caller, threadId);
	if (!latest || isTerminalTurnStatus(latest.status)) {
		return "none";
	}
	return settleFinishedResearchRun(latest);
}
