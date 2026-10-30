import { type AGUIEvent, EventType, type Interrupt } from "@ag-ui/client";
import { getTemporalClient } from "@repo/temporal";
import {
	MULTI_AGENT_RUN_EVENT,
	type MultiAgentRecordAgent,
	type MultiAgentTurnRecord,
} from "@saas/agents/lib/multi-agent-runtime-protocol";
import {
	ORCHESTRATOR_RUN_EVENT,
	type OrchestratorRunState,
	orchestratorTurnMessageIds,
} from "@saas/agents/lib/orchestrator-runtime-protocol";
import {
	ChatRunAccessError,
	getAuthorizedChatRun,
} from "@saas/agents/lib/server/chat-run-control";
import { isWorkflowNotFound } from "@saas/agents/lib/server/conversation-turn-admission";
import { subscribeExecutionEvents } from "@saas/agents/lib/server/execution-event-subscriber";
import { createOrchestratorExecutionObserver } from "../../../../app/api/agents/fabric-ai/orchestrator-temporal/execution-observer";
import { reconcileTurnWithWorkflow } from "../../../../app/api/agents/fabric-ai/orchestrator-temporal/turn-admission";
import type { ApiBillingNotice } from "./direct-turn-record";
import type { RunStream, RuntimeCaller } from "./engine";
import type { MultiAgentGroup, MultiAgentMember } from "./multi-agent-group";
import { saveMultiAgentTurn } from "./multi-agent-turn-record";
import { OrchestratorTranslator } from "./orchestrator-translator";
import { orchestratorTurnOutcome } from "./orchestrator-turn-record";
import { scopeSubagentEvent, scopeSubagentInterrupt } from "./subagent-scope";

/** The single-turn follower's timings (`orchestrator-turn-follow.ts`). */
const POLL_INTERVAL_MS = 200;
const QUIET_MS = 750;
const MAX_OVERRUN_MS = 20_000;
const HEARTBEAT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type AuthorizedRun = Awaited<ReturnType<typeof getAuthorizedChatRun>>;
type RunHandle = AuthorizedRun["handle"];

/** How one response opens its run of a multi-agent turn. */
export interface MultiAgentRunOpening {
	/** The turn's question (a multi-agent turn takes no follow-ups). */
	inputMessage: { id: string; content: string };
	resumed: boolean;
	/** Each agent's billing header, by member key, on the run that started them. */
	billing: ReadonlyMap<string, ApiBillingNotice | null>;
	/** Events after the opening: a resolved interrupt. */
	announce: AGUIEvent[];
}

/**
 * Where one agent is in this response: followed, ended (its end saved and
 * sent), waiting on an answer, or no longer followed by this response.
 */
type MemberPhase = "following" | "ended" | "suspended" | "quiet";

/** One agent of the turn, followed as the single-turn follower follows a turn. */
class MemberFollow {
	phase: MemberPhase = "following";
	interrupts: Interrupt[] = [];
	handle: RunHandle | null = null;
	readonly translator: OrchestratorTranslator;
	private readonly observer: ReturnType<
		typeof createOrchestratorExecutionObserver
	>;
	private held: AGUIEvent[] | null = [];
	private unsubscribe: () => void = () => {};

	constructor(
		readonly member: MultiAgentMember,
		private readonly group: MultiAgentTurnFollow,
		windowNonce: string,
		decided: ReadonlySet<string>,
	) {
		this.translator = new OrchestratorTranslator({
			turnKey: member.memberKey,
			windowNonce,
			threadId: group.threadId,
			runId: group.runId,
			emit: (event) => this.translated(event),
			decided,
		});
		this.observer = createOrchestratorExecutionObserver({
			emit: (event) => this.translator.apply(event),
			reattach: async () => (await this.authorizedRun()).handle,
		});
	}

	get executionId(): string {
		const executionId = this.member.turn.executionId;
		if (!executionId) {
			throw new Error("A followed agent's turn has an execution");
		}
		return executionId;
	}

	authorizedRun(): Promise<AuthorizedRun> {
		return getAuthorizedChatRun({
			executionId: this.executionId,
			userId: this.group.caller.userId,
			engine: "orchestrator",
			action: "reattach",
			expectedOrganizationId: this.group.caller.organizationId,
		});
	}

	async subscribe(): Promise<void> {
		this.unsubscribe = await subscribeExecutionEvents({
			executionId: this.executionId,
			onEvent: (event) => {
				if (!this.group.closed()) {
					this.observer.onExecutionEvent(event);
				}
			},
			logPrefix: "[Agent Runtime] Multi-agent",
		});
	}

