import type { Interrupt } from "@ag-ui/client";
import { CHATGPT_PLAN_MODEL_OVERRIDE_PREFIX } from "@repo/agent-types/chatgpt-plan-fetch";
import {
	PLAN_MODEL_AGENT_PREFIX,
	type SelectedAgent,
} from "../components/FabricChat/shared/agent-selection";
import { settleUnfinishedToolCalls } from "./direct-chat-turns";
import {
	type AgentResponse,
	type MultiAgentToolCall,
	mergeStreamedText,
	mergeToolCall,
	withTextBreak,
} from "./multi-agent-response";
import type {
	CompletedToolCall,
	MultiAgentSignal,
} from "./multi-agent-runtime-events";
import {
	type MultiAgentRecordAgent,
	type MultiAgentTurnRecord,
	multiAgentTurnRecordSchema,
} from "./multi-agent-runtime-protocol";
import { ORCHESTRATOR_INTERRUPT_REASON } from "./orchestrator-runtime-protocol";
import type { OrchestratorStreamEvent } from "./orchestrator-stream-protocol";

/**
 * What the Orchestrator chat shows of a multi-agent turn: each agent's
 * answer as Nexus showed it (`AgentResponse`, rendered by
 * `AgentResponseBlock`). Built from the run's signals while the turn runs
 * (`applyMultiAgentSignal`, with Nexus's tool-call and text merging) and
 * from the saved record after a reload (`multiAgentViewFromRecord`).
 */

/** The code of a turn or agent stopped by the AI usage limit. */
export const AI_USAGE_LIMIT_CODE = "AI_USAGE_LIMIT_EXCEEDED";

interface MultiAgentAgentView extends AgentResponse {
	index: number;
	memberKey: string;
	/** The approvals the agent waits on (ids scoped to the agent). */
	interrupts: Interrupt[];
	/** A tool ran since the last text: the next text run starts a paragraph. */
	textBreak?: boolean;
}

type MultiAgentTurnStatus = "running" | "waiting" | "ended" | "refused";

export interface MultiAgentTurnView {
	/** The turn's key (the run id that started it). */
	turnKey: string;
	question: string;
	/** The first agent's execution: the conversation's record of the turn. */
	executionId?: string;
	status: MultiAgentTurnStatus;
	agents: MultiAgentAgentView[];
	error?: string;
}

type AgentIdentity = Pick<
	MultiAgentAgentView,
	"index" | "memberKey" | "agentId" | "vendor"
> & { name: string };

/** An agent the turn started, before any of its events. */
function startedAgent(agent: AgentIdentity): MultiAgentAgentView {
	return {
		index: agent.index,
		memberKey: agent.memberKey,
		agentId: agent.agentId,
		agentName: agent.name,
		vendor: agent.vendor,
		content: "",
		toolCalls: [],
		isLoading: true,
		isError: false,
		status: "streaming",
		pendingApproval: null,
		interrupts: [],
	};
}

/** A turn just sent, before its first event. */
export function pendingMultiAgentTurn(
	turnKey: string,
	question: string,
	agents: Array<{ agentId: string; name: string; vendor?: string }>,
): MultiAgentTurnView {
	return {
		turnKey,
		question,
		status: "running",
		agents: agents.map((agent, index) =>
			startedAgent({
				...agent,
				index,
				memberKey: index === 0 ? turnKey : `${turnKey}_a${index}`,
			}),
		),
	};
}

