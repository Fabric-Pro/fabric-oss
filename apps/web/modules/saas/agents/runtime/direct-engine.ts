/**
 * The Direct engine behind the agent runtime: one AG-UI run is one Direct
 * turn (`directChatWorkflow`), admitted, billed and started exactly as the
 * Direct stream route does it (`app/api/agents/fabric-ai/stream/direct-turn.ts`)
 * and observed from Temporal, so a closed response never ends the turn.
 *
 * Thread = conversation. The thread id is the `AgentConversation` id (created
 * for the caller on the first run), and it is the turn's `conversationId`: the
 * workflow keys the model's prompt-cache session on it, so every turn of a
 * thread reuses one provider cache key.
 *
 * Run = turn. Each run is admitted as a `ConversationTurn` keyed by the AG-UI
 * `runId`: a retried run attaches to its turn and never starts a second
 * workflow, a conversation has at most one live turn (another run is refused
 * with `TURN_IN_PROGRESS`), and a turn nobody watched to its end is settled
 * from Temporal on the next run or connect. A finished turn is saved into the
 * conversation server-side, under ids derived from its key.
 *
 * Event mapping (Direct stream event or workflow field → AG-UI):
 *
 * | Direct source                       | AG-UI                                                          |
 * |-------------------------------------|----------------------------------------------------------------|
 * | run start (`started`)               | RUN_STARTED (input.messages = the turn's question), STATE_SNAPSHOT `{executionId, progress: null}`, CUSTOM `fabric.execution` `{executionId}` |
 * | billing header                      | CUSTOM `fabric.billing` `{resetAt, personalKeyProvider?}` on the run that admitted the turn; saved as the answer's `metadata.apiBilling` |
 * | `progress` (phase change)           | STATE_DELTA `add /progress {phase, message, progress, currentActivity?}` |
 * | `reasoning`                         | REASONING_START, REASONING_MESSAGE_START / CONTENT… / END, REASONING_END (id `<key>:reasoning`) |
 * | `reasoningDuration`                 | CUSTOM `fabric.reasoning-duration` `{messageId, durationMs}`     |
 * | `text`                              | TEXT_MESSAGE_START / CONTENT… / END (id `<key>:assistant`)       |
 * | `tool_start` / `tool_input`         | TOOL_CALL_START (metadata.fabric: serverName, MCP app), TOOL_CALL_ARGS (the whole JSON once the call runs), TOOL_CALL_END |
 * | `tool_result`                       | TOOL_CALL_RESULT (metadata.fabric: status, error)                |
 * | `sources`                           | CUSTOM `fabric.sources` `{messageId, sources}`                   |
 * | `error` with `partial`              | CUSTOM `fabric.partial-error` `{messageId, message, code?, limit?, data?}` |
 * | `confirmation_required`             | RUN_FINISHED outcome `interrupt` `{id: <key>:approval, reason: tool_approval, message, toolCallId, metadata: {toolName, args, draft}}` |
 * | `done`                              | RUN_FINISHED outcome `success`, `result` `{durationMs, usage, model, toolsFailed?, truncated?, apiBilling?}`, `usage` `[{provider, model, …tokens}]` |
 * | `error` (failed turn or workflow)   | RUN_ERROR `{message, code?, metadata.fabric: {limit?, data?}}`   |
 * | workflow cancelled / terminated     | RUN_FINISHED outcome `cancelled`                                |
 * | admission refusal (4xx/5xx body)    | RUN_ERROR `{message, code}` (`HTTP_<status>` when the body names none), metadata.fabric = the body |
 * | stream window reached               | CUSTOM `fabric.reconnect` `{executionId, runId}`; the response ends, the turn does not |
 *
 * Approval (see `direct-approval.ts`): resuming an interrupt approved starts
 * a new turn keyed `<interruptId>:resume` that runs the call the interrupted
 * turn's workflow recorded, never arguments the client sends; declining
 * starts nothing; a replayed or stale answer is `APPROVAL_NOT_PENDING`.
 */
