import { EventType, type ResumeEntry } from "@ag-ui/client";
import { type ConversationTurn, db, isFeatureEnabled } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { multiAgentRequestOverrides } from "@saas/agents/lib/multi-agent-request";
import {
	MAX_MULTI_AGENTS,
	MIN_MULTI_AGENTS,
	MULTI_AGENT_KEY_PREFIX,
	MULTI_AGENT_RUN_EVENT,
	type MultiAgentRunRequest,
	type MultiAgentTurnRecord,
	multiAgentMemberKey,
	splitMultiAgentInterruptId,
} from "@saas/agents/lib/multi-agent-runtime-protocol";
import { ORCHESTRATOR_RUN_EVENT } from "@saas/agents/lib/orchestrator-runtime-protocol";
import type { getAuthorizedChatRun } from "@saas/agents/lib/server/chat-run-control";
import { isTerminalTurnStatus } from "@saas/agents/lib/server/conversation-turn-admission";
import { multiAgentRows } from "@saas/agents/lib/server/multi-agent-admission";
import type { getSession } from "@saas/auth/lib/server";
import { z } from "zod";
import { resolveOrchestratorTurnRequest } from "../../../../app/api/agents/fabric-ai/orchestrator-temporal/orchestrator-turn";
import {
	admitChatTurn,
	isCancelledBeforeStart,
	startTurnWorkflow,
} from "../../../../app/api/agents/fabric-ai/orchestrator-temporal/turn-admission";
import type { RunStream, RuntimeCaller } from "./engine";
import {
	type ResolvedMultiAgent,
	resolveMultiAgentPicks,
} from "./multi-agent-agents";
import {
	loadMultiAgentGroup,
	type MultiAgentGroup,
	type MultiAgentMember,
	multiAgentLiveness,
} from "./multi-agent-group";
import {
	MultiAgentTurnFollow,
	multiAgentQuestion,
} from "./multi-agent-turn-follow";
import {
	runningMultiAgent,
	saveMultiAgentTurn,
} from "./multi-agent-turn-record";
import { answerOrchestratorInterrupt } from "./orchestrator-interrupt-answer";
import {
	abandonOrchestratorStart,
	type OrchestratorTurnRequest,
	type PreparedOrchestratorStart,
	prepareOrchestratorStart,
	refuseOrchestratorStart,
} from "./orchestrator-turn-start";
import { refuse, refuseWithResponse } from "./run-errors";

/**
 * Multi-agent turns of the Orchestrator engine (`multi-agent-runtime-protocol.ts`):
 * one message answered by two to four picked agents side by side, each its
 * own Orchestrator turn (admitted, billed and started as a single turn is,
 * on the Nexus surface), followed together as AG-UI subagents. Started only
 * while `COPILOTKIT_MULTI_AGENT_CHAT` is on for the organization; a turn
 * already running is still followed, answered and stopped after the flag
 * goes off.
 *
 * While any agent runs, the turn is live: the thread takes no new message
 * (`TURN_IN_PROGRESS`), only the retried run that started it.
 */

/** The longest key whose agents' keys (`<key>_a3`) still fit a run id. */
const MAX_TURN_KEY_LENGTH = 124;

/** A turn that ended this recently and was not saved is followed again by a connect. */
const RECENT_END_MS = 10 * 60_000;

/** The chat-wide scope a multi-agent run's options carry, as a single turn's. */
const sharedScopeSchema = z.object({
	enabledMcpConfigIds: z.array(z.string()).nullable().optional(),
	enabledFabricToolIds: z.array(z.string()).nullable().optional(),
	enabledIntegrationIds: z.array(z.string()).nullable().optional(),
	projectId: z.string().nullable().optional(),
	workspaceIds: z.array(z.string()).optional(),
});

type AuthorizedRun = Awaited<ReturnType<typeof getAuthorizedChatRun>>;
type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

