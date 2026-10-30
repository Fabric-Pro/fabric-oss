import {
	type ConversationMessage,
	type ConversationTurn,
	getAgentConversationById,
	saveConversationTurn,
} from "@repo/database";
import {
	type ClarificationTurn,
	clarificationOf,
	formatClarificationTurn,
} from "@repo/utils/clarification-turns";
import { AGENT_DISPLAY_INFO } from "@saas/agents/components/FabricChat/orchestrator/types";
import { parseTurnTruncation } from "@saas/agents/lib/chat-turn-truncation";
import {
	orchestratorClarificationIdPrefix,
	orchestratorTurnMessageIds,
} from "@saas/agents/lib/orchestrator-runtime-protocol";
import { safeToolField } from "@saas/agents/lib/orchestrator-stream-types";
import type { ApiBillingNotice } from "./direct-turn-record";
import type {
	OrchestratorStepComplete,
	OrchestratorTerminal,
	OrchestratorTurnFacts,
} from "./orchestrator-translator";

/**
 * What the Orchestrator engine saves into a conversation: the same messages
 * and execution record the Orchestrator chat's own save writes
 * (`FabricTemporalOrchestratorChat`'s `persistConversation`), under ids
 * derived from the turn's key so a second save (another response, a
 * retry) fills the same slots.
 */

/** The answer as the chat saves it: the message plus its stream lifecycle. */
type OrchestratorAnswerMessage = ConversationMessage & {
	streamStatus: "completed" | "error" | "cancelled";
	cancelledAt?: string;
};

type StepToolCall = NonNullable<OrchestratorStepComplete["toolCalls"]>[number];

/** The usage-limit refusal the chat shows as a toast and never saves. */
const USAGE_LIMIT_CODE = "AI_USAGE_LIMIT_EXCEEDED";

/** The turn the record belongs to, and what only its start knew. */
export interface OrchestratorTurnContext {
	turn: ConversationTurn;
	/** The thumbnails the question was sent with (the start's memo). */
	imageUrls: string[] | undefined;
	billing: ApiBillingNotice | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function question(turn: ConversationTurn): ConversationMessage {
	return {
		id: orchestratorTurnMessageIds(turn.clientRequestKey).user,
		role: "user",
		content: turn.questionText ?? "",
		timestamp: turn.createdAt.toISOString(),
	};
}

function clarificationMessage(
	turn: ConversationTurn,
	clarificationId: string,
	clarification: ClarificationTurn,
): ConversationMessage {
	return {
		id: orchestratorTurnMessageIds(turn.clientRequestKey).clarification(
			clarificationId,
		),
		role: "user",
		content: formatClarificationTurn(clarification),
		metadata: { clarification },
		timestamp: turn.createdAt.toISOString(),
	};
}

/** The clarifications this turn saved as they were answered, oldest first. */
async function savedClarifications(
	turn: ConversationTurn,
	conversationId: string,
): Promise<ConversationMessage[]> {
	const conversation = await getAgentConversationById({
		id: conversationId,
		userId: turn.userId,
		organizationId: turn.organizationId,
	});
	const messages: unknown[] = Array.isArray(conversation?.messages)
		? conversation.messages
		: [];
	const prefix = orchestratorClarificationIdPrefix(turn.clientRequestKey);
	return messages.flatMap((message) => {
		if (
			!isRecord(message) ||
			typeof message.id !== "string" ||
			!message.id.startsWith(prefix) ||
			!isRecord(message.metadata)
		) {
			return [];
		}
		const clarification = clarificationOf({
			role: typeof message.role === "string" ? message.role : undefined,
			metadata: message.metadata,
		});
		return clarification
			? [
					clarificationMessage(
						turn,
						message.id.slice(prefix.length),
						clarification,
					),
				]
			: [];
	});
}

/** A step's tool calls as the chat stores them (no truncation sentinels). */
function storedToolCalls(
	stepId: string,
	toolCalls: StepToolCall[] | undefined,
) {
	return (toolCalls ?? []).map((toolCall, index) => ({
		id: toolCall.id || `tc-${stepId}-${index}`,
		name: toolCall.name,
		args: safeToolField(toolCall.args),
		result: safeToolField(toolCall.result) ?? null,
		status: toolCall.status || "success",
		durationMs: toolCall.durationMs ?? 0,
		mcpAppResourceUri: toolCall.mcpAppResourceUri,
		mcpAppConfigId: toolCall.mcpAppConfigId,
	}));
}

function storedStep(step: Omit<OrchestratorStepComplete, "type">) {
	return {
		stepId: step.stepId,
		stepDescription: step.stepDescription,
		status: step.status || "complete",
		response: step.response,
		toolCalls: storedToolCalls(step.stepId, step.toolCalls),
		durationMs: step.durationMs ?? 0,
	};
}

/**
 * The steps as the chat had them: every completed step it was sent, else
 * the result's steps, else one step holding the result's tool calls.
 */
function storedSteps(
	terminal: OrchestratorTerminal,
	facts: OrchestratorTurnFacts,
) {
	const streamed = [...facts.steps.values()];
	if (
		streamed.some(
			(step) => (step.toolCalls?.length ?? 0) > 0 || step.response,
		)
	) {
		return streamed.map(storedStep);
	}
	if (terminal.type !== "completed") {
		return streamed.map(storedStep);
	}
	if (terminal.stepResults && terminal.stepResults.length > 0) {
		return terminal.stepResults.map(storedStep);
	}
	if (terminal.toolCalls && terminal.toolCalls.length > 0) {
		return [
			{
				stepId: "execution",
				stepDescription: "Task execution",
				status: "complete",
				response: terminal.response,
				toolCalls: storedToolCalls("final", terminal.toolCalls),
				durationMs: terminal.totalDurationMs || 0,
			},
		];
	}
	return streamed.map(storedStep);
}

function apiBillingOf(value: unknown): ApiBillingNotice | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const { resetAt, personalKeyProvider } = value;
	return {
		resetAt:
			typeof resetAt === "string" && !Number.isNaN(Date.parse(resetAt))
				? resetAt
				: null,
		...(typeof personalKeyProvider === "string" && personalKeyProvider
			? { personalKeyProvider }
			: {}),
	};
}