	close(): void {
		this.unsubscribe();
		this.unsubscribe = () => {};
	}

	/** Send what arrived before the run opened. */
	release(): void {
		const held = this.held ?? [];
		this.held = null;
		for (const event of held) {
			this.group.emit(event);
		}
	}

	poll(handle: RunHandle) {
		return this.observer.poll(handle);
	}

	/** The translator's event as this agent's subagent event. */
	private translated(event: AGUIEvent): void {
		const scope = this.member;
		let scoped: AGUIEvent[];
		if (event.type === EventType.RUN_FINISHED) {
			const outcome = event.outcome;
			if (outcome?.type === "interrupt") {
				this.phase = "suspended";
				this.interrupts = outcome.interrupts.map((interrupt) =>
					scopeSubagentInterrupt(interrupt, scope),
				);
				scoped = [
					{
						type: EventType.CUSTOM,
						name: MULTI_AGENT_RUN_EVENT.interrupt,
						value: { interrupts: this.interrupts },
						subagentRunId: scope.memberKey,
					},
					{
						type: EventType.SUBAGENT_FINISHED,
						subagentRunId: scope.memberKey,
						outcome: {
							type: "suspended",
							interruptIds: this.interrupts.map(
								(interrupt) => interrupt.id,
							),
						},
					},
				];
			} else {
				scoped = [
					{
						type: EventType.SUBAGENT_FINISHED,
						subagentRunId: scope.memberKey,
						result: event.result,
						outcome: { type: "success" },
					},
				];
			}
		} else if (event.type === EventType.RUN_ERROR) {
			scoped = [
				{
					type: EventType.SUBAGENT_ERROR,
					subagentRunId: scope.memberKey,
					message: event.message,
					...(event.code ? { code: event.code } : {}),
					...(event.metadata ? { metadata: event.metadata } : {}),
				},
			];
		} else {
			scoped = [scopeSubagentEvent(event, scope)];
		}
		for (const next of scoped) {
			if (this.held) {
				this.held.push(next);
			} else {
				this.group.emit(next);
			}
		}
	}
}

/**
 * One response following a multi-agent turn: each agent's turn followed as
 * the single-turn follower does (Redis events and the Temporal poll,
 * translated by `OrchestratorTranslator`), sent as that agent's AG-UI
 * subagent. An agent's end is saved into the turn's record before it is
 * sent. The run ends when every agent has ended (RUN_FINISHED success, the
 * record final), when every agent left waits on an answer (an interrupt),
 * at the window's quiet point, or when the client goes away.
 */
export class MultiAgentTurnFollow {
	readonly threadId: string;
	private readonly stream: RunStream;
	private readonly members: MemberFollow[];
	private record: MultiAgentTurnRecord;
	private lastSentAt = 0;

	constructor(
		private readonly args: {
			caller: Pick<RuntimeCaller, "userId" | "organizationId">;
			group: MultiAgentGroup;
			runId: string;
			stream: RunStream;
			/** Interrupts this run just answered, by member key. */
			decided?: ReadonlyMap<string, ReadonlySet<string>>;
			/** The question's thumbnails (the first agent's start memo). */
			imageUrls?: string[];
		},
	) {
		const { group, runId } = args;
		if (!group.lead.conversationId) {
			throw new Error("A multi-agent turn has a conversation");
		}
		this.threadId = group.lead.conversationId;
		this.record = group.record;
		this.stream = {
			...args.stream,
			emit: (event) => {
				this.lastSentAt = Date.now();
				args.stream.emit(event);
			},
		};
		const windowNonce = runId.slice(0, 8) + Date.now().toString(36);
		this.members = group.members.map(
			(member) =>
				new MemberFollow(
					member,
					this,
					windowNonce,
					args.decided?.get(member.memberKey) ?? new Set(),
				),
		);
		for (const follow of this.members) {
			if (this.recorded(follow.member)?.status !== "running") {
				follow.phase = "ended";
			}
		}
	}

	get caller() {
		return this.args.caller;
	}

	get runId(): string {
		return this.args.runId;
	}

	closed(): boolean {
		return this.args.stream.isClosed();
	}

	emit(event: AGUIEvent): void {
		this.stream.emit(event);
	}

	private recorded(
		member: MultiAgentMember,
	): MultiAgentRecordAgent | undefined {
		return this.record.agents.find((agent) => agent.index === member.index);
	}

	/** Subscribe to every running agent's live events (before their start). */
	async subscribe(): Promise<void> {
		await Promise.all(this.following().map((follow) => follow.subscribe()));
	}