/** What the engine lends a multi-agent turn: its rate limits, run control and cancel. */
export interface MultiAgentEngineHooks {
	allowed: (
		route: "approve" | "clarify",
		stream: RunStream,
	) => Promise<boolean>;
	controlRun: (
		turn: ConversationTurn,
		stream: RunStream,
	) => Promise<AuthorizedRun | null>;
	cancelTurn: (turn: ConversationTurn) => Promise<boolean>;
}

/** A multi-agent run's start, as the engine read it. */
export interface MultiAgentStartRequest {
	threadId: string;
	runId: string;
	question: string;
	history: Array<{ role: "user" | "assistant"; content: string }>;
	/** The run's options: the stream route's body without the engine's own fields. */
	body: Record<string, unknown>;
	multiAgent: MultiAgentRunRequest;
	displayImageUrls?: string[];
}

/** One agent between its admission and its start. */
interface AdmittedAgent {
	agent: ResolvedMultiAgent;
	member: MultiAgentMember;
	request: OrchestratorTurnRequest;
}

export class MultiAgentTurns {
	constructor(
		private readonly caller: RuntimeCaller,
		private readonly hooks: MultiAgentEngineHooks,
	) {}

	/** Whether any agent of the turn whose first agent is `lead` still runs. */
	async liveness(
		lead: ConversationTurn,
	): Promise<"running" | "ended" | "unavailable"> {
		return multiAgentLiveness(await multiAgentRows(this.caller, lead));
	}

	/**
	 * A connect's tail: the live turn, or one whose agents all ended
	 * moments ago without the final save (this response saves it).
	 */
	async connect(
		lead: ConversationTurn,
		live: boolean,
		stream: RunStream,
	): Promise<void> {
		const rows = await multiAgentRows(this.caller, lead);
		const lastEnd = Math.max(
			...rows.map((turn) => turn.terminalAt?.getTime() ?? 0),
		);
		const group = await loadMultiAgentGroup(this.caller, lead);
		if (
			group &&
			(live ||
				(!group.record.final &&
					rows.every((turn) => isTerminalTurnStatus(turn.status)) &&
					Date.now() - lastEnd < RECENT_END_MS))
		) {
			await this.follow(group, lead.clientRequestKey, stream, true);
		}
	}

	/** The run that started the turn, retried: it attaches to the turn. */
	async attach(
		lead: ConversationTurn,
		runId: string,
		stream: RunStream,
	): Promise<void> {
		const group = await loadMultiAgentGroup(this.caller, lead);
		if (!group) {
			refuse(
				stream,
				"TURN_PENDING",
				"The agents have not started yet. Reconnect to follow them.",
			);
			return;
		}
		await this.follow(group, runId, stream, true);
	}

	private async follow(
		group: MultiAgentGroup,
		runId: string,
		stream: RunStream,
		resumed: boolean,
		extra: {
			decided?: ReadonlyMap<string, ReadonlySet<string>>;
			announce?: Parameters<RunStream["emit"]>[0][];
		} = {},
	): Promise<void> {
		const follow = new MultiAgentTurnFollow({
			caller: this.caller,
			group,
			runId,
			stream,
			decided: extra.decided,
		});
		await follow.subscribe();
		await follow.follow({
			inputMessage: multiAgentQuestion(group),
			resumed,
			billing: new Map(),
			announce: extra.announce ?? [],
		});
	}

	/** Stop every agent still running; true when any was stopped. */
	async stop(lead: ConversationTurn): Promise<boolean> {
		const rows = await multiAgentRows(this.caller, lead);
		const stopped = await Promise.all(
			rows
				.filter((turn) => !isTerminalTurnStatus(turn.status))
				.map((turn) => this.hooks.cancelTurn(turn)),
		);
		return stopped.includes(true);
	}