const REJECTION_WORDS = ["rejected", "declined"];

/**
 * The answer the chat saves for a turn that ended this way: the result's
 * response, else the chat's fallback wording for a stop, a rejection, a
 * failure or an empty success.
 */
function finalResponse(
	terminal: OrchestratorTerminal,
	facts: OrchestratorTurnFacts,
	steps: Array<{ status: string }>,
): string {
	const cancelled =
		terminal.type === "completed" && terminal.status === "cancelled";
	const response =
		terminal.type === "completed" ? terminal.response : undefined;
	const answered = response || (cancelled ? facts.answerText : undefined);
	if (answered) {
		return answered;
	}
	if (cancelled) {
		return "Workflow was cancelled by user.";
	}
	const error = errorOf(terminal);
	if (
		error &&
		REJECTION_WORDS.some((word) => error.toLowerCase().includes(word))
	) {
		const completed = steps.filter(
			(step) => step.status === "complete",
		).length;
		return completed > 0
			? `Workflow stopped. Completed ${completed} step(s) before stopping.`
			: "Workflow stopped before any steps were completed.";
	}
	if (terminal.type === "error") {
		return facts.answerText || `Error: ${error}`;
	}
	return "Execution completed.";
}

/** The failure the chat shows for an `error` (its `error`, else its `message`). */
function errorOf(terminal: OrchestratorTerminal): string | undefined {
	return terminal.type === "error"
		? terminal.error || terminal.message || "Unknown error"
		: undefined;
}

function executionStatus(
	terminal: OrchestratorTerminal,
): "complete" | "error" | "cancelled" {
	if (terminal.type === "error") {
		return "error";
	}
	return terminal.status === "cancelled" ? "cancelled" : "complete";
}

function routingDecision(facts: OrchestratorTurnFacts) {
	const routing = facts.routing;
	return routing
		? {
				primaryAgent: routing.primaryAgent,
				agentName:
					AGENT_DISPLAY_INFO[routing.primaryAgent]?.name ||
					routing.primaryAgent,
				confidence: routing.confidence,
				riskLevel: routing.riskLevel || "low",
			}
		: undefined;
}

function storedPlan(
	terminal: OrchestratorTerminal,
	facts: OrchestratorTurnFacts,
) {
	const plan =
		(terminal.type === "completed" ? terminal.plan : undefined) ??
		facts.plan;
	return plan
		? {
				id: plan.id,
				description: plan.description || "",
				riskLevel: plan.riskLevel,
				steps: plan.steps.map((step) => ({
					id: step.id,
					description: step.description,
					status: step.status ?? "pending",
					order: step.order,
					riskLevel: step.riskLevel,
					requiresApproval: step.requiresApproval,
				})),
			}
		: undefined;
}

/**
 * Save a turn that ended while a response watched it: its question, the
 * clarifications it saved as they were answered, its answer, and the
 * execution record the chat renders from. A usage-limit refusal saves
 * nothing, as the chat saves nothing for it.
 */
