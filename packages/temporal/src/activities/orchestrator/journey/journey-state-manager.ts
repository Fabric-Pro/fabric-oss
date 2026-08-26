/**
 * Journey State Manager
 *
 * Manages multi-turn conversation state and journey tracking for
 * Fabric Loom, inspired by Factory AI's approach.
 *
 * Key responsibilities:
 * - Track conversation across multiple turns
 * - Maintain journey context and decisions
 * - Detect continuation vs. new journey
 * - Enable adaptive plan modification
 */

import { generateText } from "@repo/ai";
import { logger } from "@repo/logs";
import { getAiModel, safeParseJson } from "../utils";
import type {
	Assumption,
	Blocker,
	ConversationTurn,
	CreateJourneyInput,
	Decision,
	JourneyAnalysisResult,
	JourneyState,
	JourneyStateUpdate,
	StepResult,
} from "./types";

/**
 * Creates a new journey state.
 */
export function createJourneyState(input: CreateJourneyInput): JourneyState {
	const journeyId = `journey-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const now = new Date();

	return {
		journeyId,
		userId: input.userId,
		organizationId: input.organizationId,

		originalGoal: input.message,
		goalConfidence: 1.0,

		phase: "initializing",
		phaseHistory: [{ phase: "initializing", timestamp: now }],

		currentPlan: null,
		planHistory: [],
		planVersion: 0,

		executedSteps: [],
		currentStepIndex: 0,
		stepResults: new Map(),

		modifications: [],

		decisions: [],
		assumptions: [],
		blockers: [],

		clarifications: [],
		conversation: input.conversationHistory || [
			{
				id: `turn-${Date.now()}`,
				role: "user",
				content: input.message,
				timestamp: now,
			},
		],

		context: {
			originalMessage: input.message,
			workspaceContent: input.workspaceContent,
			researchFindings: [],
			userPreferences: {},
			domainKnowledge: [],
			relevantArtifacts: [],
			...input.inheritedContext,
		},

		variables: {
			"sys.journeyId": {
				name: "sys.journeyId",
				value: journeyId,
				setBy: "system",
				setAt: now.toISOString(),
				scope: "workflow",
				readonly: true,
			},
		},

		startedAt: now,
		lastActivityAt: now,

		metrics: {
			totalTurns: 1,
			planRevisions: 0,
			stepsCompleted: 0,
			stepsFailed: 0,
			stepsSkipped: 0,
			approvalsRequested: 0,
			approvalsGranted: 0,
			totalDurationMs: 0,
			waitingForUserMs: 0,
		},
	};
}

/**
 * Applies an update to the journey state.
 */
export function applyJourneyUpdate(
	state: JourneyState,
	update: JourneyStateUpdate,
): JourneyState {
	const now = new Date();
	state.lastActivityAt = now;

	switch (update.type) {
		case "set_phase":
			state.phase = update.phase;
			state.phaseHistory.push({
				phase: update.phase,
				timestamp: now,
				reason: update.reason,
			});
			break;

		case "set_plan":
			if (state.currentPlan) {
				state.planHistory.push(state.currentPlan);
			}
			state.currentPlan = update.plan;
			state.planVersion++;
			state.metrics.planRevisions++;
			break;

		case "add_decision":
			state.decisions.push(update.decision);
			break;

		case "add_assumption":
			state.assumptions.push(update.assumption);
			break;

		case "add_blocker":
			state.blockers.push(update.blocker);
			break;

		case "resolve_blocker": {
			const blocker = state.blockers.find(
				(b) => b.id === update.blockerId,
			);
			if (blocker) {
				blocker.resolvedAt = now;
				blocker.resolution = update.resolution;
			}
			break;
		}

		case "add_clarification":
			state.clarifications.push(update.clarification);
			break;

		case "add_modification":
			state.modifications.push(update.modification);
			break;

		case "add_conversation_turn":
			state.conversation.push(update.turn);
			state.metrics.totalTurns++;
			break;

		case "update_step_result": {
			const existing = state.stepResults.get(update.stepId);
			const updated: StepResult = {
				stepId: update.stepId,
				status: update.result.status || existing?.status || "pending",
				response: update.result.response ?? existing?.response,
				error: update.result.error ?? existing?.error,
				artifacts: update.result.artifacts ?? existing?.artifacts,
				durationMs: update.result.durationMs ?? existing?.durationMs,
				retryCount:
					update.result.retryCount ?? existing?.retryCount ?? 0,
			};
			state.stepResults.set(update.stepId, updated);

			// Update metrics
			if (updated.status === "completed") {
				state.metrics.stepsCompleted++;
			}
			if (updated.status === "failed") {
				state.metrics.stepsFailed++;
			}
			if (updated.status === "skipped") {
				state.metrics.stepsSkipped++;
			}
			break;
		}

		case "set_variable":
			state.variables[update.name] = update.value;
			break;

		case "update_context":
			state.context = { ...state.context, ...update.context };
			break;

		case "increment_step":
			state.currentStepIndex++;
			break;

		case "complete":
			state.phase = "completed";
			state.completedAt = now;
			state.phaseHistory.push({ phase: "completed", timestamp: now });
			state.metrics.totalDurationMs =
				now.getTime() - state.startedAt.getTime();
			break;

		case "fail":
			state.phase = "failed";
			state.phaseHistory.push({
				phase: "failed",
				timestamp: now,
				reason: update.error,
			});
			break;
	}

	return state;
}

/**
 * Analyzes user input to determine if it's a new journey or continuation.
 */
export async function analyzeJourneyInput(
	message: string,
	existingState: JourneyState | null,
	userId: string,
	organizationId?: string,
	_apiKey?: string,
): Promise<JourneyAnalysisResult> {
	// If no existing state, it's definitely a new journey
	if (!existingState) {
		return {
			isNewJourney: true,
			isContinuation: false,
			confidence: 1.0,
			reasoning: "No existing journey state",
			suggestedAction: "create_new",
		};
	}

	// Check for explicit new journey indicators
	const newJourneyIndicators = [
		"new task",
		"forget the previous",
		"start fresh",
		"different topic",
		"new request",
		"unrelated",
	];
	const messageLower = message.toLowerCase();
	if (newJourneyIndicators.some((ind) => messageLower.includes(ind))) {
		return {
			isNewJourney: true,
			isContinuation: false,
			confidence: 0.9,
			reasoning: "User explicitly requested new journey",
			suggestedAction: "create_new",
		};
	}

	// Check for continuation indicators
	const continuationIndicators = [
		"the prd",
		"that document",
		"as discussed",
		"as mentioned",
		"the plan",
		"the steps",
		"actually",
		"instead",
		"also add",
		"change",
		"modify",
		"update",
		"wait",
		"stop",
		"yes",
		"no",
		"approved",
		"rejected",
		"go ahead",
		"proceed",
		"looks good",
		"why",
		"what about",
		"how",
		"when",
	];

	const hasContinuationIndicator = continuationIndicators.some((ind) =>
		messageLower.includes(ind),
	);

	// Use LLM to analyze ambiguous cases
	if (!hasContinuationIndicator) {
		try {
			const model = await getAiModel(userId, organizationId);
			const response = await generateText({
				model,
				system: `You analyze user messages to determine if they continue an existing task or start a new one.

Current journey:
- Original goal: ${existingState.originalGoal}
- Current phase: ${existingState.phase}
- Steps completed: ${existingState.metrics.stepsCompleted}

Respond with JSON: {"isNewJourney": boolean, "continuationType": "string or null", "confidence": 0-1, "reasoning": "string"}`,
				prompt: `User message: "${message}"`,
				temperature: 0.1,
			});

			const parsed = safeParseJson<{
				isNewJourney: boolean;
				continuationType: string | null;
				confidence: number;
				reasoning: string;
			}>(response.text || "{}", "object");

			if (parsed) {
				return {
					isNewJourney: parsed.isNewJourney,
					isContinuation: !parsed.isNewJourney,
					continuationType:
						parsed.continuationType as JourneyAnalysisResult["continuationType"],
					confidence: parsed.confidence,
					reasoning: parsed.reasoning,
					suggestedAction: parsed.isNewJourney
						? "create_new"
						: "continue",
					existingJourneyId: parsed.isNewJourney
						? undefined
						: existingState.journeyId,
				};
			}
		} catch (error) {
			logger.warn(
				"[JourneyManager] Failed to analyze with LLM, using heuristics",
				{
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
			);
		}
	}

	// Determine continuation type based on keywords
	let continuationType: JourneyAnalysisResult["continuationType"];
	let suggestedAction: JourneyAnalysisResult["suggestedAction"] = "continue";

	if (
		messageLower.includes("actually") ||
		messageLower.includes("instead") ||
		messageLower.includes("change")
	) {
		continuationType = "modification";
		suggestedAction = "modify_plan";
	} else if (
		messageLower.includes("also") ||
		messageLower.includes("add") ||
		messageLower.includes("include")
	) {
		continuationType = "addition";
		suggestedAction = "modify_plan";
	} else if (
		messageLower.includes("skip") ||
		messageLower.includes("remove") ||
		messageLower.includes("don't")
	) {
		continuationType = "removal";
		suggestedAction = "modify_plan";
	} else if (
		messageLower.includes("why") ||
		messageLower.includes("what") ||
		messageLower.includes("how")
	) {
		continuationType = "question";
		suggestedAction = "answer_question";
	} else if (
		messageLower.includes("yes") ||
		messageLower.includes("approved") ||
		messageLower.includes("go ahead") ||
		messageLower.includes("proceed") ||
		messageLower.includes("no") ||
		messageLower.includes("rejected")
	) {
		continuationType = "approval";
		suggestedAction = "process_approval";
	} else if (
		messageLower.includes("good") ||
		messageLower.includes("like") ||
		messageLower.includes("improve")
	) {
		continuationType = "feedback";
		suggestedAction = "continue";
	} else {
		continuationType = "clarification";
		suggestedAction = "continue";
	}

	return {
		isNewJourney: false,
		isContinuation: true,
		continuationType,
		confidence: hasContinuationIndicator ? 0.85 : 0.6,
		reasoning: `Detected ${continuationType} based on message content`,
		suggestedAction,
		existingJourneyId: existingState.journeyId,
	};
}

/**
 * Records a decision in the journey state.
 */
export function recordDecision(
	state: JourneyState,
	category: Decision["category"],
	description: string,
	reasoning: string,
	alternatives: Decision["alternatives"] = [],
	selectedAlternative?: string,
	confidence = 0.8,
	stepId?: string,
): JourneyState {
	const decision: Decision = {
		id: `decision-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		category,
		description,
		reasoning,
		alternatives,
		selectedAlternative,
		confidence,
		timestamp: new Date(),
		stepId,
		reversible: category !== "execution",
	};

	return applyJourneyUpdate(state, { type: "add_decision", decision });
}