import {
	contentToText,
	EventType,
	type Message,
	type ResumeEntry,
	type RunAgentInput,
} from "@ag-ui/client";
import {
	abandonConversationTurnStart,
	type ConversationTurn,
	requestConversationTurnCancel,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { FABRIC_AGENT_ID } from "@repo/utils/page-limits";
import {
	approvalMessage,
	readConfirmationRequest,
} from "@saas/agents/lib/chat-confirmation";
import { mergeDirectConversationMetadata } from "@saas/agents/lib/direct-chat-tools";
import {
	ChatRunAccessError,
	getAuthorizedChatRun,
	recordChatRunControlAudit,
} from "@saas/agents/lib/server/chat-run-control";
import {
	admitTurn,
	isTerminalTurnStatus,
	isWorkflowNotFound,
	startAdmittedTurn,
	type TurnAdmissionRefusal,
	TurnStartAmbiguousError,
	TurnStoppedBeforeStartError,
} from "@saas/agents/lib/server/conversation-turn-admission";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import {
	admitDirectChatTurn,
	buildDirectChatWorkflowInput,
	startDirectChatWorkflow,
} from "../../../../app/api/agents/fabric-ai/stream/direct-turn";
import { buildWorkflowErrorEvent } from "../../../../app/api/agents/fabric-ai/stream/turn-events";
import {
	directTurnByKey,
	latestDirectTurn,
	pendingApprovalFor,
	RESUME_SUFFIX,
	raiseUnansweredApproval,
} from "./direct-approval";
import {
	observeDirectTurn,
	settleFinishedDirectTurn,
} from "./direct-turn-follow";
import {
	apiBillingNotice,
	DIRECT_EXECUTION_MODE,
	recordDirectQuestion,
	settleDirectTurn,
	settleUnwatchedDirectTurn,
} from "./direct-turn-record";
import type { RunStream, RuntimeCaller, RuntimeEngine } from "./engine";
import { refuse, refuseWithResponse } from "./run-errors";
import {
	ensureThread,
	readThreadAccess,
	readThreadMessages,
	threadSnapshotMessages,
	threadTitle,
} from "./thread";

/** The runtime agent id the Direct engine serves. */
export const DIRECT_AGENT_ID = "fabric-direct";

/** The AG-UI run id is the turn's client key: the chat routes' key format. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** An approval answer: `{ approved: true }`; anything else declines. */
const approvalAnswerSchema = z.object({ approved: z.literal(true) });

/** A turn this engine is about to admit. */
interface TurnRequest {
	threadId: string;
	/** The AG-UI run id of the request (the client's). */
	runId: string;
	/** The turn's client key: the run id, or `<interruptId>:resume`. */
	turnKey: string;
	question: string;
	history: Array<{ role: "user" | "assistant"; content: string }>;
	forwardedProps: unknown;
	approvedToolCall?: { toolName: string; args: Record<string, unknown> };
	/** For an approval: the key having a turn means it was already answered. */
	existingMeansAnswered: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Prior user and assistant text: the transcript the Direct route takes as `history`. */
function historyOf(messages: Message[]): TurnRequest["history"] {
	return messages.flatMap((message) => {
		if (message.role !== "user" && message.role !== "assistant") {
			return [];
		}
		const content = contentToText(message.content);
		return content ? [{ role: message.role, content }] : [];
	});
}

const refuseForbidden = (stream: RunStream) =>
	refuse(stream, "FORBIDDEN", "This thread is not accessible.");

const refuseNotPending = (stream: RunStream) =>
	refuse(
		stream,
		"APPROVAL_NOT_PENDING",
		"This approval is no longer pending.",
	);

const refuseStateUnavailable = (stream: RunStream) =>
	refuse(
		stream,
		"TURN_STATE_UNAVAILABLE",
		"Could not confirm the thread's running turn. Please retry.",
	);

/** The run's answer to an admission refusal. */
function refuseAdmission(
	stream: RunStream,
	refusal: TurnAdmissionRefusal,
): void {
	switch (refusal.reason) {
		case "conversation_forbidden":
			refuseForbidden(stream);
			return;
		case "key_reused":
			refuse(
				stream,
				"RUN_ID_REUSED",
				"This run id already belongs to another thread.",
			);
			return;
		case "state_unavailable":
			refuseStateUnavailable(stream);
			return;
		case "in_progress":
			refuse(
				stream,
				"TURN_IN_PROGRESS",
				"A turn is already running in this thread.",
			);
			return;
		default: {
			const unhandled: never = refusal;
			throw new Error(`Unhandled refusal: ${JSON.stringify(unhandled)}`);
		}
	}
}

/** The Direct engine for one caller (see the file header). */
export class DirectEngine implements RuntimeEngine {
	constructor(private readonly caller: RuntimeCaller) {}

	async run(
		{ threadId, input }: { threadId: string; input: RunAgentInput },
		stream: RunStream,
	): Promise<void> {
		if (!RUN_ID_PATTERN.test(input.runId)) {
			refuse(
				stream,
				"INVALID_RUN_ID",
				"runId must be 8-128 letters, digits, '-' or '_'",
			);
			return;
		}
		const answer = input.resume?.[0];
		if (answer) {
			await this.resume(threadId, input, answer, stream);
			return;
		}
		const last = input.messages.at(-1);
		const question =
			last?.role === "user" ? contentToText(last.content).trim() : "";
		if (!question) {
			refuse(stream, "NO_MESSAGE", "A run needs a new user message.");
			return;
		}
		const writable = await ensureThread(threadId, this.caller, {
			agentId: FABRIC_AGENT_ID,
			title: threadTitle(question),
			metadata: mergeDirectConversationMetadata({}),
		});
		if (!writable) {
			refuseForbidden(stream);
			return;
		}
		await this.startTurn(
			{
				threadId,
				runId: input.runId,
				turnKey: input.runId,
				question,
				history: historyOf(input.messages.slice(0, -1)),
				forwardedProps: input.forwardedProps,
				existingMeansAnswered: false,
			},
			stream,
		);
	}

	/**
	 * The thread so far as one MESSAGES_SNAPSHOT, then the live turn's tail
	 * when one runs. Finished turns arrive only in the snapshot, never as
	 * replayed deltas: AG-UI content appends, so a replay duplicates.
	 */
	async connect(threadId: string, stream: RunStream): Promise<void> {
		const access = await readThreadAccess(threadId, this.caller);
		if (access.kind === "forbidden") {
			refuseForbidden(stream);
			return;
		}
		if (access.kind === "absent") {
			return;
		}
		let latest = await latestDirectTurn(this.caller, threadId);
		if (latest && !isTerminalTurnStatus(latest.status)) {
			const settled = await settleFinishedDirectTurn(latest);
			if (settled === "unavailable") {
				refuseStateUnavailable(stream);
				return;
			}
			if (settled === "terminalized") {
				latest = await latestDirectTurn(this.caller, threadId);
			}
		}
		const saved = (await readThreadMessages(threadId, this.caller)) ?? [];
		stream.emit({
			type: EventType.MESSAGES_SNAPSHOT,
			messages: threadSnapshotMessages(saved),
		});
		if (!latest) {
			return;
		}
		if (!isTerminalTurnStatus(latest.status)) {
			await observeDirectTurn({
				caller: this.caller,
				turn: latest,
				runId: latest.clientRequestKey,
				stream,
				billing: null,
			});
			return;
		}
		await raiseUnansweredApproval(
			this.caller,
			latest,
			saved.at(-1),
			stream,
		);
	}

	async isRunning(threadId: string): Promise<boolean> {
		if ((await readThreadAccess(threadId, this.caller)).kind !== "owned") {
			return false;
		}
		const latest = await latestDirectTurn(this.caller, threadId);
		if (!latest || isTerminalTurnStatus(latest.status)) {
			return false;
		}
		return (await settleFinishedDirectTurn(latest)) !== "terminalized";
	}

	/**
	 * Stop the thread's live Direct turn with the cancel route's checks: the
	 * run is authorized for the caller and organization, the cancel is
	 * recorded on the turn before Temporal is asked, and the cancel route's
	 * audit row is written.
	 */
	async stop(threadId: string, runId?: string): Promise<boolean> {
		if ((await readThreadAccess(threadId, this.caller)).kind !== "owned") {
			return false;
		}
		const turn = await this.turnForStop(threadId, runId);
		const executionId = turn?.executionId;
		if (!turn || !executionId || isTerminalTurnStatus(turn.status)) {
			return false;
		}
		let run: Awaited<ReturnType<typeof getAuthorizedChatRun>>;
		try {
			run = await getAuthorizedChatRun({
				executionId,
				userId: this.caller.userId,
				engine: "direct",
				action: "cancel",
				expectedOrganizationId: this.caller.organizationId,
			});
		} catch (error) {
			if (error instanceof ChatRunAccessError) {
				return false;
			}
			if (!isWorkflowNotFound(error)) {
				throw error;
			}
			// Not started yet: the cancel recorded on the caller's own turn
			// stops its starter before it starts anything.
			const recorded = await requestConversationTurnCancel({
				userId: this.caller.userId,
				organizationId: this.caller.organizationId,
				source: "USER_STOP",
				executionId,
			});
			return recorded.outcome === "recorded";
		}
		await requestConversationTurnCancel({
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
			source: "USER_STOP",
			executionId,
		});
		if (run.description.status.name !== "RUNNING") {
			return false;
		}
		await run.handle.cancel();
		recordChatRunControlAudit(this.caller.audit, {
			action: "cancel",
			organizationId: run.organizationId,
			executionId,
			runId: run.description.runId,
		});
		return true;
	}

	/**
	 * The turn a stop names. CopilotKit scopes a stop to the run id it
	 * POSTed, but a resumed approval runs under its own key, so a run id no
	 * turn has still names the thread's live resumed turn.
	 */
	private async turnForStop(
		threadId: string,
		runId: string | undefined,
	): Promise<ConversationTurn | null> {
		if (runId) {
			const byKey = await directTurnByKey(this.caller, threadId, runId);
			if (byKey) {
				return byKey;
			}
		}
		const latest = await latestDirectTurn(this.caller, threadId);
		return latest &&
			(!runId || latest.clientRequestKey.endsWith(RESUME_SUFFIX))
			? latest
			: null;
	}

	/**
	 * Answer a pending interrupt. Approved, the call the interrupted turn's
	 * workflow recorded runs as a new turn; declined or cancelled, nothing
	 * runs and a tombstone on the answer's key refuses any later answer.
	 */
	private async resume(
		threadId: string,
		input: RunAgentInput,
		answer: ResumeEntry,
		stream: RunStream,
	): Promise<void> {
		if ((await readThreadAccess(threadId, this.caller)).kind !== "owned") {
			refuseForbidden(stream);
			return;
		}
		const approval = await pendingApprovalFor(
			this.caller,
			threadId,
			answer.interruptId,
		);
		if (!approval) {
			refuseNotPending(stream);
			return;
		}
		const resumeKey = `${answer.interruptId}${RESUME_SUFFIX}`;
		const approved =
			answer.status === "resolved" &&
			approvalAnswerSchema.safeParse(answer.payload).success;
		if (!approved) {
			const declined = await requestConversationTurnCancel({
				userId: this.caller.userId,
				organizationId: this.caller.organizationId,
				source: "USER_STOP",
				clientRequestKey: resumeKey,
				conversationId: threadId,
			});
			if (declined.outcome !== "tombstoned") {
				refuseNotPending(stream);
				return;
			}
			stream.emit({
				type: EventType.RUN_STARTED,
				threadId,
				runId: input.runId,
			});
			stream.emit({
				type: EventType.RUN_FINISHED,
				threadId,
				runId: input.runId,
				outcome: { type: "success" },
			});
			return;
		}

		const request = readConfirmationRequest({
			requiresConfirmation: true,
			toolName: approval.toolName,
			args: approval.args,
			draft: approval.draft,
			message: approval.message,
		});
		await this.startTurn(
			{
				threadId,
				runId: input.runId,
				turnKey: resumeKey,
				question: request
					? approvalMessage(request)
					: `Approved: ${approval.toolName}.`,
				history: historyOf(input.messages),
				forwardedProps: input.forwardedProps,
				approvedToolCall: {
					toolName: approval.toolName,
					args: approval.args,
				},
				existingMeansAnswered: true,
			},
			stream,
		);
	}

	/**
	 * Admit, bill and start one turn, then tail it. A retried run (its key
	 * already has a turn) attaches to that turn and starts nothing.
	 */
	private async startTurn(
		request: TurnRequest,
		stream: RunStream,
	): Promise<void> {
		// A live turn whose workflow ended while nobody watched it is saved
		// first, so admission's reconcile never ends a cancelled or failed
		// turn without its messages.
		const latest = await latestDirectTurn(this.caller, request.threadId);
		if (
			latest &&
			latest.clientRequestKey !== request.turnKey &&
			!isTerminalTurnStatus(latest.status) &&
			(await settleFinishedDirectTurn(latest)) === "unavailable"
		) {
			refuseStateUnavailable(stream);
			return;
		}
		const temporal = await getTemporalClient();
		const admission = await admitTurn({
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
			conversationId: request.threadId,
			clientRequestKey: request.turnKey,
			newExecutionId: () => `direct-chat-${uuidv4()}`,
			executionMode: DIRECT_EXECUTION_MODE,
			question: request.question,
			temporalClient: temporal,
			settleCompleted: settleUnwatchedDirectTurn,
		});
		switch (admission.kind) {
			case "refused":
				refuseAdmission(stream, admission.refusal);
				return;
			case "existing":
				if (request.existingMeansAnswered) {
					refuseNotPending(stream);
					return;
				}
				if (!admission.turn.executionId) {
					refuse(
						stream,
						"TURN_CANCELLED",
						"This message was stopped before it started.",
					);
					return;
				}
				await observeDirectTurn({
					caller: this.caller,
					turn: admission.turn,
					runId: request.runId,
					stream,
					billing: null,
				});
				return;
			case "created":
				break;
			default: {
				const unhandled: never = admission;
				throw new Error(
					`Unhandled admission: ${JSON.stringify(unhandled)}`,
				);
			}
		}

		const turn = admission.turn;
		const executionId = turn.executionId;
		const startToken = turn.startToken;
		if (!executionId || !startToken) {
			throw new Error(
				"A created turn carries its execution and start token",
			);
		}
		const admitted = await admitDirectChatTurn(async () => ({
			...(isRecord(request.forwardedProps) ? request.forwardedProps : {}),
			message: request.question,
			history: request.history,
			organizationId: this.caller.organizationId,
			conversationId: request.threadId,
			// Only the server-recorded call of an approval; never the client's.
			approvedToolCall: request.approvedToolCall ?? null,
		}));
		if (admitted instanceof Response) {
			await abandonConversationTurnStart({
				turnId: turn.id,
				executionId,
				startToken,
				cancelled: false,
				reason: `refused: ${admitted.status}`,
			});
			await refuseWithResponse(stream, admitted);
			return;
		}

		// Saved only once the turn may run: a refused turn leaves no question
		// behind. A turn that then fails to start is saved with its answer
		// below, as the Direct chat saves a turn whose request failed.
		await recordDirectQuestion(turn);
		try {
			await startAdmittedTurn({
				turn,
				start: async (id) =>
					startDirectChatWorkflow(
						await buildDirectChatWorkflowInput(admitted.turn, id),
					),
				attach: (id) => temporal.workflow.getHandle(id),
			});
		} catch (error) {
			if (error instanceof TurnStoppedBeforeStartError) {
				await settleDirectTurn(turn, { kind: "cancelled" });
				stream.emit({
					type: EventType.RUN_STARTED,
					threadId: request.threadId,
					runId: request.runId,
				});
				stream.emit({
					type: EventType.RUN_FINISHED,
					threadId: request.threadId,
					runId: request.runId,
					outcome: { type: "cancelled" },
				});
				return;
			}
			if (error instanceof TurnStartAmbiguousError) {
				refuse(
					stream,
					"TURN_START_UNCONFIRMED",
					"The run's start could not be confirmed; reconnect to check it.",
				);
				return;
			}
			const message = buildWorkflowErrorEvent(error).message;
			await settleDirectTurn(turn, { kind: "failed", message });
			refuse(stream, "TURN_START_FAILED", message);
			return;
		}
		await observeDirectTurn({
			caller: this.caller,
			turn,
			runId: request.runId,
			stream,
			billing: apiBillingNotice(admitted.planPreflight),
		});
	}
}
