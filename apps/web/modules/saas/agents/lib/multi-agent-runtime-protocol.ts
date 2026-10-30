import { z } from "zod";

/**
 * A multi-agent turn of the Orchestrator chat over the agent runtime: one
 * message answered by two to four picked agents or models side by side, as
 * Nexus did. What the server engine (`modules/saas/agents/runtime/multi-agent-*.ts`)
 * and the browser (`useMultiAgentRuntimeTurn`) agree on.
 *
 * - The run id is the turn's key and starts with `ma_`. Each picked agent
 *   runs its own `orchestratorExecutionWorkflow` under its own turn row, keyed
 *   `multiAgentMemberKey(key, index)`: agent 0's row is the conversation's
 *   turn, the others belong to no conversation (as Nexus's runs did).
 * - Each agent is an AG-UI subagent whose `subagentRunId` is its member key:
 *   `SUBAGENT_STARTED`, the Orchestrator events of one turn
 *   (`orchestrator-runtime-protocol.ts`) carrying that `subagentRunId`, with
 *   tool-call ids prefixed `<memberKey>:` and state paths under
 *   `/agents/<index>`, then `SUBAGENT_FINISHED` (`result` = the stream route's
 *   `completed` payload; outcome `suspended` while it waits on an answer) or
 *   `SUBAGENT_ERROR` (`metadata.fabric` = the stream route's `error` event).
 * - An agent's approval or question arrives as CUSTOM
 *   `fabric.multi-agent.interrupt` while the others go on; the run ends as an
 *   interrupt only when every agent left is waiting.
 * - The run ends (RUN_FINISHED success) once every agent has ended and the
 *   turn is saved.
 */

export const MULTI_AGENT_KEY_PREFIX = "ma_";
export const MIN_MULTI_AGENTS = 2;
export const MAX_MULTI_AGENTS = 4;

/** Whether a turn key is a multi-agent turn's (an index hint; never authority). */
export function isMultiAgentTurnKey(key: string): boolean {
	return key.startsWith(MULTI_AGENT_KEY_PREFIX);
}

/** Agent `index`'s turn key: the turn's own key for agent 0. */
export function multiAgentMemberKey(turnKey: string, index: number): string {
	return index === 0 ? turnKey : `${turnKey}_a${index}`;
}

/** The member keys of every agent after the first, in agent order. */
export function multiAgentSiblingKeys(turnKey: string): string[] {
	return Array.from({ length: MAX_MULTI_AGENTS - 1 }, (_, i) =>
		multiAgentMemberKey(turnKey, i + 1),
	);
}

/** The `CUSTOM` event names a multi-agent run adds. */
export const MULTI_AGENT_RUN_EVENT = {
	/** An agent's approval or question; the others go on. */
	interrupt: "fabric.multi-agent.interrupt",
	/** A resume's answer reached the agent (`value.event` is the single-turn event). */
	resolved: "fabric.multi-agent.interrupt-resolved",
} as const;

/** The parts of a multi-agent interrupt id: the agent's member key and its own id. */
export function splitMultiAgentInterruptId(
	interruptId: string,
	memberKeys: readonly string[],
): { memberKey: string; interruptId: string } | null {
	const memberKey = memberKeys.find((key) =>
		interruptId.startsWith(`${key}:`),
	);
	return memberKey
		? { memberKey, interruptId: interruptId.slice(memberKey.length + 1) }
		: null;
}

/** Agent `index`'s copy of an Orchestrator state path (`/phase` → `/agents/1/phase`). */
export function multiAgentStatePath(index: number, path: string): string {
	return `/agents/${index}${path}`;
}

/** An agent's tool-call id on the wire: unique across the turn's agents. */
export function multiAgentToolCallId(memberKey: string, toolCallId: string) {
	return `${memberKey}:${toolCallId}`;
}

/**
 * The run's `forwardedProps.multiAgent`: only the picked agents' ids. The
 * server resolves each one's instructions and tool scope itself.
 */
export const multiAgentRunRequestSchema = z.object({
	// Bounded well above the limit, so the limit's own refusal says why.
	agents: z
		.array(z.object({ agentId: z.string().min(1).max(200) }))
		.max(MAX_MULTI_AGENTS * 4),
});
export type MultiAgentRunRequest = z.infer<typeof multiAgentRunRequestSchema>;

const multiAgentStatusSchema = z.enum([
	"running",
	"complete",
	"error",
	"cancelled",
]);
type MultiAgentStatus = z.infer<typeof multiAgentStatusSchema>;

/** One agent of a saved multi-agent turn. */
export const multiAgentRecordAgentSchema = z.object({
	index: z.number().int().min(0),
	agentId: z.string(),
	name: z.string(),
	vendor: z.string().optional(),
	memberKey: z.string(),
	executionId: z.string(),
	turnId: z.string(),
	status: multiAgentStatusSchema,
	/** The answer (empty while it runs). */
	answer: z.string().optional(),
	error: z.string().optional(),
	cancelledAt: z.string().optional(),
	/** The Orchestrator execution record the single-agent chat saves (steps, tool calls, model). */
	record: z.record(z.string(), z.unknown()).optional(),
});
export type MultiAgentRecordAgent = z.infer<typeof multiAgentRecordAgentSchema>;

/**
 * `execution.multiAgent` of a multi-agent turn's saved record. `final` is
 * false from the turn's admission until every agent has ended and the turn
 * is saved again.
 */
export const multiAgentTurnRecordSchema = z.object({
	version: z.literal(1),
	final: z.boolean(),
	agents: z.array(multiAgentRecordAgentSchema),
});
export type MultiAgentTurnRecord = z.infer<typeof multiAgentTurnRecordSchema>;

/** The `mode` of a multi-agent turn's execution record. */
export const MULTI_AGENT_EXECUTION_MODE = "multi-agent";
