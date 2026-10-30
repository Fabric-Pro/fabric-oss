import {
	type ConversationTurn,
	getConversationTurnsByClientKeys,
	getLatestConversationTurn,
} from "@repo/database";
import { classifyTemporalClientError } from "@repo/temporal/temporal-client-errors";
import {
	isMultiAgentTurnKey,
	multiAgentSiblingKeys,
} from "../multi-agent-runtime-protocol";

/**
 * A multi-agent turn's agents, as admission sees them. The conversation's
 * turn is the first agent's; the others' rows belong to no conversation and
 * are found by their keys. While any of them runs, the conversation's turn
 * is still live, whichever engine (stream route, Direct, agent runtime) is
 * asked to admit the next message.
 */

/** A START_PENDING agent whose workflow Temporal does not know yet is still starting. */
const START_GRACE_MS = 60_000;

type Scope = { userId: string; organizationId: string };

type DescribeClient = {
	workflow: {
		getHandle: (id: string) => { describe: () => Promise<unknown> };
	};
};

/** Every agent's turn row of the multi-agent turn whose first agent is `lead`. */
export async function multiAgentRows(
	scope: Scope,
	lead: ConversationTurn,
): Promise<ConversationTurn[]> {
	const keys = multiAgentSiblingKeys(lead.clientRequestKey);
	const siblings = await getConversationTurnsByClientKeys({
		clientRequestKeys: keys,
		userId: scope.userId,
		organizationId: scope.organizationId,
	});
	const byKey = new Map(
		siblings.map((turn) => [turn.clientRequestKey, turn]),
	);
	return [
		lead,
		...keys.flatMap((key) => {
			const turn = byKey.get(key);
			return turn ? [turn] : [];
		}),
	];
}

function isOpen(turn: ConversationTurn): boolean {
	return (
		turn.status !== "COMPLETED" &&
		turn.status !== "FAILED" &&
		turn.status !== "LIMITED" &&
		turn.status !== "CANCELLED"
	);
}

/**
 * Whether an agent's workflow runs, from Temporal's description alone. It
 * settles nothing: an agent's row is an Orchestrator turn, settled only by
 * the Orchestrator's own reconcile.
 */
async function agentRuns(
	turn: ConversationTurn,
	temporalClient: DescribeClient,
	now: number,
): Promise<"running" | "ended" | "unavailable"> {
	if (!turn.executionId) {
		return "ended";
	}
	try {
		const description = await temporalClient.workflow
			.getHandle(turn.executionId)
			.describe();
		const status =
			typeof description === "object" &&
			description !== null &&
			"status" in description &&
			typeof description.status === "object" &&
			description.status !== null &&
			"name" in description.status
				? description.status.name
				: undefined;
		return status === "RUNNING" || status === "CONTINUED_AS_NEW"
			? "running"
			: "ended";
	} catch (error) {
		if (classifyTemporalClientError(error) !== "not_found") {
			return "unavailable";
		}
		return turn.status === "START_PENDING" &&
			now - turn.createdAt.getTime() < START_GRACE_MS
			? "running"
			: "ended";
	}
}

/**
 * The agent of the conversation's latest multi-agent turn that still runs
 * after the conversation's own turn (the first agent's) has ended: null when
 * none does (or the latest turn is not a multi-agent one), "unavailable"
 * when Temporal could not say.
 */
export async function runningMultiAgentSibling(args: {
	userId: string;
	organizationId: string;
	conversationId: string;
	/** The key being admitted: the multi-agent turn's own retry is not refused here. */
	clientRequestKey: string;
	temporalClient: DescribeClient;
	now?: number;
}): Promise<ConversationTurn | null | "unavailable"> {
	const lead = await getLatestConversationTurn({
		conversationId: args.conversationId,
		userId: args.userId,
		organizationId: args.organizationId,
	});
	if (
		!lead ||
		!isMultiAgentTurnKey(lead.clientRequestKey) ||
		lead.clientRequestKey === args.clientRequestKey ||
		isOpen(lead)
	) {
		// An open first agent is the conversation's live turn already.
		return null;
	}
	const open = (await multiAgentRows(args, lead)).slice(1).filter(isOpen);
	const now = args.now ?? Date.now();
	let unavailable = false;
	for (const turn of open) {
		const runs = await agentRuns(turn, args.temporalClient, now);
		if (runs === "running") {
			return turn;
		}
		unavailable ||= runs === "unavailable";
	}
	return unavailable ? "unavailable" : null;
}
