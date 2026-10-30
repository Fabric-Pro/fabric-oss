/**
 * The Orchestrator engine behind the agent runtime: one AG-UI run is one
 * Orchestrator chat turn (`orchestratorExecutionWorkflow`), admitted, billed
 * and started exactly as the Orchestrator stream route does it
 * (`app/api/agents/fabric-ai/orchestrator-temporal/orchestrator-turn.ts`) and
 * followed from Redis and Temporal (`orchestrator-turn-follow.ts`), so a
 * closed response never ends the turn. The event mapping is in
 * `lib/orchestrator-runtime-protocol.ts`.
 *
 * Served only while `COPILOTKIT_ORCHESTRATOR_CHAT` is on for the caller's
 * organization; otherwise every run and connect is refused `FEATURE_DISABLED`
 * and the chat stays on the stream route.
 *
 * Thread = conversation, run = turn, as the Direct engine. While a turn runs:
 * - a new message is a follow-up, signalled into the running turn as the
 *   follow-up route does, and the run then tails the same turn;
 * - an approval or a clarifying question ends the run as an interrupt, and
 *   the answer is a run that resumes it (the approve and clarify routes'
 *   checks), then tails the same turn;
 * - `stop` cancels it with the cancel route's checks; a stop for a run id no
 *   turn has yet tombstones that key, so the message never starts.
 *
 * A run whose `forwardedProps.multiAgent` names two to four agents is a
 * multi-agent turn (`multi-agent-turns.ts`): live until every agent's turn
 * has ended, taking no follow-up and no new message meanwhile.
 */