	close(): void {
		for (const follow of this.members) {
			follow.close();
		}
	}

	/** Open the run and follow the agents; always ends the subscriptions. */
	async follow(opening: MultiAgentRunOpening): Promise<void> {
		try {
			this.open(opening);
			await this.followAgents();
		} finally {
			this.close();
		}
	}

	private following(): MemberFollow[] {
		return this.members.filter((follow) => follow.phase === "following");
	}

	private open(opening: MultiAgentRunOpening): void {
		const { group, runId } = this.args;
		const threadId = this.threadId;
		const lead = group.lead;
		this.emit({
			type: EventType.RUN_STARTED,
			threadId,
			runId,
			input: {
				threadId,
				runId,
				messages: [
					{
						id: opening.inputMessage.id,
						role: "user",
						content: opening.inputMessage.content,
					},
				],
				tools: [],
				context: [],
			},
		});
		const agents: OrchestratorRunState[] = [];
		for (const { turn, index } of group.members) {
			agents[index] = {
				executionId: turn.executionId ?? "",
				turnId: turn.id,
				turnGeneration: turn.generation,
				phase: null,
				routing: null,
				plan: null,
				currentStep: null,
				progress: null,
			};
		}
		this.emit({ type: EventType.STATE_SNAPSHOT, snapshot: { agents } });
		this.emit({
			type: EventType.CUSTOM,
			name: ORCHESTRATOR_RUN_EVENT.execution,
			value: {
				executionId: lead.executionId,
				turnId: lead.id,
				turnGeneration: lead.generation,
				resumed: opening.resumed,
			},
		});
		for (const event of opening.announce) {
			this.emit(event);
		}
		for (const follow of this.members) {
			this.openMember(
				follow,
				opening.billing.get(follow.member.memberKey),
			);
		}
	}

	private openMember(
		follow: MemberFollow,
		billing: ApiBillingNotice | null | undefined,
	): void {
		const { member } = follow;
		const subagentRunId = member.memberKey;
		this.emit({
			type: EventType.SUBAGENT_STARTED,
			subagentRunId,
			name: member.name,
			metadata: {
				fabric: {
					index: member.index,
					agentId: member.agentId,
					...(member.vendor ? { vendor: member.vendor } : {}),
					executionId: member.turn.executionId,
					turnId: member.turn.id,
					turnGeneration: member.turn.generation,
				},
			},
		});
		if (billing) {
			this.emit({
				type: EventType.CUSTOM,
				name: ORCHESTRATOR_RUN_EVENT.billing,
				value: billing,
				subagentRunId,
			});
		}
		const recorded = this.recorded(member);
		if (follow.phase === "ended" && recorded) {
			this.emitRecordedEnd(recorded, subagentRunId);
			return;
		}
		follow.release();
	}

	/** An agent that ended before this response: its saved end, sent again. */
	private emitRecordedEnd(
		agent: MultiAgentRecordAgent,
		subagentRunId: string,
	): void {
		if (agent.status === "error") {
			this.emit({
				type: EventType.SUBAGENT_ERROR,
				subagentRunId,
				message: agent.error ?? "The agent failed.",
				metadata: { fabric: { recorded: agent } },
			});
			return;
		}
		this.emit({
			type: EventType.SUBAGENT_FINISHED,
			subagentRunId,
			result: { recorded: agent },
			outcome: { type: "success" },
		});
	}

	/**
	 * The agent's run, once Temporal has it; an agent whose workflow never
	 * appeared is settled by the shared reconcile and ends here as failed.
	 */
	private async attach(follow: MemberFollow): Promise<void> {
		try {
			follow.handle = (await follow.authorizedRun()).handle;
			return;
		} catch (error) {
			if (error instanceof ChatRunAccessError) {
				await this.endUnstarted(
					follow,
					"This agent is not accessible.",
				);
				return;
			}
			if (!isWorkflowNotFound(error)) {
				throw error;
			}
		}
		const settled = await reconcileTurnWithWorkflow({
			turn: follow.member.turn,
			temporalClient: await getTemporalClient(),
		});
		if (settled === "terminalized") {
			await this.endUnstarted(follow, "This agent did not start.");
		}
	}

	private async endUnstarted(
		follow: MemberFollow,
		message: string,
	): Promise<void> {
		follow.phase = "ended";
		await this.saveEnd(follow, {
			status: "error",
			error: message,
		});
		this.emit({
			type: EventType.SUBAGENT_ERROR,
			subagentRunId: follow.member.memberKey,
			message,
			code: "TURN_NOT_STARTED",
		});
	}

