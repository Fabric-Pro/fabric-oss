/**
 * The deep-researcher engine behind the agent runtime: one AG-UI run is one
 * Deep Research run (`deepResearcherWorkflow`), admitted and started exactly
 * as the stream route does it (`app/api/agents/workflow-templates/
 * workflow-template-run.ts`) and observed from Temporal, so a closed
 * response never ends the research. The event mapping is in
 * `lib/research-runtime-protocol.ts`.
 *
 * Served only while `COPILOTKIT_RESEARCH_RUNS` is on for the caller's
 * organization; otherwise every run and connect is refused
 * `FEATURE_DISABLED`, a stop stops nothing and nothing is read or written.
 *
 * Thread = conversation: a Fabric AI conversation in Research mode
 * (`metadata.mode = "research"`). Run = one `ConversationTurn` with
 * `executionMode = "research"`, keyed by the AG-UI run id; its execution id
 * is the workflow's id, also recorded in the conversation's
 * `metadata.executions`. The question is saved when the run is admitted and
 * the answer (the report, or why it failed or stopped) when it ends, with
 * the run's record as the answer's `metadata.research`.
 *
 * While a run waits for the answer to its clarifying question, the response
 * ends with an interrupt; the answer is a run that resumes it, signalled to
 * the workflow after the same checks as the clarification route. `stop`
 * cancels the run as the cancel route does.
 */
import {
	contentToText,
	EventType,
	type ResumeEntry,
	type RunAgentInput,
} from "@ag-ui/client";
import {
	type ConversationTurn,
	getConversationTurnByClientKey,
	isFeatureEnabled,
	requestConversationTurnCancel,
} from "@repo/database";
import { type DeepResearcherProgress, getTemporalClient } from "@repo/temporal";
import { FABRIC_AGENT_ID } from "@repo/utils/page-limits";
import {
	RESEARCH_AGENT_ID,
	RESEARCH_EXECUTION_MODE,
	RESEARCH_RUN_EVENT,
	researchInterruptId,
	researchRunPropsSchema,
} from "@saas/agents/lib/research-runtime-protocol";
import { recordChatRunControlAudit } from "@saas/agents/lib/server/chat-run-control";
import {
	admitTurn,
	isTerminalTurnStatus,
	isWorkflowNotFound,
	startAdmittedTurn,
	TurnStartAmbiguousError,
	TurnStoppedBeforeStartError,
} from "@saas/agents/lib/server/conversation-turn-admission";
import { z } from "zod";
import { buildWorkflowErrorEvent } from "../../../../app/api/agents/fabric-ai/stream/turn-events";
import {
	admitWorkflowTemplateRun,
	newWorkflowTemplateExecutionId,
	startDeepResearcherWorkflow,
} from "../../../../app/api/agents/workflow-templates/workflow-template-run";
import { RUN_ID_PATTERN, refuseAdmission } from "./direct-engine";
import type { RunStream, RuntimeCaller, RuntimeEngine } from "./engine";
import {
	observeResearchRun,
	settleFinishedResearchRun,
} from "./research-run-follow";
import {
	isResearchTurn,
	latestResearchTurn,
	recordResearchQuestion,
	settleResearchRun,
	settleUnwatchedResearchRun,
} from "./research-run-record";
import { refuse, refuseWithResponse } from "./run-errors";
import {
	ensureThread,
	readThreadAccess,
	readThreadMessages,
	threadSnapshotMessages,
	threadTitle,
} from "./thread";

export { RESEARCH_AGENT_ID } from "@saas/agents/lib/research-runtime-protocol";

/** A clarification answer: the clarification route's non-empty response. */
const clarificationAnswerSchema = z.object({
	response: z.string().trim().min(1).max(10_000),
});

/** A live research run, none, or Temporal could not say. */
type LiveRun = ConversationTurn | null | "unavailable";

const refuseForbidden = (stream: RunStream) =>
	refuse(stream, "FORBIDDEN", "This thread is not accessible.");

const refuseStateUnavailable = (stream: RunStream) =>
	refuse(
		stream,
		"TURN_STATE_UNAVAILABLE",
		"Could not confirm the thread's running turn. Please retry.",
	);