/**
 * Records an assumption in the journey state.
 */
export function recordAssumption(
	state: JourneyState,
	description: string,
	category: Assumption["category"],
	impactIfWrong: string,
	madeBy: Assumption["madeBy"] = "orchestrator",
	validationMethod?: string,
): JourneyState {
	const assumption: Assumption = {
		id: `assumption-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		description,
		madeAt: new Date(),
		madeBy,
		category,
		impactIfWrong,
		validationMethod,
	};

	return applyJourneyUpdate(state, { type: "add_assumption", assumption });
}

/**
 * Records a blocker in the journey state.
 */
export function recordBlocker(
	state: JourneyState,
	description: string,
	category: Blocker["category"],
	severity: Blocker["severity"],
	blockingSteps: string[],
	suggestedActions: string[] = [],
): JourneyState {
	const blocker: Blocker = {
		id: `blocker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		description,
		category,
		severity,
		createdAt: new Date(),
		blockingSteps,
		suggestedActions,
	};

	return applyJourneyUpdate(state, { type: "add_blocker", blocker });
}

/**
 * Adds a conversation turn to the journey.
 */
export function addConversationTurn(
	state: JourneyState,
	role: ConversationTurn["role"],
	content: string,
	metadata?: ConversationTurn["metadata"],
): JourneyState {
	const turn: ConversationTurn = {
		id: `turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		role,
		content,
		timestamp: new Date(),
		metadata,
	};

	return applyJourneyUpdate(state, { type: "add_conversation_turn", turn });
}

/**
 * Gets recent conversation history formatted for LLM context.
 */
export function getConversationContext(
	state: JourneyState,
	maxTurns = 10,
): string {
	const recentTurns = state.conversation.slice(-maxTurns);

	if (recentTurns.length === 0) {
		return "";
	}

	const lines = ["## Conversation History"];
	for (const turn of recentTurns) {
		const role =
			turn.role === "user"
				? "User"
				: turn.role === "orchestrator"
					? "Assistant"
					: `Agent (${turn.metadata?.agentId || "unknown"})`;
		lines.push(
			`**${role}**: ${turn.content.slice(0, 500)}${turn.content.length > 500 ? "..." : ""}`,
		);
	}

	return lines.join("\n\n");
}

/**
 * Gets decision history formatted for LLM context.
 */
export function getDecisionContext(
	state: JourneyState,
	maxDecisions = 5,
): string {
	const recentDecisions = state.decisions.slice(-maxDecisions);

	if (recentDecisions.length === 0) {
		return "";
	}

	const lines = ["## Previous Decisions"];
	for (const decision of recentDecisions) {
		lines.push(`- **${decision.description}**: ${decision.reasoning}`);
	}

	return lines.join("\n");
}

/**
 * Gets assumptions formatted for LLM context.
 */
export function getAssumptionsContext(state: JourneyState): string {
	const activeAssumptions = state.assumptions.filter(
		(a) => a.isValid !== false,
	);

	if (activeAssumptions.length === 0) {
		return "";
	}

	const lines = ["## Working Assumptions"];
	for (const assumption of activeAssumptions) {
		const status = assumption.isValid === true ? "✓" : "?";
		lines.push(`- ${status} ${assumption.description}`);
	}

	return lines.join("\n");
}

/**
 * Gets blockers formatted for display.
 */
export function getBlockersContext(state: JourneyState): string {
	const activeBlockers = state.blockers.filter((b) => !b.resolvedAt);

	if (activeBlockers.length === 0) {
		return "";
	}

	const lines = ["## Current Blockers"];
	for (const blocker of activeBlockers) {
		lines.push(
			`- 🚧 **${blocker.category.toUpperCase()}**: ${blocker.description}`,
		);
		if (blocker.suggestedActions.length > 0) {
			lines.push(`  Suggested: ${blocker.suggestedActions.join(", ")}`);
		}
	}

	return lines.join("\n");
}

/**
 * Gets full journey context for planning prompts.
 */
export function getFullJourneyContext(state: JourneyState): string {
	const parts: string[] = [];

	// Journey overview
	parts.push("## Journey Overview");
	parts.push(`**Original Goal**: ${state.originalGoal}`);
	if (state.refinedGoal) {
		parts.push(`**Refined Goal**: ${state.refinedGoal}`);
	}
	parts.push(`**Phase**: ${state.phase}`);
	parts.push(
		`**Progress**: ${state.metrics.stepsCompleted} steps completed, ${state.currentPlan?.steps.length || 0} total`,
	);

	// Current plan summary
	if (state.currentPlan) {
		parts.push("");
		parts.push("## Current Plan");
		parts.push(`**Plan Version**: ${state.planVersion}`);
		for (const step of state.currentPlan.steps) {
			const status = state.stepResults.get(step.id)?.status || "pending";
			const statusIcon =
				status === "completed"
					? "✓"
					: status === "failed"
						? "✗"
						: status === "skipped"
							? "○"
							: "•";
			parts.push(`${statusIcon} ${step.order}. ${step.description}`);
		}
	}

	// Add other context sections
	const conversationCtx = getConversationContext(state, 5);
	if (conversationCtx) {
		parts.push("");
		parts.push(conversationCtx);
	}

	const decisionCtx = getDecisionContext(state);
	if (decisionCtx) {
		parts.push("");
		parts.push(decisionCtx);
	}

	const assumptionsCtx = getAssumptionsContext(state);
	if (assumptionsCtx) {
		parts.push("");
		parts.push(assumptionsCtx);
	}

	const blockersCtx = getBlockersContext(state);
	if (blockersCtx) {
		parts.push("");
		parts.push(blockersCtx);
	}

	return parts.join("\n");
}

/**
 * Serializes journey state for persistence.
 */
export function serializeJourneyState(state: JourneyState): string {
	return JSON.stringify({
		...state,
		stepResults: Array.from(state.stepResults.entries()),
	});
}

/**
 * Deserializes journey state from storage.
 */
export function deserializeJourneyState(json: string): JourneyState {
	const parsed = JSON.parse(json);
	return {
		...parsed,
		stepResults: new Map(parsed.stepResults),
		startedAt: new Date(parsed.startedAt),
		lastActivityAt: new Date(parsed.lastActivityAt),
		completedAt: parsed.completedAt
			? new Date(parsed.completedAt)
			: undefined,
	};
}

/**
 * Creates a summary of the journey for logging/debugging.
 */
export function getJourneySummary(state: JourneyState): string {
	return `Journey ${state.journeyId}: Phase=${state.phase}, Steps=${state.metrics.stepsCompleted}/${state.currentPlan?.steps.length || 0}, Decisions=${state.decisions.length}, Turns=${state.metrics.totalTurns}`;
}