import {
	contentToText,
	EventType,
	type Message,
	type ResumeEntry,
	type RunAgentInput,
} from "@ag-ui/client";
import { enterAiInteractiveContext } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import { checkRateLimit } from "@repo/api/lib/rate-limit";
import {
	type ConversationTurn,
	getConversationTurnByClientKey,
	getLatestConversationTurn,
	isFeatureEnabled,
	requestConversationTurnCancel,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { FABRIC_AGENT_ID } from "@repo/utils/page-limits";
import { multiAgentRunRequestSchema } from "@saas/agents/lib/multi-agent-runtime-protocol";
import { mergeOrchestratorConversationMetadata } from "@saas/agents/lib/orchestrator-conversation-tools";
import {
	ORCHESTRATOR_RUN_EVENT,
	orchestratorTurnMessageIds,
} from "@saas/agents/lib/orchestrator-runtime-protocol";
import {
	ChatRunAccessError,
	getAuthorizedChatRun,
	recordChatRunControlAudit,
} from "@saas/agents/lib/server/chat-run-control";
import {
	isTerminalTurnStatus,
	isWorkflowNotFound,
} from "@saas/agents/lib/server/conversation-turn-admission";
import { getSession } from "@saas/auth/lib/server";
import { z } from "zod";
import { InvalidBudgetContinuationError } from "../../../../app/api/agents/fabric-ai/orchestrator-temporal/budget-continuation";
import { resolveOrchestratorTurnRequest } from "../../../../app/api/agents/fabric-ai/orchestrator-temporal/orchestrator-turn";
import {
	admitChatTurn,
	isCancelledBeforeStart,
	reconcileTurnWithWorkflow,
	startTurnWorkflow,
} from "../../../../app/api/agents/fabric-ai/orchestrator-temporal/turn-admission";
import { RUN_ID_PATTERN } from "./direct-engine";
import { DIRECT_EXECUTION_MODE } from "./direct-turn-record";
import type { RunStream, RuntimeCaller, RuntimeEngine } from "./engine";
import { isMultiAgentLead } from "./multi-agent-group";
import { MultiAgentTurns } from "./multi-agent-turns";
import { answerOrchestratorInterrupt } from "./orchestrator-interrupt-answer";
import {
	type OrchestratorRunOpening,
	OrchestratorTurnFollow,
} from "./orchestrator-turn-follow";
import {
	abandonOrchestratorStart,
	claimFollowUp,
	prepareOrchestratorStart,
	refuseOrchestratorDisabled,
	refuseOrchestratorStart,
} from "./orchestrator-turn-start";
import { refuse, refuseWithResponse } from "./run-errors";
import {
	ensureThread,
	readThreadAccess,
	readThreadMessages,
	threadSnapshotMessages,
	threadTitle,
} from "./thread";

export { ORCHESTRATOR_AGENT_ID } from "@saas/agents/lib/orchestrator-runtime-protocol";

/**
 * How long one Orchestrator response tails its turn before it ends at a
 * quiet point and the client reconnects: close to the runtime endpoint's
 * function window, so a long turn needs few reconnects.
 */
export const ORCHESTRATOR_STREAM_WINDOW_MS = 240000;

/** The control routes' allowances, shared with them (same keys). */
const RATE_LIMITS = {
	followUp: { key: "orchestrator:follow-up", limit: 20 },
	clarify: { key: "orchestrator:clarify", limit: 20 },
	approve: { key: "orchestrator:approve", limit: 10 },
	cancel: { key: "orchestrator:cancel", limit: 10 },
} as const;
const RATE_WINDOW_MS = 60_000;

/** The follow-up route's bound. */
const MAX_FOLLOW_UP_CHARS = 50_000;

/** A turn that ended this recently and was not saved is followed again by a connect. */
const RECENT_END_MS = 10 * 60_000;

/** The run's `forwardedProps` the engine itself reads (the rest is the stream route's body). */
const forwardedPropsSchema = z
	.object({
		executionMode: z.string().optional(),
		followUp: z
			.object({ isModification: z.boolean().optional() })
			.optional(),
		displayImageUrls: z.array(z.string().max(2048)).max(20).optional(),
		conversationSettings: z
			.object({
				executionMode: z
					.enum(["lite", "balanced", "deep", "planner"])
					.optional(),
				instanceId: z.string().optional(),
				selectedMcpConfigIds: z.array(z.string()).optional(),
				documentChatId: z.string().optional(),
			})
			.optional(),
		multiAgent: multiAgentRunRequestSchema.optional(),
	})
	.passthrough();
type ForwardedProps = z.infer<typeof forwardedPropsSchema>;

/** Prior user and assistant text: the transcript the stream route takes as `history`. */
function historyOf(
	messages: Message[],
): Array<{ role: "user" | "assistant"; content: string }> {
	return messages.flatMap((message) => {
		if (message.role !== "user" && message.role !== "assistant") {
			return [];
		}
		const content = contentToText(message.content);
		return content ? [{ role: message.role, content }] : [];
	});
}

/** The run's question message: the turn's own, under its key. */
function turnQuestion(
	turn: ConversationTurn,
): OrchestratorRunOpening["inputMessage"] {
	return {
		id: orchestratorTurnMessageIds(turn.clientRequestKey).user,
		content: turn.questionText ?? "",
	};
}

const refuseForbidden = (stream: RunStream) =>
	refuse(stream, "FORBIDDEN", "This thread is not accessible.");

const refuseStateUnavailable = (stream: RunStream) =>
	refuse(
		stream,
		"TURN_STATE_UNAVAILABLE",
		"Could not confirm the thread's running turn. Please retry.",
	);

/** A live turn, none, or Temporal could not say. */
type LiveTurn = ConversationTurn | null | "unavailable";

/** The Orchestrator engine for one caller (see the file header). */
export class OrchestratorEngine implements RuntimeEngine {
	/** Multi-agent turns (`multi-agent-turns.ts`), with this engine's checks. */
	private readonly multi: MultiAgentTurns;

	constructor(
		private readonly caller: RuntimeCaller,
		readonly streamWindowMs: number = ORCHESTRATOR_STREAM_WINDOW_MS,
	) {
		this.multi = new MultiAgentTurns(caller, {
			allowed: (route, stream) =>
				this.allowed(RATE_LIMITS[route], stream),
			controlRun: (turn, stream) => this.controlRun(turn, stream),
			cancelTurn: (turn) => this.cancelTurn(turn),
		});
	}

	private enabled(): Promise<boolean> {
		return isFeatureEnabled(
			"COPILOTKIT_ORCHESTRATOR_CHAT",
			this.caller.organizationId,
		);
	}

	private async allowed(
		limit: (typeof RATE_LIMITS)[keyof typeof RATE_LIMITS],
		stream: RunStream,
	): Promise<boolean> {
		const result = await checkRateLimit(
			`${limit.key}:${this.caller.userId}`,
			limit.limit,
			RATE_WINDOW_MS,
		);
		if (!result.allowed) {
			refuse(
				stream,
				"RATE_LIMITED",
				`Too many requests. Please try again in ${result.resetInSeconds} seconds.`,
			);
		}
		return result.allowed;
	}

	async run(
		{ threadId, input }: { threadId: string; input: RunAgentInput },
		stream: RunStream,
	): Promise<void> {
		if (!(await this.enabled())) {
			refuseOrchestratorDisabled(stream);
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
		const props = forwardedPropsSchema.safeParse(
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
			const live = await this.liveTurn(threadId);
			if (live === "unavailable") {
				refuseStateUnavailable(stream);
				return;
			}
			if (live) {
				await this.toLiveTurn(
					live,
					input.runId,
					question,
					props.data,
					stream,
				);
				return;
			}
		}
		if (props.data.followUp) {
			refuse(
				stream,
				"TURN_NOT_RUNNING",
				"The turn this follow-up was for is no longer running.",
			);
			return;
		}
		await this.startTurn(
			{
				threadId,
				runId: input.runId,
				question,
				history: historyOf(input.messages.slice(0, -1)),
				props: props.data,
			},
			stream,
		);
	}

	/**
	 * The thread so far as one MESSAGES_SNAPSHOT, then the live turn's tail
	 * when one runs (a pending approval or question is raised again). A turn
	 * that ended moments ago without being saved is followed too, so the
	 * response that missed its end saves it and reports it.
	 */
	async connect(threadId: string, stream: RunStream): Promise<void> {
		if (!(await this.enabled())) {
			refuseOrchestratorDisabled(stream);
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
		const live = await this.liveTurn(threadId);
		if (live === "unavailable") {
			refuseStateUnavailable(stream);
			return;
		}
		const saved = (await readThreadMessages(threadId, this.caller)) ?? [];
		stream.emit({
			type: EventType.MESSAGES_SNAPSHOT,
			messages: threadSnapshotMessages(saved),
		});
		const turn = live ?? (await this.latestTurn(threadId));
		if (!turn) {
			return;
		}
		if (isMultiAgentLead(turn)) {
			await this.multi.connect(turn, live !== null, stream);
			return;
		}
		const answerId = orchestratorTurnMessageIds(
			turn.clientRequestKey,
		).assistant;
		const endedUnsaved =
			isTerminalTurnStatus(turn.status) &&
			turn.terminalAt !== null &&
			Date.now() - turn.terminalAt.getTime() < RECENT_END_MS &&
			!saved.some((message) => message.id === answerId);
		if (live || endedUnsaved) {
			await this.follow(turn, turn.clientRequestKey, stream, {
				inputMessage: turnQuestion(turn),
				resumed: true,
				billing: null,
				announce: [],
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
		const live = await this.liveTurn(threadId);
		return live !== null;
	}

	/**
	 * Stop a turn with the cancel route's checks: the turn a run id names
	 * (none yet: a tombstone on that key, so it never starts), else the
	 * thread's live turn. The cancel is recorded on the turn before Temporal
	 * is asked, and the audit row is written.
	 */
	async stop(threadId: string, runId?: string): Promise<boolean> {
		if (
			!(await this.enabled()) ||
			(await readThreadAccess(threadId, this.caller)).kind !== "owned"
		) {
			return false;
		}
		const limited = await checkRateLimit(
			`${RATE_LIMITS.cancel.key}:${this.caller.userId}`,
			RATE_LIMITS.cancel.limit,
			RATE_WINDOW_MS,
		);
		if (!limited.allowed) {
			return false;
		}
		if (!runId) {
			const live = await this.liveTurn(threadId);
			if (live === null || live === "unavailable") {
				return false;
			}
			return isMultiAgentLead(live)
				? this.multi.stop(live)
				: this.cancelTurn(live);
		}
		const byKey = await getConversationTurnByClientKey({
			clientRequestKey: runId,
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
		});
		if (byKey && isMultiAgentLead(byKey)) {
			return byKey.conversationId === threadId && this.multi.stop(byKey);
		}
		if (byKey) {
			return byKey.conversationId === threadId &&
				byKey.executionMode !== DIRECT_EXECUTION_MODE &&
				!isTerminalTurnStatus(byKey.status)
				? this.cancelTurn(byKey)
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

	private async cancelTurn(turn: ConversationTurn): Promise<boolean> {
		const executionId = turn.executionId;
		if (!executionId) {
			return false;
		}
		let run: Awaited<ReturnType<typeof getAuthorizedChatRun>>;
		try {
			run = await getAuthorizedChatRun({
				executionId,
				userId: this.caller.userId,
				engine: "orchestrator",
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

	/** The thread's latest Orchestrator turn (null when the latest is a Direct one). */
	private async latestTurn(
		threadId: string,
	): Promise<ConversationTurn | null> {
		const latest = await getLatestConversationTurn({
			conversationId: threadId,
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
		});
		return latest && latest.executionMode !== DIRECT_EXECUTION_MODE
			? latest
			: null;
	}

	/**
	 * The thread's running Orchestrator turn, checked against Temporal: a
	 * turn whose workflow ended (or never started past the grace period) is
	 * settled by the shared reconcile and is not live.
	 */
	private async liveTurn(threadId: string): Promise<LiveTurn> {
		const latest = await this.latestTurn(threadId);
		if (latest && isMultiAgentLead(latest)) {
			// Live until every agent's turn has ended, whichever ends first.
			const liveness = await this.multi.liveness(latest);
			switch (liveness) {
				case "running":
					return latest;
				case "unavailable":
					return "unavailable";
				case "ended":
					return null;
				default: {
					const unhandled: never = liveness;
					throw new Error(`Unhandled liveness: ${unhandled}`);
				}
			}
		}
		if (!latest || isTerminalTurnStatus(latest.status)) {
			return null;
		}
		const settled = await reconcileTurnWithWorkflow({
			turn: latest,
			temporalClient: await getTemporalClient(),
		});
		switch (settled) {
			case "unavailable":
				return "unavailable";
			case "terminalized":
				return null;
			case "running":
				return latest;
			default: {
				const unhandled: never = settled;
				throw new Error(`Unhandled reconcile: ${unhandled}`);
			}
		}
	}

	private async follow(
		turn: ConversationTurn,
		runId: string,
		stream: RunStream,
		opening: OrchestratorRunOpening,
		decided?: ReadonlySet<string>,
	): Promise<void> {
		const follow = new OrchestratorTurnFollow({
			caller: this.caller,
			turn,
			runId,
			stream,
			decided,
		});
		await follow.subscribe();
		await follow.follow(opening);
	}

	/**
	 * A message while a turn runs. The run that admitted the turn, retried,
	 * attaches to it; any other message is a follow-up signalled into it
	 * (the follow-up route's checks), and the run tails the same turn.
	 */
	private async toLiveTurn(
		turn: ConversationTurn,
		runId: string,
		message: string,
		props: ForwardedProps,
		stream: RunStream,
	): Promise<void> {
		if (isMultiAgentLead(turn) || props.multiAgent) {
			// A multi-agent turn takes no follow-up, nor does a single turn
			// take a multi-agent message: only the retried run attaches.
			if (isMultiAgentLead(turn) && turn.clientRequestKey === runId) {
				await this.multi.attach(turn, runId, stream);
				return;
			}
			refuse(
				stream,
				"TURN_IN_PROGRESS",
				"Wait for the running turn to finish, or stop it, before sending a new message.",
			);
			return;
		}
		if (turn.clientRequestKey === runId) {
			await this.follow(turn, runId, stream, {
				inputMessage: turnQuestion(turn),
				resumed: true,
				billing: null,
				announce: [],
			});
			return;
		}
		if (turn.cancelRequestedAt) {
			// A stopped turn is still ending: a new message waits for it
			// rather than reaching the turn it was not sent to.
			if (props.followUp) {
				refuse(
					stream,
					"TURN_NOT_RUNNING",
					"The turn this follow-up was for was stopped.",
				);
			} else {
				refuse(
					stream,
					"TURN_STOPPING",
					"The stopped turn is still ending. Send again in a moment.",
				);
			}
			return;
		}
		if (!(await this.allowed(RATE_LIMITS.followUp, stream))) {
			return;
		}
		if (message.length > MAX_FOLLOW_UP_CHARS) {
			refuse(stream, "INVALID_MESSAGE", "Message must be under 50KB");
			return;
		}
		const run = await this.controlRun(turn, stream);
		if (!run) {
			return;
		}
		if (run.description.status.name !== "RUNNING") {
			refuse(
				stream,
				"TURN_NOT_RUNNING",
				`Workflow is in ${run.description.status.name} state and cannot receive follow-ups`,
			);
			return;
		}
		const isModification = props.followUp?.isModification === true;
		if (await claimFollowUp(runId, run.organizationId)) {
			await run.handle.signal("followUp", { message, isModification });
			console.log("[Agent Runtime] Orchestrator follow-up signalled", {
				executionId: turn.executionId,
				isModification,
				userId: this.caller.userId,
			});
		}
		const messageId = `${runId}:user`;
		await this.follow(turn, runId, stream, {
			inputMessage: { id: messageId, content: message },
			resumed: true,
			billing: null,
			announce: [
				{
					type: EventType.CUSTOM,
					name: ORCHESTRATOR_RUN_EVENT.followUp,
					value: {
						executionId: turn.executionId,
						messageId,
						isModification,
					},
				},
			],
		});
	}

	/** The turn's run with the control routes' authorization, or a refusal. */
	private async controlRun(
		turn: ConversationTurn,
		stream: RunStream,
	): Promise<Awaited<ReturnType<typeof getAuthorizedChatRun>> | null> {
		const executionId = turn.executionId;
		if (!executionId) {
			refuse(stream, "TURN_NOT_RUNNING", "The turn has not started.");
			return null;
		}
		try {
			return await getAuthorizedChatRun({
				executionId,
				userId: this.caller.userId,
				engine: "orchestrator",
				action: "approve",
				expectedOrganizationId: this.caller.organizationId,
			});
		} catch (error) {
			if (error instanceof ChatRunAccessError) {
				refuseForbidden(stream);
				return null;
			}
			if (isWorkflowNotFound(error)) {
				refuse(stream, "TURN_NOT_RUNNING", "The turn has not started.");
				return null;
			}
			throw error;
		}
	}

	/**
	 * Answer the live turn's pending approval or clarifying question (the
	 * interrupt id names which), with the approve and clarify routes' checks,
	 * then tail the same turn. An interrupt that is no longer pending decides
	 * nothing: the run says so (`fabric.orchestrator.interrupt-stale`) and
	 * tails the turn, which raises whatever is pending now.
	 */
	private async resume(
		threadId: string,
		runId: string,
		answer: ResumeEntry,
		stream: RunStream,
	): Promise<void> {
		if ((await readThreadAccess(threadId, this.caller)).kind !== "owned") {
			refuseForbidden(stream);
			return;
		}
		const turn = await this.liveTurn(threadId);
		if (turn === "unavailable") {
			refuseStateUnavailable(stream);
			return;
		}
		if (!turn) {
			refuse(
				stream,
				"INTERRUPT_NOT_PENDING",
				"This question is no longer pending.",
			);
			return;
		}
		if (isMultiAgentLead(turn)) {
			await this.multi.resume(turn, runId, answer, stream);
			return;
		}
		const run = await this.controlRun(turn, stream);
		if (!run) {
			return;
		}
		const answered = await answerOrchestratorInterrupt({
			caller: this.caller,
			turn,
			run,
			answer,
			stream,
			allowed: (route) => this.allowed(RATE_LIMITS[route], stream),
		});
		if (answered.kind === "refused") {
			return;
		}
		const resolved = answered.kind === "resolved" ? answered.event : null;

		await this.follow(
			turn,
			runId,
			stream,
			{
				inputMessage: turnQuestion(turn),
				resumed: true,
				billing: null,
				announce: [
					resolved ?? {
						type: EventType.CUSTOM,
						name: ORCHESTRATOR_RUN_EVENT.interruptStale,
						value: { interruptId: answer.interruptId },
					},
				],
			},
			resolved ? new Set([answer.interruptId]) : undefined,
		);
	}

	/**
	 * Admit, bill and start one turn in the stream route's order, then tail
	 * it. A retried run (its key already has a turn) attaches to that turn
	 * and starts nothing.
	 */
	private async startTurn(
		request: {
			threadId: string;
			runId: string;
			question: string;
			history: Array<{ role: "user" | "assistant"; content: string }>;
			props: ForwardedProps;
		},
		stream: RunStream,
	): Promise<void> {
		const { threadId, runId, question, props } = request;
		if (props.executionMode === "weave") {
			refuse(
				stream,
				"UNSUPPORTED_EXECUTION_MODE",
				"Weave runs are not chat turns.",
			);
			return;
		}
		const settings = props.conversationSettings;
		const writable = await ensureThread(threadId, this.caller, {
			agentId: FABRIC_AGENT_ID,
			title: threadTitle(question),
			metadata: mergeOrchestratorConversationMetadata({
				executionMode: settings?.executionMode ?? "balanced",
				instanceId: settings?.instanceId,
				selectedMcpConfigIds: settings?.selectedMcpConfigIds,
				documentChatId: settings?.documentChatId,
			}),
		});
		if (!writable) {
			refuseForbidden(stream);
			return;
		}
		const session = await getSession();
		if (!session || session.user.id !== this.caller.userId) {
			refuseForbidden(stream);
			return;
		}
		enterAiInteractiveContext({
			userId: session.user.id,
			impersonated: Boolean(session.session.impersonatedBy),
		});

		// The stream route's body: the server owns the organization, the
		// conversation, the key, and which execution a run is.
		const {
			followUp: _followUp,
			displayImageUrls: _displayImageUrls,
			conversationSettings: _settings,
			multiAgent,
			...body
		} = props;
		if (multiAgent) {
			await this.multi.start(
				session,
				{
					threadId,
					runId,
					question,
					history: request.history,
					body,
					multiAgent,
					displayImageUrls: props.displayImageUrls,
				},
				stream,
			);
			return;
		}
		const turnRequest = await resolveOrchestratorTurnRequest({
			session,
			body: {
				...body,
				message: question,
				history: request.history,
				organizationId: this.caller.organizationId,
				conversationId: threadId,
				clientRequestKey: runId,
				executionId: undefined,
			},
		});
		if (turnRequest instanceof Response) {
			await refuseWithResponse(stream, turnRequest);
			return;
		}
		const temporalClient = await getTemporalClient();
		const admission = await admitChatTurn({
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
			conversationId: threadId,
			clientRequestKey: runId,
			executionMode: turnRequest.executionMode,
			question,
			temporalClient,
		});
		switch (admission.kind) {
			case "refused":
				await refuseWithResponse(stream, admission.response);
				return;
			case "existing":
				if (isCancelledBeforeStart(admission.turn)) {
					refuse(
						stream,
						"TURN_CANCELLED",
						"This message was stopped before it started.",
					);
					return;
				}
				await this.follow(admission.turn, runId, stream, {
					inputMessage: turnQuestion(admission.turn),
					resumed: true,
					billing: null,
					announce: [],
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
		const prepared = await prepareOrchestratorStart(
			this.caller,
			turn,
			turnRequest,
			temporalClient,
		);
		if (prepared instanceof Response) {
			await abandonOrchestratorStart(turn, `refused: ${prepared.status}`);
			await refuseWithResponse(stream, prepared);
			return;
		}

		const follow = new OrchestratorTurnFollow({
			caller: this.caller,
			turn,
			runId,
			stream,
		});
		// Before the start: Redis keeps no history, so a later subscription
		// would miss the turn's first text.
		await follow.subscribe();
		try {
			await startTurnWorkflow({
				temporalClient,
				turn,
				workflowInput: prepared.workflowInput,
				...(turnRequest.continueFromTurnId
					? { continueFromTurnId: turnRequest.continueFromTurnId }
					: {}),
				memo: {
					userId: this.caller.userId,
					organizationId: this.caller.organizationId,
					projectId: turnRequest.projectId ?? null,
					...(props.displayImageUrls?.length
						? { displayImageUrls: props.displayImageUrls }
						: {}),
				},
			});
		} catch (error) {
			follow.close();
			refuseOrchestratorStart(error, request, stream);
			if (error instanceof InvalidBudgetContinuationError) {
				await refuseWithResponse(stream, error.response());
			}
			return;
		}
		await follow.follow({
			inputMessage: turnQuestion(turn),
			resumed: false,
			billing: prepared.billing,
			announce: [],
		});
	}
}
