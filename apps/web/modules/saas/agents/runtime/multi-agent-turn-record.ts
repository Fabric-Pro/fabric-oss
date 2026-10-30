import {
	type ConversationMessage,
	type ConversationTurn,
	getAgentConversationById,
	saveConversationTurn,
} from "@repo/database";
import {
	MULTI_AGENT_EXECUTION_MODE,
	type MultiAgentRecordAgent,
	type MultiAgentTurnRecord,
	multiAgentTurnRecordSchema,
} from "@saas/agents/lib/multi-agent-runtime-protocol";
import { orchestratorTurnMessageIds } from "@saas/agents/lib/orchestrator-runtime-protocol";
import type { RuntimeCaller } from "./engine";

/**
 * What a multi-agent turn saves into its conversation: one execution record
 * under the first agent's execution (the conversation's turn), whose
 * `multiAgent` holds every agent's status, answer and own Orchestrator
 * record. Saved at admission (every agent running), again as each agent
 * ends, and finally with every agent's answer once all have ended. Never
 * saved under another agent's execution: that would claim its
 * conversation-less turn into the conversation.
 */

type Caller = Pick<RuntimeCaller, "userId" | "organizationId">;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The turn's saved multi-agent record, or null before its admission save. */
export async function readMultiAgentRecord(
	caller: Caller,
	lead: ConversationTurn,
): Promise<MultiAgentTurnRecord | null> {
	if (!lead.conversationId || !lead.executionId) {
		return null;
	}
	const conversation = await getAgentConversationById({
		id: lead.conversationId,
		userId: caller.userId,
		organizationId: caller.organizationId,
	});
	const metadata = isRecord(conversation?.metadata)
		? conversation.metadata
		: {};
	const executions = Array.isArray(metadata.executions)
		? metadata.executions
		: [];
	const execution = executions.find(
		(candidate: unknown) =>
			isRecord(candidate) && candidate.id === lead.executionId,
	);
	const parsed = multiAgentTurnRecordSchema.safeParse(
		isRecord(execution) ? execution.multiAgent : undefined,
	);
	return parsed.success ? parsed.data : null;
}

/**
 * One record from what is saved and what this response knows: an agent's
 * end is never undone by a response that saw it running, and the first
 * saved end of an agent stands.
 */
function mergeMultiAgentRecords(
	saved: MultiAgentTurnRecord | null,
	next: MultiAgentTurnRecord,
): MultiAgentTurnRecord {
	const agents = next.agents.map((agent) => {
		const previous = saved?.agents.find(
			(candidate) => candidate.index === agent.index,
		);
		return previous && previous.status !== "running" ? previous : agent;
	});
	return {
		version: 1,
		final: agents.every((agent) => agent.status !== "running"),
		agents,
	};
}

function groupStatus(
	record: MultiAgentTurnRecord,
): "running" | "complete" | "error" | "cancelled" {
	if (!record.final) {
		return "running";
	}
	if (record.agents.some((agent) => agent.status === "complete")) {
		return "complete";
	}
	return record.agents.every((agent) => agent.status === "cancelled")
		? "cancelled"
		: "error";
}

/** Each agent's answer, in agent order, once every agent has ended. */
function answerMessages(record: MultiAgentTurnRecord): ConversationMessage[] {
	if (!record.final) {
		return [];
	}
	const timestamp = new Date().toISOString();
	return record.agents.map((agent) => ({
		id: orchestratorTurnMessageIds(agent.memberKey).assistant,
		role: "assistant",
		content: agent.answer ?? agent.error ?? "",
		timestamp,
		metadata: {
			agentId: agent.agentId,
			agentName: agent.name,
			...(agent.vendor ? { vendor: agent.vendor } : {}),
		},
	}));
}

/**
 * Save the turn's record (merged with what is saved) and return it. The
 * question is saved from the start, the answers with the final record.
 */
export async function saveMultiAgentTurn(
	caller: Caller,
	lead: ConversationTurn,
	next: MultiAgentTurnRecord,
	imageUrls?: string[],
): Promise<MultiAgentTurnRecord> {
	const conversationId = lead.conversationId;
	const executionId = lead.executionId;
	if (!conversationId || !executionId) {
		throw new Error("A multi-agent turn's first agent has a conversation");
	}
	const record = mergeMultiAgentRecords(
		await readMultiAgentRecord(caller, lead),
		next,
	);
	const status = groupStatus(record);
	const ids = orchestratorTurnMessageIds(lead.clientRequestKey);
	await saveConversationTurn({
		id: conversationId,
		userId: lead.userId,
		organizationId: lead.organizationId,
		messages: [
			{
				id: ids.user,
				role: "user",
				content: lead.questionText ?? "",
				timestamp: lead.createdAt.toISOString(),
			},
			...answerMessages(record),
		],
		execution: {
			id: executionId,
			workflowId: executionId,
			mode: MULTI_AGENT_EXECUTION_MODE,
			userMessage: lead.questionText ?? "",
			imageUrls,
			stepResults: [],
			approvalHistory: [],
			variables: {},
			status,
			startedAt: lead.createdAt.toISOString(),
			...(record.final
				? { completedAt: new Date().toISOString() }
				: { inProgress: true }),
			finalResponse: "",
			questionMessageId: ids.user,
			multiAgent: record,
		},
	});
	return record;
}

/** A running agent's entry, as the admission save lists it. */
export function runningMultiAgent(
	agent: Omit<
		MultiAgentRecordAgent,
		"status" | "answer" | "error" | "cancelledAt" | "record"
	>,
): MultiAgentRecordAgent {
	return { ...agent, status: "running" };
}
