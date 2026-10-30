import type { ConversationTurn } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import {
	isMultiAgentTurnKey,
	type MultiAgentTurnRecord,
	multiAgentMemberKey,
} from "@saas/agents/lib/multi-agent-runtime-protocol";
import { isTerminalTurnStatus } from "@saas/agents/lib/server/conversation-turn-admission";
import { multiAgentRows } from "@saas/agents/lib/server/multi-agent-admission";
import { reconcileTurnWithWorkflow } from "../../../../app/api/agents/fabric-ai/orchestrator-temporal/turn-admission";
import type { RuntimeCaller } from "./engine";
import { readMultiAgentRecord } from "./multi-agent-turn-record";

/**
 * A multi-agent turn as the engine finds it: the conversation's turn (the
 * first agent's) and the turn rows of the agents after it, which belong to
 * no conversation and are found by their keys. The turn stays live, for
 * admission, until every agent's row has ended.
 */

type Caller = Pick<RuntimeCaller, "userId" | "organizationId">;

/** One agent of a multi-agent turn. */
export interface MultiAgentMember {
	index: number;
	agentId: string;
	name: string;
	vendor?: string;
	memberKey: string;
	turn: ConversationTurn;
}

export interface MultiAgentGroup {
	/** The conversation's turn: the first agent's. */
	lead: ConversationTurn;
	members: MultiAgentMember[];
	/** What is saved of it (every agent running until each one ends). */
	record: MultiAgentTurnRecord;
}

/** Whether a conversation turn is a multi-agent turn's first agent. */
export function isMultiAgentLead(turn: ConversationTurn): boolean {
	return isMultiAgentTurnKey(turn.clientRequestKey);
}

/**
 * Whether any agent's turn still runs, checked against Temporal as a single
 * turn is: a row whose workflow ended is settled by the shared reconcile.
 */
export async function multiAgentLiveness(
	rows: ConversationTurn[],
): Promise<"running" | "ended" | "unavailable"> {
	const open = rows.filter((turn) => !isTerminalTurnStatus(turn.status));
	if (open.length === 0) {
		return "ended";
	}
	const temporalClient = await getTemporalClient();
	const settled = await Promise.all(
		open.map((turn) => reconcileTurnWithWorkflow({ turn, temporalClient })),
	);
	if (settled.includes("running")) {
		return "running";
	}
	return settled.includes("unavailable") ? "unavailable" : "ended";
}

/**
 * The turn with its agents, or null before its admission save named them
 * (the run that admits it is still starting it).
 */
export async function loadMultiAgentGroup(
	caller: Caller,
	lead: ConversationTurn,
): Promise<MultiAgentGroup | null> {
	const [record, rows] = await Promise.all([
		readMultiAgentRecord(caller, lead),
		multiAgentRows(caller, lead),
	]);
	if (!record) {
		return null;
	}
	const byKey = new Map(rows.map((turn) => [turn.clientRequestKey, turn]));
	const members = record.agents.flatMap((agent): MultiAgentMember[] => {
		const memberKey = multiAgentMemberKey(
			lead.clientRequestKey,
			agent.index,
		);
		const turn = byKey.get(memberKey);
		return turn
			? [
					{
						index: agent.index,
						agentId: agent.agentId,
						name: agent.name,
						vendor: agent.vendor,
						memberKey,
						turn,
					},
				]
			: [];
	});
	return { lead, members, record };
}
