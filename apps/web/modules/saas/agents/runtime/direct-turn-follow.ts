import { EventType } from "@ag-ui/client";
import type { ConversationTurn } from "@repo/database";
import {
	type ActivityHeartbeatDetails,
	type DirectChatProgressUpdate,
	type DirectChatWorkflowOutput,
	decodeHeartbeatDetails,
	getTemporalClient,
} from "@repo/temporal";
import {
	isWorkflowNotFound,
	reconcileTurnWithWorkflow,
} from "@saas/agents/lib/server/conversation-turn-admission";
import { buildWorkflowErrorEvent } from "../../../../app/api/agents/fabric-ai/stream/turn-events";
import { unansweredApproval } from "./direct-approval";
import {
	type ApiBillingNotice,
	type DirectTurnEnding,
	directTurnMessageIds,
	settleDirectTurn,
	settleUnwatchedDirectTurn,
} from "./direct-turn-record";
import type { RunStream, RuntimeCaller } from "./engine";
import { type TurnPartial, TurnTranslator } from "./turn-translator";

/** The `CUSTOM` event names a run's response carries around the turn itself. */
const DIRECT_RUN_EVENT = {
	/** The turn's workflow id, as the stream route's `started` event. */
	execution: "fabric.execution",
	/** The stream route's API-billing header. */
	billing: "fabric.billing",
	/** The response's window ended; the turn did not. Reconnect with `connect`. */
	reconnect: "fabric.reconnect",
} as const;

const POLL_INTERVAL_MS = 150;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Announce a run of one turn, then tail its workflow until it settles, the
 * stream window ends, or the client goes away. The run id is the client's
 * (a retried run keeps its own); the message ids derive from the turn.
 */
export async function observeDirectTurn(args: {
	caller: Pick<RuntimeCaller, "userId" | "organizationId">;
	turn: ConversationTurn;
	runId: string;
	stream: RunStream;
	billing: ApiBillingNotice | null;
}): Promise<void> {
	const { turn, runId, stream, billing } = args;
	const executionId = turn.executionId;
	const threadId = turn.conversationId;
	if (!executionId || !threadId) {
		throw new Error("An observed turn has an execution and a conversation");
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
					id: directTurnMessageIds(turn.clientRequestKey).user,
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
		snapshot: TurnTranslator.initialState(executionId),
	});
	stream.emit({
		type: EventType.CUSTOM,
		name: DIRECT_RUN_EVENT.execution,
		value: { executionId },
	});
	if (billing) {
		stream.emit({
			type: EventType.CUSTOM,
			name: DIRECT_RUN_EVENT.billing,
			value: billing,
		});
	}
	await follow({ ...args, threadId, executionId });
}

/**
 * The workflow reports cumulative state, so the first poll of a turn
 * already in progress replays it so far and later polls send what is new.
 */
async function follow(args: {
	caller: Pick<RuntimeCaller, "userId" | "organizationId">;
	turn: ConversationTurn;
	threadId: string;
	executionId: string;
	runId: string;
	stream: RunStream;
	billing: ApiBillingNotice | null;
}): Promise<void> {
	const { caller, turn, threadId, executionId, runId, stream } = args;
	const translator = new TurnTranslator(turn.clientRequestKey, stream.emit);
	const temporal = await getTemporalClient();
	const handle = temporal.workflow.getHandle(executionId);

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
				settleCompleted: settleUnwatchedDirectTurn,
			});
			if (settled === "terminalized") {
				translator.close();
				stream.emit({
					type: EventType.RUN_ERROR,
					message: "This turn did not start.",
					code: "TURN_NOT_STARTED",
				});
				return;
			}
		} else {
			const end = await workflowEnd(handle, description.status.name);
			switch (end.kind) {
				case "running":
					await applyProgress(description.raw, handle, translator);
					break;
				case "completed":
					await settleDirectTurn(turn, endingOf(end), args.billing);
					translator.finish({
						threadId,
						runId,
						result: end.result,
						approval: await unansweredApproval(
							caller,
							turn,
							end.result,
						),
					});
					return;
				case "failed":
					await settleDirectTurn(
						turn,
						endingOf(end, translator.partial()),
					);
					translator.fail(end.failure);
					return;
				case "cancelled":
					await settleDirectTurn(
						turn,
						endingOf(end, translator.partial()),
					);
					translator.cancel(threadId, runId);
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
			// The response ends inside the function's window; the turn goes on.
			stream.emit({
				type: EventType.CUSTOM,
				name: DIRECT_RUN_EVENT.reconnect,
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

/** Where a Direct workflow is, read from its status (and its result once it ended). */
type WorkflowEnd =
	| { kind: "running" }
	| { kind: "completed"; result: DirectChatWorkflowOutput }
	/** The workflow itself failed: its result is the failure. */
	| { kind: "failed"; failure: unknown }
	| { kind: "cancelled" };

async function workflowEnd(
	handle: WorkflowHandle,
	status: WorkflowStatusName,
): Promise<WorkflowEnd> {
	switch (status) {
		case "COMPLETED": {
			const result: DirectChatWorkflowOutput = await handle.result();
			return { kind: "completed", result };
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

/**
 * What an ended workflow saves: `partial` is the turn as far as it streamed
 * to whoever watched it (absent when nobody did).
 */
function endingOf(
	end: Exclude<WorkflowEnd, { kind: "running" }>,
	partial?: TurnPartial,
): DirectTurnEnding {
	switch (end.kind) {
		case "completed":
			return { kind: "completed", result: end.result };
		case "failed":
			return {
				kind: "failed",
				message: buildWorkflowErrorEvent(end.failure).message,
				partial,
			};
		case "cancelled":
			return { kind: "cancelled", partial };
		default: {
			const unhandled: never = end;
			throw new Error(
				`Unhandled workflow end: ${JSON.stringify(unhandled)}`,
			);
		}
	}
}

/**
 * Settle a live turn whose workflow already ended while nobody watched it,
 * saving it the way a watched turn is saved (a cancelled or failed one
 * included), so a reconnect's snapshot has it. A workflow Temporal does not
 * know is left to the shared reconcile (a start still under way, or an
 * orphan).
 */
export async function settleFinishedDirectTurn(
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
			settleCompleted: settleUnwatchedDirectTurn,
		});
	}
	const end = await workflowEnd(handle, status);
	if (end.kind === "running") {
		return "running";
	}
	await settleDirectTurn(turn, endingOf(end));
	return "terminalized";
}

/** One poll of a running turn: activity heartbeats, then the progress query. */
async function applyProgress(
	raw: {
		pendingActivities?: Array<{ heartbeatDetails?: unknown }> | null;
	},
	handle: { query: <T>(name: string) => Promise<T> },
	translator: TurnTranslator,
): Promise<void> {
	for (const activity of raw.pendingActivities ?? []) {
		const details = decodeHeartbeatDetails<ActivityHeartbeatDetails>(
			activity.heartbeatDetails,
		);
		if (details) {
			translator.apply(details);
		}
	}
	const progress = await handle
		.query<DirectChatProgressUpdate>("directChatProgress")
		// The query handler is not registered until the workflow's first task runs.
		.catch(() => null);
	if (progress) {
		translator.apply(progress);
	}
}