	/**
	 * Answer one agent's pending approval (the interrupt id names the agent),
	 * with the approve route's checks, then follow the turn again.
	 */
	async resume(
		lead: ConversationTurn,
		runId: string,
		answer: ResumeEntry,
		stream: RunStream,
	): Promise<void> {
		const group = await loadMultiAgentGroup(this.caller, lead);
		const split =
			group &&
			splitMultiAgentInterruptId(
				answer.interruptId,
				group.members.map((member) => member.memberKey),
			);
		const member =
			split &&
			group?.members.find(
				(candidate) => candidate.memberKey === split.memberKey,
			);
		if (!group || !split || !member) {
			refuse(
				stream,
				"INTERRUPT_NOT_PENDING",
				"This question is no longer pending.",
			);
			return;
		}
		const run = await this.hooks.controlRun(member.turn, stream);
		if (!run) {
			return;
		}
		const answered = await answerOrchestratorInterrupt({
			caller: this.caller,
			turn: member.turn,
			run,
			answer: { ...answer, interruptId: split.interruptId },
			stream,
			allowed: (route) => this.hooks.allowed(route, stream),
		});
		if (answered.kind === "refused") {
			return;
		}
		const resolved = answered.kind === "resolved";
		await this.follow(group, runId, stream, true, {
			decided: resolved
				? new Map([[member.memberKey, new Set([split.interruptId])]])
				: undefined,
			announce: [
				resolved
					? {
							type: EventType.CUSTOM,
							name: MULTI_AGENT_RUN_EVENT.resolved,
							value: {
								subagentRunId: member.memberKey,
								event: answered.event,
							},
						}
					: {
							type: EventType.CUSTOM,
							name: ORCHESTRATOR_RUN_EVENT.interruptStale,
							value: { interruptId: answer.interruptId },
						},
			],
		});
	}

