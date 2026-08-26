/**
 * Task Types
 *
 * Defines task types, capability types, task steps, and task plans.
 * Core types for the orchestrator's task execution model.
 */

import type { DelegationMode } from "./routing.types";

// =============================================================================
// Task Types
// =============================================================================

export type TaskType =
	| "api"
	| "browser"
	| "hybrid"
	| "agent"
	| "workflow"
	| "research"
	| "generate"
	| "verify";

/**
 * Capability type determines HOW a step should be executed.
 * This enables capability-based planning where the orchestrator decides
 * which execution mechanism is most appropriate for each subtask.
 */
export type CapabilityType =
	| "mcp_tool" // Direct MCP tool execution (queries, CRUD)
	| "web" // Web browsing/scraping (research, data gathering)
	| "agent" // Specialized agent delegation (document gen, complex analysis)
	| "workflow" // Pre-defined workflow execution (multi-step processes)
	| "integration" // Configured service integrations (Slack, GitHub, Linear, etc.)
	| "llm"; // Simple LLM generation (summaries, formatting)

// =============================================================================
// Task Step
// =============================================================================

export interface TaskStep {
	id: string;
	description: string;
	type: TaskType;
	status:
		| "pending"
		| "in_progress"
		| "complete"
		| "error"
		| "skipped"
		| "awaiting_approval";
	order: number;
	/** Parent step ID for nested tasks */
	parentId?: string;
	/** Agent or tool to execute this step */
	executor?: string;
	/** Input variables for this step */
	inputs?: Record<string, unknown>;
	/** Output variables from this step */
	outputs?: Record<string, unknown>;
	/** Error message if failed */
	error?: string;
	/** Duration in milliseconds */
	durationMs?: number;
	/** Risk level for HITL */
	riskLevel?: "low" | "medium" | "high" | "critical";
	/** Whether this step requires approval */
	requiresApproval?: boolean;
	/** Approval ID if waiting for approval */
	approvalId?: string;
	/** Timestamp when step started */
	startedAt?: string;
	/** Timestamp when step completed */
	completedAt?: string;
	/**
	 * Capability type - determines execution mechanism.
	 * - "mcp_tool": Execute via MCP tools
	 * - "web": Web browsing/scraping
	 * - "agent": Delegate to specialized agent
	 * - "workflow": Trigger pre-defined workflow
	 * - "llm": Simple LLM generation
	 */
	capability?: CapabilityType;
	/**
	 * The specific app/tool/agent/workflow ID to use.
	 * For mcp_tool: tool name (e.g., "fizzy_get_cards")
	 * For agent: agent ID (e.g., "project_document_generator")
	 * For workflow: workflow ID
	 * For web: tool name (e.g., "firecrawl_search")
	 */
	app?: string;
	/** Tools to use for this step (for MCP tool execution) */
	toolsToUse?: string[];
	/** Expected output description for validation */
	expectedOutput?: string;
	/** Variable name to iterate over for bulk operations */
	iterateOver?: string;
	/** Parallel group ID for concurrent execution */
	parallelGroup?: string;
	/**
	 * Step IDs that must complete before this step can run.
	 * Used for DAG-based wave scheduling. Steps with no dependsOn
	 * (or empty array) are considered independent and may run in parallel.
	 */
	dependsOn?: string[];
	/** Verification result from operation verification */
	verificationResult?: {
		verified: boolean;
		operationType: string;
		message: string;
		details?: {
			entityType: string;
			targetEntityName?: string;
			expectedCount: number;
			actualSuccessCount: number;
			actualFailCount: number;
			notFoundOrRemaining: Array<{
				id?: string;
				name?: string;
				type: string;
				reason: string;
			}>;
			toolCallsSummary: Array<{
				name: string;
				status: string;
				hasResult: boolean;
			}>;
			issues: string[];
		};
	};
	/** Actual tools used during execution (set post-execution) */
	actualToolsUsed?: string[];
}

// =============================================================================
// Task Plan
// =============================================================================

export interface TaskPlan {
	id: string;
	description: string;
	steps: TaskStep[];
	/** Overall risk level */
	riskLevel: "low" | "medium" | "high" | "critical";
	/** Estimated total duration */
	estimatedDurationMs?: number;
	/** Strategy selected for execution */
	strategy: TaskType;
	/** Created at timestamp */
	createdAt: string;
	/** Metadata for generalist agent delegation */
	metadata?: {
		/** Whether this plan delegates to a generalist agent */
		isGeneralistDelegation?: boolean;
		/** Delegation mode used */
		delegationMode?: DelegationMode;
		/** Whether this is a read-only plan (no create/update/delete) */
		isReadOnly?: boolean;
		/** Agent capabilities */
		agentCapabilities?: {
			autonomousExecution?: boolean;
			taskDecomposition?: boolean;
			contextPreservation?: boolean;
			codeExecution?: boolean;
			browserAutomation?: boolean;
			memoryEnabled?: boolean;
			multiTenancyAware?: boolean;
			maxAutonomyLevel?: "step" | "subtask" | "task" | "session";
		};
		/** Risk assessment for generalist delegation */
		riskAssessment?: {
			/** Original risk level from routing */
			originalRisk: "low" | "medium" | "high" | "critical";
			/** Adjusted risk level after capability analysis */
			adjustedRisk: "low" | "medium" | "high" | "critical";
			/** Factors that contributed to risk assessment */
			riskFactors: string[];
		};
	};
}