export async function saveOrchestratorTurn(
	context: OrchestratorTurnContext,
	terminal: OrchestratorTerminal,
	facts: OrchestratorTurnFacts,
): Promise<void> {
	const { turn } = context;
	const conversationId = turn.conversationId;
	if (
		!conversationId ||
		(terminal.type === "error" && terminal.code === USAGE_LIMIT_CODE)
	) {
		return;
	}
	const clarificationMessages = await savedClarifications(
		turn,
		conversationId,
	);
	const outcome = orchestratorTurnOutcome(
		context,
		terminal,
		facts,
		clarificationMessages.flatMap(
			(message) => clarificationOf(message) ?? [],
		),
	);
	if (!outcome) {
		return;
	}
	await saveConversationTurn({
		id: conversationId,
		userId: turn.userId,
		organizationId: turn.organizationId,
		messages: [question(turn), ...clarificationMessages, outcome.answer],
		execution: outcome.execution,
	});
}

/**
 * The answer message and execution record a turn that ended this way
 * saves (null for a turn with no execution). Shared with the multi-agent
 * record, which keeps one such record per agent.
 */
export function orchestratorTurnOutcome(
	context: OrchestratorTurnContext,
	terminal: OrchestratorTerminal,
	facts: OrchestratorTurnFacts,
	clarifications: ClarificationTurn[] = [],
): {
	answer: OrchestratorAnswerMessage;
	execution: { id: string } & Record<string, unknown>;
	status: "complete" | "error" | "cancelled";
} | null {
	const { turn } = context;
	const executionId = turn.executionId;
	if (!executionId) {
		return null;
	}
	const steps = storedSteps(terminal, facts);
	const response = finalResponse(terminal, facts, steps);
	const status = executionStatus(terminal);
	const completedAt = new Date().toISOString();
	const completed = terminal.type === "completed" ? terminal : null;
	const error = errorOf(terminal);
	const apiBilling =
		apiBillingOf(completed?.apiBilling) ?? context.billing ?? undefined;
	const sourcesUsed = completed?.planningAudit?.sourcesUsed ?? [];
	const answer: OrchestratorAnswerMessage = {
		id: orchestratorTurnMessageIds(turn.clientRequestKey).assistant,
		role: "assistant",
		content: response,
		timestamp: completedAt,
		...(status === "cancelled"
			? { streamStatus: "cancelled", cancelledAt: completedAt }
			: { streamStatus: status === "error" ? "error" : "completed" }),
	};
	return {
		answer,
		status,
		execution: {
			id: executionId,
			workflowId: executionId,
			userMessage: turn.questionText ?? "",
			imageUrls: context.imageUrls,
			routingDecision: routingDecision(facts),
			plan: storedPlan(terminal, facts),
			stepResults: steps,
			approvalHistory: terminal.approvalHistory ?? [],
			variables: {},
			status,
			startedAt: turn.createdAt.toISOString(),
			completedAt,
			finalResponse: response,
			error,
			clarifications:
				clarifications.length > 0 ? clarifications : undefined,
			truncated: parseTurnTruncation(completed?.truncated),
			model: completed?.model,
			apiBilling,
			artifacts: completed?.artifacts?.filter(
				(artifact) => artifact.content && artifact.content.length > 100,
			),
			sourcesUsed,
		},
	};
}

/**
 * Save a clarification the moment the turn took it, with the turn's
 * question, so a reload shows the exchange while the turn still runs. The
 * record is the one the conversation's read projection shows for a running
 * turn; the end-of-turn save replaces it and reads the clarifications back.
 */
export async function saveAnsweredClarification(
	turn: ConversationTurn,
	clarificationId: string,
	clarification: ClarificationTurn,
): Promise<void> {
	const conversationId = turn.conversationId;
	const executionId = turn.executionId;
	if (!conversationId || !executionId) {
		return;
	}
	const saved = await savedClarifications(turn, conversationId);
	const answered = clarificationMessage(turn, clarificationId, clarification);
	const messages = [
		question(turn),
		...saved.filter((message) => message.id !== answered.id),
		answered,
	];
	await saveConversationTurn({
		id: conversationId,
		userId: turn.userId,
		organizationId: turn.organizationId,
		messages,
		execution: {
			id: executionId,
			userMessage: turn.questionText ?? "",
			finalResponse: "",
			status: "running",
			startedAt: turn.createdAt.toISOString(),
			recoveredFromTurn: true,
			inProgress: true,
			questionMessageId: orchestratorTurnMessageIds(turn.clientRequestKey)
				.user,
			clarifications: messages.flatMap(
				(message) => clarificationOf(message) ?? [],
			),
		},
	});
}