	/**
	 * Admit, bill and start every picked agent's turn, then follow them. A
	 * retried run (its key already has a turn) attaches to that turn.
	 */
	async start(
		session: Session,
		request: MultiAgentStartRequest,
		stream: RunStream,
	): Promise<void> {
		const refusal = this.refusal(request);
		if (refusal) {
			refuse(stream, refusal.code, refusal.message);
			return;
		}
		if (
			!(await isFeatureEnabled(
				"COPILOTKIT_MULTI_AGENT_CHAT",
				this.caller.organizationId,
			))
		) {
			refuse(
				stream,
				"FEATURE_DISABLED",
				"Multi-agent turns are not enabled for this organization.",
			);
			return;
		}
		const resolution = await resolveMultiAgentPicks(
			this.caller,
			request.multiAgent.agents.map((agent) => agent.agentId),
		);
		if (resolution.kind === "refused") {
			refuse(stream, "AGENT_NOT_AVAILABLE", resolution.message);
			return;
		}
		const requests = await this.turnRequests(
			session,
			request,
			resolution.agents,
		);
		if (requests instanceof Response) {
			await refuseWithResponse(stream, requests);
			return;
		}
		const temporalClient = await getTemporalClient();
		const [first] = requests;
		if (!first) {
			throw new Error("A multi-agent turn has agents");
		}
		const admission = await admitChatTurn({
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
			conversationId: request.threadId,
			clientRequestKey: request.runId,
			executionMode: first.executionMode,
			question: request.question,
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
				await this.attach(admission.turn, request.runId, stream);
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
		const admitted = await this.admitSiblings(
			admission.turn,
			resolution.agents,
			requests,
			request,
			temporalClient,
		);
		if (admitted instanceof Response) {
			await refuseWithResponse(stream, admitted);
			return;
		}
		const lead = admission.turn;
		const record: MultiAgentTurnRecord = {
			version: 1,
			final: false,
			agents: admitted.map(({ agent, member }) =>
				runningMultiAgent({
					index: member.index,
					agentId: agent.agentId,
					name: agent.name,
					...(agent.vendor ? { vendor: agent.vendor } : {}),
					memberKey: member.memberKey,
					executionId: member.turn.executionId ?? "",
					turnId: member.turn.id,
				}),
			),
		};
		// Named before any agent starts: a connect finds the agents by it.
		await saveMultiAgentTurn(
			this.caller,
			lead,
			record,
			request.displayImageUrls,
		);
		const prepared = await this.prepare(admitted, temporalClient);
		if (prepared instanceof Response) {
			await this.abandon(lead, record, admitted, prepared);
			await refuseWithResponse(stream, prepared);
			return;
		}
		const group: MultiAgentGroup = {
			lead,
			members: admitted.map(({ member }) => member),
			record,
		};
		const follow = new MultiAgentTurnFollow({
			caller: this.caller,
			group,
			runId: request.runId,
			stream,
			imageUrls: request.displayImageUrls,
		});
		// Before the starts: Redis keeps no history.
		await follow.subscribe();
		const started = await Promise.allSettled(
			admitted.map(({ member, request: turnRequest }, i) =>
				startTurnWorkflow({
					temporalClient,
					turn: member.turn,
					workflowInput: prepared[i].workflowInput,
					memo: {
						userId: this.caller.userId,
						organizationId: this.caller.organizationId,
						projectId: turnRequest.projectId ?? null,
						...(request.displayImageUrls?.length
							? { displayImageUrls: request.displayImageUrls }
							: {}),
					},
				}),
			),
		);
		const failure = started.find(
			(result): result is PromiseRejectedResult =>
				result.status === "rejected",
		);
		if (
			failure &&
			started.every((result) => result.status === "rejected")
		) {
			follow.close();
			refuseOrchestratorStart(failure.reason, request, stream);
			return;
		}
		await follow.follow({
			inputMessage: multiAgentQuestion(group),
			resumed: false,
			billing: new Map(
				admitted.map(({ member }, i) => [
					member.memberKey,
					prepared[i].billing,
				]),
			),
			announce: [],
		});
	}

	/** Why a multi-agent run is refused before anything is looked up. */
	private refusal(
		request: MultiAgentStartRequest,
	): { code: string; message: string } | null {
		const agentIds = request.multiAgent.agents.map(
			(agent) => agent.agentId,
		);
		if (
			!request.runId.startsWith(MULTI_AGENT_KEY_PREFIX) ||
			request.runId.length > MAX_TURN_KEY_LENGTH
		) {
			return {
				code: "INVALID_RUN_ID",
				message: `A multi-agent run id starts with "${MULTI_AGENT_KEY_PREFIX}" and has at most ${MAX_TURN_KEY_LENGTH} characters.`,
			};
		}
		if (agentIds.length > MAX_MULTI_AGENTS) {
			return {
				code: "MULTI_AGENT_LIMIT",
				message: `A message can go to at most ${MAX_MULTI_AGENTS} agents.`,
			};
		}
		if (
			agentIds.length < MIN_MULTI_AGENTS ||
			new Set(agentIds).size !== agentIds.length
		) {
			return {
				code: "INVALID_REQUEST",
				message: `A multi-agent message goes to ${MIN_MULTI_AGENTS} to ${MAX_MULTI_AGENTS} different agents.`,
			};
		}
		const { body } = request;
		if (
			body.executionMode === "weave" ||
			body.continueFromTurnId !== undefined
		) {
			return {
				code: "UNSUPPORTED_EXECUTION_MODE",
				message: "A multi-agent message is a new chat turn.",
			};
		}
		return null;
	}

	/** Each agent's turn request, with the stream route's checks, or the first refusal. */
	private async turnRequests(
		session: Session,
		request: MultiAgentStartRequest,
		agents: ResolvedMultiAgent[],
	): Promise<OrchestratorTurnRequest[] | Response> {
		const shared = sharedScopeSchema.safeParse(request.body);
		const scope = shared.success ? shared.data : {};
		// Nexus sent the organization's slug (the default-MCP card's links);
		// the server reads it rather than trusting the browser's.
		const organization = await db.organization.findUnique({
			where: { id: this.caller.organizationId },
			select: { slug: true },
		});
		const requests: OrchestratorTurnRequest[] = [];
		for (const [index, agent] of agents.entries()) {
			const overrides = multiAgentRequestOverrides(agent.profile, scope);
			const resolved = await resolveOrchestratorTurnRequest({
				session,
				body: {
					...request.body,
					...overrides,
					surface: "nexus",
					organizationSlug: organization?.slug ?? undefined,
					message: request.question,
					history: request.history,
					organizationId: this.caller.organizationId,
					conversationId: request.threadId,
					clientRequestKey: multiAgentMemberKey(request.runId, index),
					executionId: undefined,
				},
			});
			if (resolved instanceof Response) {
				return resolved;
			}
			requests.push(resolved);
		}
		return requests;
	}

	/** Admit the agents after the first: turns of no conversation, as Nexus's runs. */
	private async admitSiblings(
		lead: ConversationTurn,
		agents: ResolvedMultiAgent[],
		requests: OrchestratorTurnRequest[],
		request: MultiAgentStartRequest,
		temporalClient: Awaited<ReturnType<typeof getTemporalClient>>,
	): Promise<AdmittedAgent[] | Response> {
		const admitted: AdmittedAgent[] = [];
		for (const [index, agent] of agents.entries()) {
			const turnRequest = requests[index];
			if (!turnRequest) {
				throw new Error("Every agent has a turn request");
			}
			const memberKey = multiAgentMemberKey(request.runId, index);
			let turn = lead;
			if (index > 0) {
				const admission = await admitChatTurn({
					userId: this.caller.userId,
					organizationId: this.caller.organizationId,
					conversationId: null,
					clientRequestKey: memberKey,
					executionMode: turnRequest.executionMode,
					question: request.question,
					temporalClient,
				});
				if (admission.kind !== "created") {
					await Promise.all(
						admitted.map(({ member }) =>
							abandonOrchestratorStart(
								member.turn,
								"multi-agent admission refused",
							),
						),
					);
					return admission.kind === "refused"
						? admission.response
						: Response.json(
								{
									error: "Conflict",
									message:
										"Another request already started this message's agents.",
								},
								{ status: 409 },
							);
				}
				turn = admission.turn;
			}
			admitted.push({
				agent,
				request: turnRequest,
				member: {
					index,
					agentId: agent.agentId,
					name: agent.name,
					vendor: agent.vendor,
					memberKey,
					turn,
				},
			});
		}
		return admitted;
	}

	/** Bill and build every agent's start (each agent is billed as its own turn). */
	private async prepare(
		admitted: AdmittedAgent[],
		temporalClient: Awaited<ReturnType<typeof getTemporalClient>>,
	): Promise<PreparedOrchestratorStart[] | Response> {
		const prepared: PreparedOrchestratorStart[] = [];
		for (const { member, request } of admitted) {
			const start = await prepareOrchestratorStart(
				this.caller,
				member.turn,
				request,
				temporalClient,
			);
			if (start instanceof Response) {
				return start;
			}
			prepared.push(start);
		}
		return prepared;
	}

	/** End every agent of a turn that will not start, and save it as refused. */
	private async abandon(
		lead: ConversationTurn,
		record: MultiAgentTurnRecord,
		admitted: AdmittedAgent[],
		refusal: Response,
	): Promise<void> {
		const reason = `refused: ${refusal.status}`;
		await Promise.all(
			admitted.map(({ member }) =>
				abandonOrchestratorStart(member.turn, reason),
			),
		);
		await saveMultiAgentTurn(this.caller, lead, {
			...record,
			agents: record.agents.map((agent) => ({
				...agent,
				status: "error",
				error: "The message was refused before the agents started.",
			})),
		}).catch((error: unknown) => {
			console.error(
				"[Agent Runtime] Failed to save a refused multi-agent turn",
				error,
			);
		});
	}
}