function updateAgent(
	view: MultiAgentTurnView,
	memberKey: string,
	update: (agent: MultiAgentAgentView) => MultiAgentAgentView,
): MultiAgentTurnView {
	return {
		...view,
		agents: view.agents.map((agent) =>
			agent.memberKey === memberKey ? update(agent) : agent,
		),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether the person stopped this agent: nothing it sends after changes it. */
function isStopped(agent: MultiAgentAgentView): boolean {
	return agent.status === "cancelled";
}

function completedToolCall(
	tc: CompletedToolCall,
	fallbackId: string,
): MultiAgentToolCall {
	return {
		id: tc.id ?? fallbackId,
		name: tc.name,
		args: tc.args,
		result: tc.result,
		serverName: tc.serverName,
		status: tc.status === "error" ? "error" : "complete",
		mcpAppResourceUri: tc.mcpAppResourceUri,
		mcpAppConfigId: tc.mcpAppConfigId,
	};
}

/** Tool calls a step or the end reported, merged into the live ones. */
function mergeCompletedToolCalls(
	toolCalls: MultiAgentToolCall[],
	completed: CompletedToolCall[] | undefined,
): MultiAgentToolCall[] {
	let merged = toolCalls;
	for (const tc of completed ?? []) {
		if (tc.name) {
			merged = mergeToolCall(
				merged,
				completedToolCall(tc, `tool-${merged.length}-${tc.name}`),
			);
		}
	}
	return settleUnfinishedToolCalls(merged) ?? merged;
}

type ToolEvent = Extract<
	OrchestratorStreamEvent,
	{ type: "tool_start" | "tool_input" | "tool_result" }
>;

/** A live tool event as Nexus merges it; its name falls back to the call's. */
function applyToolEvent(
	agent: MultiAgentAgentView,
	event: ToolEvent,
): MultiAgentAgentView {
	const id = event.toolCallId ?? `tool-${agent.toolCalls.length}`;
	const known = agent.toolCalls.find((tc) => tc.id === id);
	const name = event.toolName ?? event.name ?? known?.name;
	if (!name) {
		return agent;
	}
	const status =
		event.type === "tool_result"
			? event.status === "error"
				? "error"
				: "complete"
			: (event.status ??
				(event.type === "tool_start" ? "running" : "pending"));
	return {
		...agent,
		textBreak: event.type === "tool_start" ? true : agent.textBreak,
		toolCalls: mergeToolCall(agent.toolCalls, {
			id,
			name,
			args: event.args,
			result: event.type === "tool_result" ? event.result : undefined,
			serverName: event.serverName ?? known?.serverName,
			status,
			mcpAppResourceUri: event.mcpAppResourceUri,
			mcpAppConfigId: event.mcpAppConfigId,
		}),
	};
}

/** One agent's stream-route event applied to its answer, as Nexus applies it. */
function applyAgentEvent(
	agent: MultiAgentAgentView,
	event: OrchestratorStreamEvent,
): MultiAgentAgentView {
	if (event.type === "started") {
		return {
			...agent,
			executionId: event.executionId ?? agent.executionId,
		};
	}
	if (event.type === "text_start") {
		return { ...agent, content: "", textBreak: false };
	}
	if (event.type === "text_delta") {
		return {
			...agent,
			content:
				agent.content +
				(agent.textBreak
					? withTextBreak(agent.content, event.content)
					: event.content),
			textBreak: false,
		};
	}
	if (
		event.type === "tool_start" ||
		event.type === "tool_input" ||
		event.type === "tool_result"
	) {
		return applyToolEvent(agent, event);
	}
	if (event.type === "step_complete") {
		return {
			...agent,
			toolCalls: event.toolCalls?.length
				? mergeCompletedToolCalls(agent.toolCalls, event.toolCalls)
				: agent.toolCalls,
		};
	}
	if (event.type === "approval_resolved") {
		return { ...agent, pendingApproval: null, interrupts: [] };
	}
	return agent;
}

/** The approval card's content for the first approval an agent waits on. */
function pendingApprovalOf(
	interrupts: Interrupt[],
): AgentResponse["pendingApproval"] {
	const approval = interrupts.find(
		(interrupt) =>
			interrupt.reason === ORCHESTRATOR_INTERRUPT_REASON.approval,
	);
	if (!approval) {
		return null;
	}
	const metadata: unknown = approval.metadata?.fabric;
	const fabric = isRecord(metadata) ? metadata : {};
	return {
		approvalId: approval.id,
		stepId: typeof fabric.stepId === "string" ? fabric.stepId : "",
		reason:
			approval.message ??
			(typeof fabric.reason === "string"
				? fabric.reason
				: "Approval required"),
	};
}

/** An agent's end, as Nexus ends a response on `completed` / `error`. */
function endAgent(
	agent: MultiAgentAgentView,
	end: Omit<Extract<MultiAgentSignal, { kind: "agent-ended" }>, "kind">,
): MultiAgentAgentView {
	const settled = {
		...agent,
		isLoading: false,
		pendingApproval: null,
		interrupts: [],
		textBreak: false,
	};
	if (end.code === AI_USAGE_LIMIT_CODE) {
		return { ...settled, status: "idle", isError: false };
	}
	const toolCalls = mergeCompletedToolCalls(agent.toolCalls, end.toolCalls);
	if (isStopped(agent) || end.status === "cancelled") {
		return {
			...settled,
			status: "cancelled",
			cancelledAt: agent.cancelledAt,
			content: mergeStreamedText(agent.content, end.answer),
			toolCalls,
		};
	}
	if (end.status === "error") {
		const message = end.error ?? "Unknown error";
		return {
			...settled,
			status: "error",
			isError: true,
			errorMessage: message,
			content: agent.content || `Error: ${message}`,
			toolCalls,
		};
	}
	return {
		...settled,
		status: "completed",
		isError: false,
		errorMessage: undefined,
		content: mergeStreamedText(agent.content, end.answer),
		toolCalls,
	};
}

/** The view after one signal of the turn's run. */
export function applyMultiAgentSignal(
	view: MultiAgentTurnView,
	signal: MultiAgentSignal,
): MultiAgentTurnView {
	switch (signal.kind) {
		case "execution":
			return { ...view, executionId: signal.executionId };
		case "agent-started":
			return view.agents.some(
				(agent) => agent.memberKey === signal.memberKey,
			)
				? updateAgent(view, signal.memberKey, (agent) => ({
						...agent,
						agentName: signal.name || agent.agentName,
						vendor: signal.vendor ?? agent.vendor,
					}))
				: {
						...view,
						agents: [...view.agents, startedAgent(signal)].sort(
							(a, b) => a.index - b.index,
						),
					};
		case "agent-event":
			return updateAgent(view, signal.memberKey, (agent) =>
				isStopped(agent) ? agent : applyAgentEvent(agent, signal.event),
			);
		case "agent-ended":
			return updateAgent(view, signal.memberKey, (agent) =>
				endAgent(agent, signal),
			);
		case "agent-waiting":
			return updateAgent(view, signal.memberKey, (agent) =>
				isStopped(agent)
					? agent
					: {
							...agent,
							interrupts: signal.interrupts,
							pendingApproval: pendingApprovalOf(
								signal.interrupts,
							),
						},
			);
		case "agent-resolved":
			return updateAgent(view, signal.memberKey, (agent) => ({
				...agent,
				pendingApproval: null,
				interrupts: [],
			}));
		case "ended":
			return signal.record
				? {
						...view,
						status: "ended",
						agents: signal.record.agents.map((recorded) => {
							const live = view.agents.find(
								(agent) =>
									agent.memberKey === recorded.memberKey,
							);
							return live
								? endAgent(live, recordedEnd(recorded))
								: recordedAgent(recorded);
						}),
					}
				: { ...view, status: "ended" };
		case "interrupted":
			return { ...view, status: "waiting" };
		case "refused":
			return { ...view, status: "refused", error: signal.message };
		case "run-started":
		case "reconnect":
		case "stale":
			return view;
		default: {
			const unhandled: never = signal;
			throw new Error(`Unhandled signal: ${JSON.stringify(unhandled)}`);
		}
	}
}

/** The tool calls an agent's saved execution record kept. */
function recordedToolCalls(agent: MultiAgentRecordAgent): CompletedToolCall[] {
	const steps = agent.record?.stepResults;
	if (!Array.isArray(steps)) {
		return [];
	}
	return steps.flatMap((step: unknown) =>
		isRecord(step) && Array.isArray(step.toolCalls)
			? step.toolCalls.filter(
					(tc: unknown): tc is CompletedToolCall =>
						isRecord(tc) && typeof tc.name === "string",
				)
			: [],
	);
}

/** A saved agent's end, as the live end applies it. */
function recordedEnd(
	agent: MultiAgentRecordAgent,
): Omit<Extract<MultiAgentSignal, { kind: "agent-ended" }>, "kind"> {
	return {
		memberKey: agent.memberKey,
		status: agent.status === "running" ? "error" : agent.status,
		answer: agent.answer,
		error: agent.error,
		toolCalls: recordedToolCalls(agent),
	};
}

/** A saved agent's answer, from its record alone. */
function recordedAgent(agent: MultiAgentRecordAgent): MultiAgentAgentView {
	const started = {
		...startedAgent(agent),
		executionId: agent.executionId,
		cancelledAt: agent.cancelledAt,
	};
	return agent.status === "running"
		? started
		: endAgent(started, recordedEnd(agent));
}

/** A saved record's view (after a reload). */
export function multiAgentViewFromRecord(
	record: MultiAgentTurnRecord,
	question: string,
	turnKey = record.agents[0]?.memberKey ?? "",
): MultiAgentTurnView {
	return {
		turnKey,
		question,
		executionId: record.agents[0]?.executionId,
		status: record.final ? "ended" : "running",
		agents: record.agents.map(recordedAgent),
	};
}

/**
 * The person stopped the turn: every agent still answering is marked
 * stopped now, as Nexus marks it, whatever it sends after.
 */
export function stopMultiAgentTurn(
	view: MultiAgentTurnView,
	cancelledAt: string,
): MultiAgentTurnView {
	return {
		...view,
		agents: view.agents.map((agent) =>
			agent.isLoading
				? {
						...agent,
						isLoading: false,
						status: "cancelled",
						cancelledAt,
						pendingApproval: null,
						interrupts: [],
					}
				: agent,
		),
	};
}

const MODEL_AGENT_PREFIX = "model:";

/**
 * The agents a saved turn went to, as the picker's picks: a model carries
 * its model (a ChatGPT plan model stays in this chat only); an agent is
 * resolved from its id when the next turn starts.
 */
export function multiAgentPicks(record: MultiAgentTurnRecord): SelectedAgent[] {
	return record.agents.map((agent) => {
		const pick = {
			agentId: agent.agentId,
			name: agent.name,
			vendor: agent.vendor,
		};
		if (agent.agentId.startsWith(MODEL_AGENT_PREFIX)) {
			return {
				...pick,
				modelOverride: agent.agentId.slice(MODEL_AGENT_PREFIX.length),
			};
		}
		if (agent.agentId.startsWith(PLAN_MODEL_AGENT_PREFIX)) {
			return {
				...pick,
				modelOverride: `${CHATGPT_PLAN_MODEL_OVERRIDE_PREFIX}${agent.agentId.slice(PLAN_MODEL_AGENT_PREFIX.length)}`,
				chatOnly: true,
			};
		}
		return pick;
	});
}

/** A saved execution's `multiAgent`, when it is a multi-agent turn's. */
function parseMultiAgentRecord(
	value: unknown,
): MultiAgentTurnRecord | undefined {
	const parsed = multiAgentTurnRecordSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/**
 * A multi-agent turn's answers as one assistant message of the next turn's
 * history, each labelled with its agent (Nexus's labelled history).
 */
function multiAgentHistoryAnswer(record: MultiAgentTurnRecord): string {
	return record.agents
		.filter((agent) => agent.answer)
		.map((agent) => `[${agent.name}]\n${agent.answer}`)
		.join("\n\n");
}

/**
 * A saved execution's multi-agent fields for the chat's completed turn: its
 * record, and its labelled answers as the turn's response (the chat builds
 * the next turn's history from responses).
 */
export function multiAgentExecutionFields(execution: {
	multiAgent?: unknown;
}): { multiAgent?: MultiAgentTurnRecord; response?: string } {
	const record = parseMultiAgentRecord(execution.multiAgent);
	return record
		? { multiAgent: record, response: multiAgentHistoryAnswer(record) }
		: {};
}

/** Whether every agent of the turn has ended. */
export function isMultiAgentTurnOver(view: MultiAgentTurnView): boolean {
	return view.status === "ended" || view.status === "refused";
}
