/**
 * Task Planner Agent Types
 *
 * Enhanced with Task Decomposition and Risk Analysis (CUGA-inspired)
 */

/**
 * Task type categories
 */
export type TaskType =
	| "Frontend"
	| "Backend"
	| "Database"
	| "DevOps"
	| "Testing"
	| "Documentation";

/**
 * Task complexity level
 */
export type Complexity = "low" | "medium" | "high";

/**
 * Risk severity levels
 */
export type RiskSeverity = "low" | "medium" | "high" | "critical";

/**
 * Risk category types
 */
export type RiskCategory =
	| "technical"
	| "resource"
	| "timeline"
	| "dependency"
	| "unknown";

// ============================================================================
// Task Decomposition Types (CUGA-inspired)
// ============================================================================

/**
 * Decomposed task with risk scoring and dependencies
 */
export interface DecomposedTask {
	id: string;
	parentId?: string;
	title: string;
	description: string;
	type: TaskType;
	estimate: number; // hours
	complexity: Complexity;
	riskScore: number; // 0-100
	riskFactors: string[];
	dependencies: string[]; // task IDs this task depends on
	blockedBy: string[]; // task IDs blocking this task
	parallelizable: boolean;
	subtasks: DecomposedTask[];
	acceptanceCriteria: string[];
	technicalApproach: string[];
	filesToModify: string[];
}

/**
 * Individual risk factor
 */
export interface RiskFactor {
	id: string;
	category: RiskCategory;
	description: string;
	severity: RiskSeverity;
	probability: number; // 0-1
	impact: number; // 0-100
	affectedTasks: string[];
}

/**
 * Risk mitigation strategy
 */
export interface Mitigation {
	riskId: string;
	strategy: string;
	effort: number; // hours
	effectiveness: number; // 0-1
}

/**
 * Overall risk analysis
 */
export interface RiskAnalysis {
	overallScore: number; // 0-100
	factors: RiskFactor[];
	mitigations: Mitigation[];
	recommendations: string[];
}

/**
 * Dependency graph node
 */
interface DependencyNode {
	id: string;
	label: string;
	level: number;
	type: TaskType;
}

/**
 * Dependency graph edge
 */
interface DependencyEdge {
	from: string;
	to: string;
	type: "blocks" | "depends";
}

/**
 * Dependency graph structure
 */
export interface DependencyGraph {
	nodes: DependencyNode[];
	edges: DependencyEdge[];
	criticalPath: string[]; // task IDs forming the critical path
	totalCriticalPathDuration: number; // hours
}

/**
 * Execution phase for parallel task scheduling
 */
interface ExecutionPhase {
	id: string;
	name: string;
	tasks: string[]; // Task IDs that can be executed in parallel
	duration: number; // hours (determined by longest task)
	dependencies: string[]; // Previous phase IDs
}

/**
 * Overall execution plan
 */
export interface ExecutionPlan {
	phases: ExecutionPhase[];
	totalDuration: number; // hours (sequential execution)
	parallelDuration: number; // hours (with parallelization)
	parallelizationFactor: number; // 0-1 (higher = more parallelizable)
	recommendedTeamSize: number;
}