	private async saveEnd(
		follow: MemberFollow,
		end: Pick<
			MultiAgentRecordAgent,
			"status" | "answer" | "error" | "cancelledAt" | "record"
		>,
	): Promise<void> {
		const { member } = follow;
		const next: MultiAgentTurnRecord = {
			...this.record,
			agents: this.record.agents.map((agent) =>
				agent.index === member.index ? { ...agent, ...end } : agent,
			),
		};
		try {
			this.record = await saveMultiAgentTurn(
				this.args.caller,
				this.args.group.lead,
				next,
				this.args.imageUrls,
			);
		} catch (error) {
			this.record = next;
			console.error("[Agent Runtime] Failed to save a multi-agent turn", {
				executionId: member.turn.executionId,
				error,
			});
		}
	}

	/** Save an agent's end, then send it. */
	private async finishMember(follow: MemberFollow): Promise<void> {
		const terminal = follow.translator.terminal;
		if (!terminal) {
			return;
		}
		follow.phase = "ended";
		const outcome = orchestratorTurnOutcome(
			{
				turn: follow.member.turn,
				imageUrls: this.args.imageUrls,
				billing: null,
			},
			terminal,
			follow.translator.facts,
		);
		if (outcome) {
			const error = outcome.execution.error;
			await this.saveEnd(follow, {
				status: outcome.status,
				answer: outcome.answer.content,
				...(typeof error === "string" ? { error } : {}),
				...(outcome.answer.cancelledAt
					? { cancelledAt: outcome.answer.cancelledAt }
					: {}),
				record: outcome.execution,
			});
		}
		follow.translator.finish(terminal);
	}

	private async followAgents(): Promise<void> {
		const stream = this.stream;
		while (!stream.isClosed()) {
			for (const follow of this.following()) {
				if (!follow.handle) {
					await this.attach(follow);
					if (!follow.handle) {
						continue;
					}
				}
				const polled = await follow.poll(follow.handle);
				follow.handle = polled.handle;
				if (follow.translator.terminal) {
					await this.finishMember(follow);
				} else if (polled.complete && follow.phase === "following") {
					follow.phase = "quiet";
				}
			}
			if (this.following().length === 0) {
				this.end();
				return;
			}
			const now = Date.now();
			const textOpen = this.following().some(
				(follow) => follow.translator.textOpen,
			);
			const lastTextAt = Math.max(
				...this.following().map(
					(follow) => follow.translator.lastTextAt,
				),
			);
			if (
				now >= stream.deadline &&
				(!textOpen ||
					now - lastTextAt >= QUIET_MS ||
					now >= stream.deadline + MAX_OVERRUN_MS)
			) {
				this.reconnect();
				return;
			}
			if (now - this.lastSentAt >= HEARTBEAT_MS) {
				this.emit({
					type: EventType.CUSTOM,
					name: ORCHESTRATOR_RUN_EVENT.heartbeat,
					value: { executionId: this.args.group.lead.executionId },
				});
			}
			await sleep(POLL_INTERVAL_MS);
		}
	}

	/** No agent is followed any more: the run's end. */
	private end(): void {
		const { runId } = this.args;
		const threadId = this.threadId;
		if (this.members.every((follow) => follow.phase === "ended")) {
			this.emit({
				type: EventType.RUN_FINISHED,
				threadId,
				runId,
				result: { multiAgent: this.record },
				outcome: { type: "success" },
			});
			return;
		}
		const interrupts = this.members.flatMap((follow) =>
			follow.phase === "suspended" ? follow.interrupts : [],
		);
		if (
			interrupts.length > 0 &&
			this.members.every(
				(follow) =>
					follow.phase === "ended" || follow.phase === "suspended",
			)
		) {
			this.emit({
				type: EventType.RUN_FINISHED,
				threadId,
				runId,
				outcome: { type: "interrupt", interrupts },
			});
			return;
		}
		this.reconnect();
	}

	/** The response ends inside the function's window; the agents go on. */
	private reconnect(): void {
		for (const follow of this.following()) {
			follow.translator.close();
		}
		this.emit({
			type: EventType.CUSTOM,
			name: ORCHESTRATOR_RUN_EVENT.reconnect,
			value: {
				executionId: this.args.group.lead.executionId,
				runId: this.args.runId,
			},
		});
	}
}

/** The run's question message: the turn's own, under its key. */
export function multiAgentQuestion(group: MultiAgentGroup): {
	id: string;
	content: string;
} {
	return {
		id: orchestratorTurnMessageIds(group.lead.clientRequestKey).user,
		content: group.lead.questionText ?? "",
	};
}
