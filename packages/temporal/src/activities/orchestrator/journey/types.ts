/**
 * Journey State Types
 *
 * Defines the types for multi-turn conversation and journey tracking
 * in Fabric Loom, inspired by Factory AI's approach.
 */

import type {
	AgentVariable,
	TaskPlan,
	TrajectoryStep,
} from "../../orchestrator/types";

/**
 * Represents a decision made during journey execution.
 * Tracks what was decided, why, and what alternatives existed.
 */
export interface Decision {
	id: string;
	category:
		| "routing"
		| "planning"
		| "execution"
		| "recovery"
		| "user_request";
	description: string;
	reasoning: string;
	alternatives: Alternative[];
	selectedAlternative?: string;
	confidence: number;
	timestamp: Date;
	stepId?: string;
	reversible: boolean;
}

export interface Alternative {
	id: string;
	description: string;
	pros: string[];
	cons: string[];
	estimatedEffort: "low" | "medium" | "high";
}

/**
 * Represents an assumption made during planning or execution.
 * Assumptions should be tracked and validated when possible.
 */
export interface Assumption {
	id: string;
	description: string;
	madeAt: Date;
	madeBy: "orchestrator" | "user" | "agent";
	category: "requirement" | "constraint" | "preference" | "technical";
	validatedBy?: string;
	validatedAt?: Date;
	isValid?: boolean;
	impactIfWrong: string;
	validationMethod?: string;
}

/**
 * Represents a blocker preventing progress.
 */
export interface Blocker {
	id: string;
	description: string;
	category:
		| "approval"
		| "information"
		| "resource"
		| "technical"
		| "external";
	severity: "low" | "medium" | "high" | "critical";
	createdAt: Date;
	resolvedAt?: Date;
	resolution?: string;
	blockingSteps: string[];
	suggestedActions: string[];
}

/**
 * Represents a clarification from the user.
 */
export interface Clarification {
	id: string;
	question?: string;
	answer: string;
	timestamp: Date;
	affectedSteps: string[];
	appliedToContext: boolean;
}

/**
 * Represents a modification to the plan during execution.
 */
export interface PlanModification {
	id: string;
	type:
		| "clarification"
		| "addition"
		| "removal"
		| "modification"
		| "pivot"
		| "reorder";
	description: string;
	timestamp: Date;
	triggeredBy: "user" | "orchestrator" | "agent" | "error";
	userMessage?: string;
	affectedSteps: {
		added: string[];
		removed: string[];
		modified: string[];
		reordered: string[];
	};
	previousPlanSnapshot?: TaskPlan;
	reasoning: string;
	approved: boolean;
}

/**
 * Context accumulated throughout the journey.
 */
export interface JourneyContext {
	originalMessage: string;
	refinedGoal?: string;
	workspaceContent?: string;
	researchFindings: ResearchFinding[];
	userPreferences: Record<string, unknown>;
	domainKnowledge: string[];
	relevantArtifacts: ArtifactReference[];
	conversationSummary?: string;
}

export interface ResearchFinding {
	id: string;
	query: string;
	source: string;
	content: string;
	relevance: number;
	timestamp: Date;
}

export interface ArtifactReference {
	id: string;
	type: string;
	name: string;
	stepId: string;
	createdAt: Date;
}

/**
 * Conversation turn in the journey.
 */
export interface ConversationTurn {
	id: string;
	role: "user" | "orchestrator" | "agent";
	content: string;
	timestamp: Date;
	metadata?: {
		stepId?: string;
		planModification?: string;
		approval?: boolean;
		agentId?: string;
	};
}

/**
 * Journey phase tracking.
 */
export type JourneyPhase =
	| "initializing"
	| "understanding"
	| "planning"
	| "awaiting_approval"
	| "executing"
	| "paused"
	| "recovering"
	| "completing"
	| "completed"
	| "failed"
	| "cancelled";

/**
 * Main journey state interface.
 * This is the central state object for multi-turn orchestration.
 */
