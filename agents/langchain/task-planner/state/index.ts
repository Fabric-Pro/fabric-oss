/**
 * Task Planner State
 *
 * LangGraph state annotations for the task planner agent.
 * Follows AG-UI protocol for predictive state updates.
 */

import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import { reasoningByTurnAnnotation } from "@repo/agent-core/reasoning-trace";
import type {
	DecomposedTask,
	DependencyGraph,
	ExecutionPlan,
	RiskAnalysis,
} from "../types";

/**
 * Task Planner State Annotation
 *
 * Follows AG-UI protocol for predictive updates with CopilotKit.
 */
export const TaskPlannerState = Annotation.Root({
	...MessagesAnnotation.spec,

	// ========================================================================
	// Input Context
	// ========================================================================

	/** Project name */
	projectName: Annotation<string>,

	/** Optional project description */
	projectDescription: Annotation<string | undefined>,

	/** Feature or requirements to decompose */
	userStory: Annotation<string>,

	/** Technology stack context */
	techStack: Annotation<string | undefined>,

	/** Optional custom system prompt from Prompt Library */
	systemPrompt: Annotation<string | undefined>,

	// ========================================================================
	// CopilotKit Integration
	// ========================================================================

	/** Tools passed from CopilotKit */
	tools: Annotation<any[]>({
		reducer: (x, y) => y ?? x,
		default: () => [],
	}),

	// ========================================================================
	// Output - AG-UI Protocol
	// ========================================================================

	/** Generated document (AG-UI predictive state) */
	document: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/** Focus anchor for UI scrolling (AG-UI) */
	focusAnchor: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	// ========================================================================
	// Task Decomposition State (CUGA-inspired)
	// ========================================================================

	/** Decomposed tasks from analysis */
	decomposedTasks: Annotation<DecomposedTask[]>({
		reducer: (x, y) => y ?? x,
		default: () => [],
	}),

	/** Risk analysis results */
	riskAnalysis: Annotation<RiskAnalysis | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/** Dependency graph for tasks */
	dependencyGraph: Annotation<DependencyGraph | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/** Execution plan with phases */
	executionPlan: Annotation<ExecutionPlan | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	// ========================================================================
	// Processing State
	// ========================================================================

	/** Current processing stage for streaming updates */
	currentStage: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/** Error message if any */
	error: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/** Retry count for error recovery */
	retryCount: Annotation<number>({
		reducer: (x, y) => y ?? x,
		default: () => 0,
	}),

	/**
	 * Per-turn reasoning trace ("Thinking · X.Ys" UI affordance). Populated
	 * ONLY by `generate-document.ts` (the final DAG node that produces the
	 * user-visible assistant message). The intermediate DAG nodes
	 * (analyze / assess-risks / build-dependencies / plan-execution) emit
	 * structured state fields, not a user-visible AI message, so emitting
	 * reasoning from them would create N "Thinking · X.Ys" affordances per
	 * user turn — confusing UX. Final-node-only is a product decision (Q3).
	 *
	 * Keyed by turnIndex (= count of human messages in state.messages).
	 * Ephemeral — reset with conversation.
	 */
	reasoningByTurn: reasoningByTurnAnnotation(),
});

/**
 * Type alias for TaskPlannerState
 */
export type TaskPlannerStateType = typeof TaskPlannerState.State;
