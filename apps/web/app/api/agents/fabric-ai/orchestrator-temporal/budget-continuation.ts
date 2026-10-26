import { getConversationTurnContinuationSnapshot } from "@repo/database";
import { parseTurnBudgetStop } from "@saas/agents/lib/turn-budget-stop";
import { stoppedTurnContextMessage } from "../carried-over-context";

export class InvalidBudgetContinuationError extends Error {
	readonly code = "INVALID_BUDGET_CONTINUATION";
	readonly status = 409;
	constructor() {
		super(
			"Continue is available for your latest finished answer that reached a limit.",
		);
	}
	response() {
		return Response.json(
			{ code: this.code, error: this.message },
			{ status: this.status },
		);
	}
}

/** Checks the server rows; after admission the successor must directly follow the source. */
export async function budgetContinuationSeed(args: {
	turnId: string;
	conversationId: string;
	userId: string;
	organizationId: string;
	successorTurnId?: string;
	clientRequestKey?: string;
}) {
	const { source, latest } =
		await getConversationTurnContinuationSnapshot(args);
	if (
		!source ||
		!latest ||
		source.id !== args.turnId ||
		source.userId !== args.userId ||
		source.organizationId !== args.organizationId ||
		source.conversationId !== args.conversationId ||
		latest.userId !== args.userId ||
		latest.organizationId !== args.organizationId ||
		latest.conversationId !== args.conversationId ||
		!["COMPLETED", "LIMITED", "FAILED", "CANCELLED"].includes(
			source.status,
		) ||
		!parseTurnBudgetStop(source.budgetStop) ||
		(args.successorTurnId
			? latest.id !== args.successorTurnId ||
				source.generation === null ||
				latest.generation !== source.generation + 1
			: latest.id !== source.id &&
				!(
					args.clientRequestKey &&
					latest.clientRequestKey === args.clientRequestKey &&
					source.generation !== null &&
					latest.generation === source.generation + 1
				))
	) {
		throw new InvalidBudgetContinuationError();
	}
	return stoppedTurnContextMessage(source);
}