export interface JourneyState {
	journeyId: string;
	userId: string;
	organizationId?: string;

	// Goal tracking
	originalGoal: string;
	refinedGoal?: string;
	goalConfidence: number;

	// Phase tracking
	phase: JourneyPhase;
	phaseHistory: Array<{
		phase: JourneyPhase;
		timestamp: Date;
		reason?: string;
	}>;

	// Plan management
	currentPlan: TaskPlan | null;
	planHistory: TaskPlan[];
	planVersion: number;

	// Execution state
	executedSteps: TrajectoryStep[];
	currentStepIndex: number;
	stepResults: Map<string, StepResult>;

	// Modifications and adaptations
	modifications: PlanModification[];
	pendingModification?: PlanModification;

	// Decision tracking (Factory AI style)
	decisions: Decision[];
	assumptions: Assumption[];
	blockers: Blocker[];

	// User interaction
	clarifications: Clarification[];
	conversation: ConversationTurn[];

	// Context accumulation
	context: JourneyContext;
	variables: Record<string, AgentVariable>;

	// Timing
	startedAt: Date;
	lastActivityAt: Date;
	completedAt?: Date;

	// Metrics
	metrics: JourneyMetrics;
}

export interface StepResult {
	stepId: string;
	status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
	response?: string;
	error?: string;
	artifacts?: ArtifactReference[];
	durationMs?: number;
	retryCount: number;
}

export interface JourneyMetrics {
	totalTurns: number;
	planRevisions: number;
	stepsCompleted: number;
	stepsFailed: number;
	stepsSkipped: number;
	approvalsRequested: number;
	approvalsGranted: number;
	totalDurationMs: number;
	waitingForUserMs: number;
}

/**
 * Input for creating a new journey.
 */
export interface CreateJourneyInput {
	userId: string;
	organizationId?: string;
	message: string;
	workspaceContent?: string;
	conversationHistory?: ConversationTurn[];
	inheritedContext?: Partial<JourneyContext>;
}

/**
 * Input for continuing an existing journey.
 */
export interface ContinueJourneyInput {
	journeyId: string;
	message: string;
	isApproval?: boolean;
	approvalDecision?: "approved" | "rejected";
	approvalFeedback?: string;
}

/**
 * Result of journey analysis.
 */
export interface JourneyAnalysisResult {
	isNewJourney: boolean;
	isContinuation: boolean;
	continuationType?:
		| "clarification"
		| "modification"
		| "addition"
		| "removal"
		| "pivot"
		| "question"
		| "approval"
		| "feedback";
	confidence: number;
	reasoning: string;
	suggestedAction:
		| "create_new"
		| "continue"
		| "modify_plan"
		| "answer_question"
		| "process_approval";
	existingJourneyId?: string;
}

/**
 * Journey state update operations.
 */
export type JourneyStateUpdate =
	| { type: "set_phase"; phase: JourneyPhase; reason?: string }
	| { type: "set_plan"; plan: TaskPlan }
	| { type: "add_decision"; decision: Decision }
	| { type: "add_assumption"; assumption: Assumption }
	| { type: "add_blocker"; blocker: Blocker }
	| { type: "resolve_blocker"; blockerId: string; resolution: string }
	| { type: "add_clarification"; clarification: Clarification }
	| { type: "add_modification"; modification: PlanModification }
	| { type: "add_conversation_turn"; turn: ConversationTurn }
	| {
			type: "update_step_result";
			stepId: string;
			result: Partial<StepResult>;
	  }
	| { type: "set_variable"; name: string; value: AgentVariable }
	| { type: "update_context"; context: Partial<JourneyContext> }
	| { type: "increment_step" }
	| { type: "complete" }
	| { type: "fail"; error: string };

/**
 * Journey state snapshot for persistence.
 */
export interface JourneyStateSnapshot {
	journeyId: string;
	state: JourneyState;
	snapshotAt: Date;
	version: number;
}
