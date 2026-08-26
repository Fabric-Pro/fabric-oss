/**
 * Core types for fabric-weave
 *
 * Multi-agent orchestration system with shared sandbox sessions
 */

// ============================================================================
// Weave Plan Types
// ============================================================================

export interface WeaveCheckbox {
	id: string;
	text: string;
	agent: "thread" | "spindle" | "weft" | "warp" | "shuttle";
	category?: string; // For shuttle: 'frontend', 'backend', 'database', etc.
	status: WeaveCheckboxStatus;
	requiresReview?: boolean;
	reviewType?: "weft" | "warp" | "both";
	startedAt?: Date;
	completedAt?: Date;
	artifacts?: string[];
	error?: string;
}

export type WeaveCheckboxStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "failed"
	| "skipped";

export interface WeavePlan {
	id: string;
	userId: string;
	organizationId: string | null;
	projectId: string;
	userStoryId: string | null;
	storyTaskId: string | null;
	name: string;
	description: string | null;
	status: WeavePlanStatus;
	checkboxes: WeaveCheckbox[];
	createdAt: Date;
	updatedAt: Date;
}

export type WeavePlanStatus =
	| "DRAFT"
	| "PENDING_APPROVAL"
	| "APPROVED"
	| "RUNNING"
	| "PAUSED"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED";

// ============================================================================
// Weave Execution Types
// ============================================================================

export interface WeaveExecution {
	id: string;
	userId: string;
	organizationId: string | null;
	planId: string;
	projectId: string;
	workflowId: string;
	runId: string;
	sandboxSessionId: string | null;
	status: WeaveExecutionStatus;
	currentStep: number;
	artifacts: unknown | null;
	error: string | null;
	createdAt: Date;
	updatedAt: Date;
	startedAt: Date | null;
	completedAt: Date | null;
}

export type WeaveExecutionStatus =
	| "PENDING"
	| "RUNNING"
	| "PAUSED"
	| "CHECKPOINT"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED"
	| "TERMINATED_STALE";

// ============================================================================
// Project Configuration Types
// ============================================================================

export interface ProjectWeaveConfig {
	id: string;
	projectId: string;
	userId: string;
	organizationId: string | null;

	// Agent configurations
	patternConfig: PatternConfig | null;
	shuttleConfig: ShuttleConfig | null;

	// Execution settings
	requireReview: boolean;
	requireSecurityReview: boolean;
	autoExecuteSimple: boolean;
	complexityThreshold: "low" | "medium" | "high";

	// Skills and tools
	enabledSkills: string[]; // Skill IDs
	enabledMcpTools: string[]; // MCP Config IDs

	// Category routing
	categoryRouting: CategoryRouting | null;

	createdAt: Date;
	updatedAt: Date;
}

export interface PatternConfig {
	model?: string;
	temperature?: number;
	systemPrompt?: string;
}

export interface ShuttleConfig {
	defaultCategory?: string;
	model?: string;
}

export interface CategoryRouting {
	frontend?: string;
	backend?: string;
	database?: string;
	devops?: string;
	[key: string]: string | undefined;
}

// ============================================================================
// A2A Context Types
// ============================================================================

export interface WeaveA2AMetadata {
	tenantContext: TenantContext;
	sandboxContext?: SandboxContext;
	skills?: string;
	mcpTools?: string[];
	category?: string; // For shuttle
}

export interface TenantContext {
	userId: string;
	organizationId: string | null;
}

export interface SandboxContext {
	sessionId: string;
	workDir: string;
	branch: string;
	userId: string;
	organizationId?: string | null;
}

// ============================================================================
// Checkpoint Types
// ============================================================================

export interface WeaveCheckpoint {
	id: string;
	executionId: string;
	checkboxId: string;
	agentName: string;
	type: "review" | "approval" | "clarification";
	status: "pending" | "approved" | "rejected" | "modified";
	tool?: string;
	action?: string;
	data?: unknown;
	feedback?: string;
	createdAt: Date;
	resolvedAt: Date | null;
}

// ============================================================================
// Eval Types
// ============================================================================

export interface EvalCase {
	id: string;
	name: string;
	agent: string;
	input: {
		message: string;
		context?: unknown;
	};
	expected: {
		output?: string;
		tools?: string[];
		artifacts?: unknown;
	};
}

export interface EvalResult {
	caseId: string;
	passed: boolean;
	actual: unknown;
	expected: unknown;
	duration: number;
	error?: string;
}