const refuseNotPending = (stream: RunStream) =>
	refuse(
		stream,
		"INTERRUPT_NOT_PENDING",
		"This question is no longer pending.",
	);

/** The deep-researcher engine for one caller (see the file header). */
export class ResearchEngine implements RuntimeEngine {
	constructor(private readonly caller: RuntimeCaller) {}

	private enabled(): Promise<boolean> {
		return isFeatureEnabled(
			"COPILOTKIT_RESEARCH_RUNS",
			this.caller.organizationId,
		);
	}

	async run(
		{ threadId, input }: { threadId: string; input: RunAgentInput },
		stream: RunStream,
	): Promise<void> {
		if (!(await this.enabled())) {
			refuseDisabled(stream);
			return;
		}
		if (!RUN_ID_PATTERN.test(input.runId)) {
			refuse(
				stream,
				"INVALID_RUN_ID",
				"runId must be 8-128 letters, digits, '-' or '_'",
			);
			return;
		}
		const props = researchRunPropsSchema.safeParse(
			input.forwardedProps ?? {},
		);
		if (!props.success) {
			refuse(stream, "INVALID_REQUEST", "The run's options are invalid.");
			return;
		}
		const answer = input.resume?.[0];
		if (answer) {
			await this.resume(threadId, input.runId, answer, stream);
			return;
		}
		const last = input.messages.at(-1);
		const question =
			last?.role === "user" ? contentToText(last.content).trim() : "";
		if (!question) {
			refuse(stream, "NO_MESSAGE", "A run needs a new user message.");
			return;
		}

		const access = await readThreadAccess(threadId, this.caller);
		if (access.kind === "forbidden") {
			refuseForbidden(stream);
			return;
		}
		if (access.kind === "owned") {
			const live = await this.liveRun(threadId);
			if (live === "unavailable") {
				refuseStateUnavailable(stream);
				return;
			}
			if (live && live.clientRequestKey !== input.runId) {
				refuse(
					stream,
					"TURN_IN_PROGRESS",
					"A research run is already running in this thread.",
				);
				return;
			}
			// A retried run attaches to its own research, live or ended,
			// without being admitted again.
			const retried =
				live ?? (await this.threadTurnByKey(threadId, input.runId));
			if (retried) {
				await this.attach(retried, input.runId, stream);
				return;
			}
		}

		// The stream route's checks run before anything is written: a
		// refused run leaves no conversation and no turn behind.
		const { executionMode, ...workflowProps } = props.data;
		const admitted = await admitWorkflowTemplateRun(this.caller.userId, {
			templateSlug: RESEARCH_AGENT_ID,
			query: question,
			organizationId: this.caller.organizationId,
			...workflowProps,
		});
		if (admitted instanceof Response) {
			await refuseWithResponse(stream, admitted);
			return;
		}
		const writable = await ensureThread(threadId, this.caller, {
			agentId: FABRIC_AGENT_ID,
			title: threadTitle(question),
			metadata: {
				mode: RESEARCH_EXECUTION_MODE,
				executionMode: executionMode ?? "balanced",
			},
		});
		if (!writable) {
			refuseForbidden(stream);
			return;
		}

		const temporal = await getTemporalClient();
		const admission = await admitTurn({
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
			conversationId: threadId,
			clientRequestKey: input.runId,
			newExecutionId: () =>
				newWorkflowTemplateExecutionId(
					this.caller.userId,
					RESEARCH_AGENT_ID,
				),
			executionMode: RESEARCH_EXECUTION_MODE,
			question,
			temporalClient: temporal,
			settleCompleted: settleUnwatchedResearchRun,
			ownsTurn: isResearchTurn,
		});
		switch (admission.kind) {
			case "refused":
				refuseAdmission(stream, admission.refusal);
				return;
			case "existing":
				await this.attach(admission.turn, input.runId, stream);
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
		await recordResearchQuestion(turn);
		try {
			await startAdmittedTurn({
				turn,
				start: (id) =>
					startDeepResearcherWorkflow(temporal, admitted, id),
				attach: (id) => temporal.workflow.getHandle(id),
			});
		} catch (error) {
			if (error instanceof TurnStoppedBeforeStartError) {
				await settleResearchRun(turn, { kind: "cancelled" });
				stream.emit({
					type: EventType.RUN_STARTED,
					threadId,
					runId: input.runId,
				});
				stream.emit({
					type: EventType.RUN_FINISHED,
					threadId,
					runId: input.runId,
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
			await settleResearchRun(turn, { kind: "failed", message });
			refuse(stream, "TURN_START_FAILED", message);
			return;
		}
		await observeResearchRun({ turn, runId: input.runId, stream });
	}

	/**
	 * The thread so far as one MESSAGES_SNAPSHOT, then the live run's tail
	 * when one runs (its pending clarifying question raised again). A run
	 * that ended unwatched is saved first, so the snapshot has its answer.
	 */
	async connect(threadId: string, stream: RunStream): Promise<void> {
		if (!(await this.enabled())) {
			refuseDisabled(stream);
			return;
		}
		const access = await readThreadAccess(threadId, this.caller);
		if (access.kind === "forbidden") {
			refuseForbidden(stream);
			return;
		}
		if (access.kind === "absent") {
			return;
		}
		let latest = await latestResearchTurn(this.caller, threadId);
		if (latest && !isTerminalTurnStatus(latest.status)) {
			const settled = await settleFinishedResearchRun(latest);
			if (settled === "unavailable") {
				refuseStateUnavailable(stream);
				return;
			}
			if (settled === "terminalized") {
				latest = await latestResearchTurn(this.caller, threadId);
			}
		}
		const saved = (await readThreadMessages(threadId, this.caller)) ?? [];
		stream.emit({
			type: EventType.MESSAGES_SNAPSHOT,
			messages: threadSnapshotMessages(saved),
		});
		if (latest && !isTerminalTurnStatus(latest.status)) {
			await observeResearchRun({
				turn: latest,
				runId: latest.clientRequestKey,
				stream,
			});
		}
	}

	async isRunning(threadId: string): Promise<boolean> {
		if (
			!(await this.enabled()) ||
			(await readThreadAccess(threadId, this.caller)).kind !== "owned"
		) {
			return false;
		}
		const live = await this.liveRun(threadId);
		return live !== null && live !== "unavailable";
	}

	/**
	 * Stop a research run with the cancel route's checks: the run a run id
	 * names (none yet: a tombstone on that key, so it never starts), else
	 * the thread's live run. A run id that names another engine's turn, or
	 * another thread's, stops nothing and writes nothing.
	 */
	async stop(threadId: string, runId?: string): Promise<boolean> {
		if (
			!(await this.enabled()) ||
			(await readThreadAccess(threadId, this.caller)).kind !== "owned"
		) {
			return false;
		}
		if (!runId) {
			const latest = await latestResearchTurn(this.caller, threadId);
			return latest &&
				!isTerminalTurnStatus(latest.status) &&
				latest.executionId
				? this.cancelRun(latest.executionId)
				: false;
		}
		const byKey = await getConversationTurnByClientKey({
			clientRequestKey: runId,
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
		});
		if (byKey) {
			return byKey.conversationId === threadId &&
				isResearchTurn(byKey) &&
				!isTerminalTurnStatus(byKey.status) &&
				byKey.executionId
				? this.cancelRun(byKey.executionId)
				: false;
		}
		const recorded = await requestConversationTurnCancel({
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
			source: "USER_STOP",
			clientRequestKey: runId,
			conversationId: threadId,
		});
		return recorded.outcome === "tombstoned";
	}

	/**
	 * Cancel one run as the cancel route does: the cancel is recorded on the
	 * turn before Temporal is asked, the workflow is signalled to stop, then
	 * cancelled, and the runtime's audit row is written.
	 */
	private async cancelRun(executionId: string): Promise<boolean> {
		const recorded = await requestConversationTurnCancel({
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
			source: "USER_STOP",
			executionId,
		});
		const handle = (await getTemporalClient()).workflow.getHandle(
			executionId,
		);
		let description: Awaited<ReturnType<typeof handle.describe>>;
		try {
			description = await handle.describe();
		} catch (error) {
			if (!isWorkflowNotFound(error)) {
				throw error;
			}
			// Not started yet: the cancel recorded on the caller's own turn
			// stops its starter before it starts anything.
			return recorded.outcome === "recorded";
		}
		if (description.status.name !== "RUNNING") {
			return false;
		}
		try {
			await handle.signal("cancel");
		} catch {
			// The cancel below still stops it.
		}
		await handle.cancel();
		recordChatRunControlAudit(this.caller.audit, {
			action: "cancel",
			organizationId: this.caller.organizationId,
			executionId,
			runId: description.runId,
		});
		return true;
	}

	/**
	 * Answer the run's clarifying question, after the clarification route's
	 * checks: the run is the caller's and live, the interrupt is its own, the
	 * answer is not empty, and the workflow is running and still waiting for
	 * it. Then the response tails the run.
	 */
	private async resume(
		threadId: string,
		runId: string,
		answer: ResumeEntry,
		stream: RunStream,
	): Promise<void> {
		// The endpoint lets an absent thread through; nothing is signalled
		// for a thread that is not the caller's.
		if ((await readThreadAccess(threadId, this.caller)).kind !== "owned") {
			refuseForbidden(stream);
			return;
		}
		const turn = await this.liveRun(threadId);
		if (turn === "unavailable") {
			refuseStateUnavailable(stream);
			return;
		}
		if (
			!turn?.executionId ||
			answer.interruptId !== researchInterruptId(turn.clientRequestKey)
		) {
			refuseNotPending(stream);
			return;
		}
		const parsed = clarificationAnswerSchema.safeParse(answer.payload);
		if (answer.status !== "resolved" || !parsed.success) {
			refuse(
				stream,
				"INVALID_REQUEST",
				"A clarification needs a response.",
			);
			return;
		}
		const handle = (await getTemporalClient()).workflow.getHandle(
			turn.executionId,
		);
		const description = await handle.describe().catch(() => null);
		if (description?.status.name !== "RUNNING") {
			refuseNotPending(stream);
			return;
		}
		const progress = await handle
			.query<DeepResearcherProgress>("progress")
			.catch(() => null);
		if (progress?.phase !== "awaiting_clarification") {
			refuseNotPending(stream);
			return;
		}
		await handle.signal("clarification", parsed.data.response);
		await observeResearchRun({
			turn,
			runId,
			stream,
			answered: new Set([answer.interruptId]),
			announce: [
				{
					type: EventType.CUSTOM,
					name: RESEARCH_RUN_EVENT.clarificationAccepted,
					value: { interruptId: answer.interruptId },
				},
			],
		});
	}

	/** The turn a run id already has on this thread, of any engine. */
	private async threadTurnByKey(
		threadId: string,
		runId: string,
	): Promise<ConversationTurn | null> {
		const turn = await getConversationTurnByClientKey({
			clientRequestKey: runId,
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
		});
		return turn?.conversationId === threadId ? turn : null;
	}

	/**
	 * A run whose id already has a turn: its research followed, or its
	 * ending replayed. A stop before it started, or another engine's turn
	 * under that id, starts nothing.
	 */
	private async attach(
		turn: ConversationTurn,
		runId: string,
		stream: RunStream,
	): Promise<void> {
		if (!turn.executionId) {
			refuse(
				stream,
				"TURN_CANCELLED",
				"This research was stopped before it started.",
			);
			return;
		}
		if (!isResearchTurn(turn)) {
			refuse(
				stream,
				"RUN_ID_REUSED",
				"This run id already belongs to another run.",
			);
			return;
		}
		await observeResearchRun({ turn, runId, stream });
	}

	/**
	 * The thread's running research run, checked against Temporal: a run
	 * whose workflow ended is saved and settled, and is not live.
	 */
	private async liveRun(threadId: string): Promise<LiveRun> {
		const latest = await latestResearchTurn(this.caller, threadId);
		if (!latest || isTerminalTurnStatus(latest.status)) {
			return null;
		}
		const settled = await settleFinishedResearchRun(latest);
		switch (settled) {
			case "running":
				return latest;
			case "terminalized":
				return null;
			case "unavailable":
				return "unavailable";
			default: {
				const unhandled: never = settled;
				throw new Error(`Unhandled settle: ${unhandled}`);
			}
		}
	}
}

function refuseDisabled(stream: RunStream): void {
	refuse(
		stream,
		"FEATURE_DISABLED",
		"Deep Research is not enabled on the agent runtime for this organization.",
	);
}
