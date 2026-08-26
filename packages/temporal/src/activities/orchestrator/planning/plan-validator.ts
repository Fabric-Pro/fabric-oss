/**
 * Plan Validation Framework
 *
 * Validates task plans before execution to catch issues early.
 * Performs executability checks, dependency analysis, and risk assessment.
 *
 * Part of Phase 2: Intelligent Planning
 */

import { logger } from "@repo/logs";
import { getAgentCapabilities } from "../delegation/agent-capabilities";
import { resolveAgentEndpoint } from "../delegation/resolve-endpoint";
import type {
	AgentCardCapabilities,
	RoutingDecision,
	TaskPlan,
	TaskStep,
} from "../types";

// =============================================================================
// Types
// =============================================================================

export interface PlanValidationResult {
	/** Whether the plan is valid and executable */
	isValid: boolean;

	/** Issues found during validation */
	issues: PlanValidationIssue[];

	/** Executor availability check results */
	executorAvailability: Map<string, ExecutorAvailabilityResult>;

	/** Tool availability check results */
	toolAvailability: Map<string, boolean>;

	/** Permission check results */
	permissionChecks: Map<string, PermissionCheckResult>;

	/** Dependency analysis results */
	dependencyAnalysis: DependencyAnalysisResult;

	/** Estimated metrics */
	estimates: PlanEstimates;

	/** Suggestions for improving the plan */
	suggestions: PlanSuggestion[];
}

export interface PlanValidationIssue {
	stepId: string;
	severity: "error" | "warning" | "info";
	code: string;
	message: string;
	suggestion?: string;
}

export interface ExecutorAvailabilityResult {
	available: boolean;
	reason?: string;
	healthStatus?: "healthy" | "degraded" | "unhealthy";
	capabilities?: AgentCardCapabilities;
}

export interface PermissionCheckResult {
	hasPermission: boolean;
	missingPermissions: string[];
}

export interface DependencyAnalysisResult {
	/** Dependencies that cannot be resolved */
	unresolvedDependencies: string[];
	/** Circular dependency chains found */
	circularDependencies: string[][];
	/** Dependency graph for visualization */
	dependencyGraph: Map<string, string[]>;
	/** Execution order (topologically sorted) */
	executionOrder: string[];
}

export interface PlanEstimates {
	/** Estimated total duration in milliseconds */
	estimatedDurationMs: number;
	/** Estimated token usage */
	estimatedTokenUsage: number;
	/** Estimated cost (if applicable) */
	estimatedCost?: number;
	/** Confidence in estimates (0-1) */
	confidence: number;
}

export interface PlanSuggestion {
	type: "optimization" | "safety" | "efficiency";
	stepId?: string;
	message: string;
	priority: "low" | "medium" | "high";
}

export interface ValidatePlanInput {
	plan: TaskPlan;
	routingDecision: RoutingDecision;
	userId: string;
	organizationId?: string;
	enabledMcpConfigIds?: string[] | null;
	enabledAgentIds?: string[] | null;
}

// =============================================================================
// Plan Validator
// =============================================================================

/**
 * Validates a task plan before execution.
 */
export async function validatePlan(
	input: ValidatePlanInput,
): Promise<PlanValidationResult> {
	const {
		plan,
		routingDecision,
		userId,
		organizationId,
		enabledMcpConfigIds,
		enabledAgentIds,
	} = input;

	logger.info(`[PlanValidator] Validating plan: ${plan.id}`);

	const issues: PlanValidationIssue[] = [];
	const suggestions: PlanSuggestion[] = [];

	// 1. Check executor availability
	const executorAvailability = await checkExecutorAvailability(
		plan.steps,
		userId,
		organizationId,
		enabledAgentIds,
	);

	// 2. Check tool availability
	const toolAvailability = await checkToolAvailability(
		plan.steps,
		userId,
		organizationId,
		enabledMcpConfigIds,
	);

	// 3. Analyze dependencies
	const dependencyAnalysis = analyzeDependencies(plan.steps);

	// 4. Check permissions
	const permissionChecks = await checkPermissions(
		plan.steps,
		executorAvailability,
		userId,
		organizationId,
	);

	// 5. Validate step inputs/outputs
	const ioIssues = validateStepIO(plan.steps);
	issues.push(...ioIssues);

	// 6. Validate risk levels
	const riskIssues = validateRiskLevels(plan.steps, routingDecision);
	issues.push(...riskIssues);

	// 7. Check for executor availability issues
	for (const [executorId, result] of executorAvailability) {
		if (!result.available) {
			issues.push({
				stepId: findStepWithExecutor(plan.steps, executorId),
				severity: "error",
				code: "EXECUTOR_UNAVAILABLE",
				message: `Executor '${executorId}' is not available: ${result.reason}`,
				suggestion:
					"Consider using an alternative agent or removing this step",
			});
		} else if (result.healthStatus === "degraded") {
			issues.push({
				stepId: findStepWithExecutor(plan.steps, executorId),
				severity: "warning",
				code: "EXECUTOR_DEGRADED",
				message: `Executor '${executorId}' is in degraded state`,
				suggestion: "Execution may be slower or less reliable",
			});
		}
	}

	// 8. Check for dependency issues
	if (dependencyAnalysis.unresolvedDependencies.length > 0) {
		issues.push({
			stepId: dependencyAnalysis.unresolvedDependencies[0],
			severity: "error",
			code: "UNRESOLVED_DEPENDENCY",
			message: `Unresolved dependencies: ${dependencyAnalysis.unresolvedDependencies.join(", ")}`,
			suggestion: "Add missing steps or remove dependencies",
		});
	}

	if (dependencyAnalysis.circularDependencies.length > 0) {
		for (const cycle of dependencyAnalysis.circularDependencies) {
			issues.push({
				stepId: cycle[0],
				severity: "error",
				code: "CIRCULAR_DEPENDENCY",
				message: `Circular dependency detected: ${cycle.join(" -> ")}`,
				suggestion: "Restructure steps to remove circular dependencies",
			});
		}
	}

	// 9. Generate suggestions
	suggestions.push(
		...generateSuggestions(
			plan.steps,
			executorAvailability,
			dependencyAnalysis,
		),
	);

	// 10. Calculate estimates
	const estimates = calculateEstimates(plan.steps, executorAvailability);

	// Determine overall validity
	const isValid = !issues.some((i) => i.severity === "error");

	logger.info("[PlanValidator] Validation complete", {
		isValid,
		issueCount: issues.length,
		errorCount: issues.filter((i) => i.severity === "error").length,
		warningCount: issues.filter((i) => i.severity === "warning").length,
	});

	return {
		isValid,
		issues,
		executorAvailability,
		toolAvailability,
		permissionChecks,
		dependencyAnalysis,
		estimates,
		suggestions,
	};
}

// =============================================================================
// Validation Checks
// =============================================================================

async function checkExecutorAvailability(
	steps: TaskStep[],
	userId: string,
	organizationId?: string,
	enabledAgentIds?: string[] | null,
): Promise<Map<string, ExecutorAvailabilityResult>> {
	const results = new Map<string, ExecutorAvailabilityResult>();
	const executorIds = new Set(
		steps.map((s) => s.executor).filter(Boolean) as string[],
	);

	for (const executorId of executorIds) {
		// Skip special executors
		if (executorId === "mcp_direct" || executorId === "llm") {
			results.set(executorId, {
				available: true,
				healthStatus: "healthy",
			});
			continue;
		}

		// Check if agent is enabled
		if (enabledAgentIds && !enabledAgentIds.includes(executorId)) {
			results.set(executorId, {
				available: false,
				reason: "Agent is not enabled in user preferences",
			});
			continue;
		}

		// Check if agent exists and is reachable
		try {
			const agent = await resolveAgentEndpoint(
				executorId,
				userId,
				organizationId,
			);
			if (!agent) {
				results.set(executorId, {
					available: false,
					reason: "Agent not found in registry",
				});
				continue;
			}

			// Get capabilities
			const capabilities = await getAgentCapabilities(
				executorId,
				userId,
				organizationId,
			);

			results.set(executorId, {
				available: true,
				healthStatus: "healthy",
				capabilities: capabilities || undefined,
			});
		} catch (error) {
			results.set(executorId, {
				available: false,
				reason:
					error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	return results;
}

async function checkToolAvailability(
	steps: TaskStep[],
	_userId: string,
	_organizationId?: string,
	enabledMcpConfigIds?: string[] | null,
): Promise<Map<string, boolean>> {
	const results = new Map<string, boolean>();

	// Collect all tools mentioned in steps
	const toolNames = new Set<string>();
	for (const step of steps) {
		if (step.toolsToUse) {
			step.toolsToUse.forEach((t) => {
				toolNames.add(t);
			});
		}
		if (step.app && step.capability === "mcp_tool") {
			toolNames.add(step.app);
		}
	}

	// If MCP is disabled, all tools are unavailable
	if (
		Array.isArray(enabledMcpConfigIds) &&
		enabledMcpConfigIds.length === 0
	) {
		for (const tool of toolNames) {
			results.set(tool, false);
		}
		return results;
	}

	// Check each tool
	// For now, assume tools are available if MCP configs are enabled
	// TODO: Actually check tool existence by querying MCP servers
	for (const tool of toolNames) {
		results.set(tool, true);
	}

	return results;
}

async function checkPermissions(
	steps: TaskStep[],
	executorAvailability: Map<string, ExecutorAvailabilityResult>,
	_userId: string,
	_organizationId?: string,
): Promise<Map<string, PermissionCheckResult>> {
	const results = new Map<string, PermissionCheckResult>();

	for (const step of steps) {
		const missingPermissions: string[] = [];

		// Check executor-specific permissions
		if (step.executor) {
			const executor = executorAvailability.get(step.executor);
			if (executor?.capabilities) {
				// Check if executor has required capabilities for the step type
				if (
					step.type === "browser" &&
					!executor.capabilities.browserAutomation
				) {
					missingPermissions.push("browser_automation");
				}
				if (
					step.type === "api" &&
					!executor.capabilities.hasMcpAccess
				) {
					missingPermissions.push("mcp_access");
				}
			}
		}

		// Check risk-level permissions
		if (step.riskLevel === "critical" || step.riskLevel === "high") {
			// These require approval, not a permission issue
		}

		results.set(step.id, {
			hasPermission: missingPermissions.length === 0,
			missingPermissions,
		});
	}

	return results;
}

function analyzeDependencies(steps: TaskStep[]): DependencyAnalysisResult {
	const dependencyGraph = new Map<string, string[]>();
	const unresolvedDependencies: string[] = [];
	const stepIds = new Set(steps.map((s) => s.id));

	// Build dependency graph
	for (const step of steps) {
		const deps: string[] = [];

		// Extract dependencies from inputs
		if (step.inputs) {
			const inputs = step.inputs as Record<string, unknown>;

			// Check contextInputs
			if (inputs.contextInputs && Array.isArray(inputs.contextInputs)) {
				for (const dep of inputs.contextInputs) {
					const depStr = String(dep);
					// Handle patterns like "step-*" or "research.*"
					if (depStr.includes("*")) {
						const pattern = depStr.replace("*", "");
						const matchingSteps = steps.filter((s) =>
							s.id.startsWith(pattern),
						);
						deps.push(...matchingSteps.map((s) => s.id));
					} else if (stepIds.has(depStr)) {
						deps.push(depStr);
					}
				}
			}
		}

		// Add dependency from order (previous step)
		const prevStep = steps.find((s) => s.order === step.order - 1);
		if (prevStep && !deps.includes(prevStep.id)) {
			deps.push(prevStep.id);
		}

		dependencyGraph.set(step.id, deps);
	}

	// Check for unresolved dependencies
	for (const [stepId, deps] of dependencyGraph) {
		for (const dep of deps) {
			if (!stepIds.has(dep)) {
				unresolvedDependencies.push(`${stepId} -> ${dep}`);
			}
		}
	}

	// Detect circular dependencies using DFS
	const circularDependencies = detectCircularDependencies(dependencyGraph);

	// Calculate execution order (topological sort)
	const executionOrder = topologicalSort(dependencyGraph);

	return {
		unresolvedDependencies,
		circularDependencies,
		dependencyGraph,
		executionOrder,
	};
}

function detectCircularDependencies(graph: Map<string, string[]>): string[][] {
	const cycles: string[][] = [];
	const visited = new Set<string>();
	const recursionStack = new Set<string>();
	const path: string[] = [];

	function dfs(node: string): boolean {
		visited.add(node);
		recursionStack.add(node);
		path.push(node);

		const neighbors = graph.get(node) || [];
		for (const neighbor of neighbors) {
			if (!visited.has(neighbor)) {
				if (dfs(neighbor)) {
					return true;
				}
			} else if (recursionStack.has(neighbor)) {
				// Found cycle
				const cycleStart = path.indexOf(neighbor);
				cycles.push([...path.slice(cycleStart), neighbor]);
				return true;
			}
		}

		recursionStack.delete(node);
		path.pop();
		return false;
	}

	for (const node of graph.keys()) {
		if (!visited.has(node)) {
			dfs(node);
		}
	}

	return cycles;
}

function topologicalSort(graph: Map<string, string[]>): string[] {
	const inDegree = new Map<string, number>();
	const result: string[] = [];

	// Initialize in-degrees
	for (const node of graph.keys()) {
		inDegree.set(node, 0);
	}

	// Calculate in-degrees
	for (const [, neighbors] of graph) {
		for (const neighbor of neighbors) {
			inDegree.set(neighbor, (inDegree.get(neighbor) || 0) + 1);
		}
	}

	// Find nodes with no incoming edges
	const queue: string[] = [];
	for (const [node, degree] of inDegree) {
		if (degree === 0) {
			queue.push(node);
		}
	}

	// Process nodes
	while (queue.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: queue.shift() is non-null since queue.length > 0 was checked
		const node = queue.shift()!;
		result.push(node);

		const neighbors = graph.get(node) || [];
		for (const neighbor of neighbors) {
			const newDegree = (inDegree.get(neighbor) || 0) - 1;
			inDegree.set(neighbor, newDegree);
			if (newDegree === 0) {
				queue.push(neighbor);
			}
		}
	}

	return result;
}

function validateStepIO(steps: TaskStep[]): PlanValidationIssue[] {
	const issues: PlanValidationIssue[] = [];

	for (const step of steps) {
		// Check for empty description
		if (!step.description || step.description.trim().length === 0) {
			issues.push({
				stepId: step.id,
				severity: "error",
				code: "EMPTY_DESCRIPTION",
				message: "Step has no description",
				suggestion:
					"Add a clear description of what this step should accomplish",
			});
		}

		// Check for very long descriptions (might be including data)
		if (step.description && step.description.length > 1000) {
			issues.push({
				stepId: step.id,
				severity: "warning",
				code: "LONG_DESCRIPTION",
				message:
					"Step description is very long (may include data that should be in inputs)",
				suggestion: "Move large data to step inputs",
			});
		}

		// Check for missing executor on agent-type steps
		if (step.capability === "agent" && !step.executor) {
			issues.push({
				stepId: step.id,
				severity: "warning",
				code: "MISSING_EXECUTOR",
				message: "Agent step has no executor specified",
				suggestion: "Specify which agent should execute this step",
			});
		}

		// Check for research steps without tools
		if (
			step.type === "research" &&
			(!step.toolsToUse || step.toolsToUse.length === 0)
		) {
			issues.push({
				stepId: step.id,
				severity: "info",
				code: "RESEARCH_NO_TOOLS",
				message: "Research step has no tools specified",
				suggestion:
					"Consider specifying which tools to use for research (e.g., firecrawl_search)",
			});
		}
	}

	return issues;
}

function validateRiskLevels(
	steps: TaskStep[],
	_routingDecision: RoutingDecision,
): PlanValidationIssue[] {
	const issues: PlanValidationIssue[] = [];

	for (const step of steps) {
		// Check for risk level inconsistency
		if (step.riskLevel === "critical" && !step.requiresApproval) {
			issues.push({
				stepId: step.id,
				severity: "warning",
				code: "CRITICAL_NO_APPROVAL",
				message: "Critical-risk step does not require approval",
				suggestion:
					"Consider requiring approval for critical operations",
			});
		}

		// Check for risk level mismatch with executor capabilities
		if (step.executor && step.riskLevel === "low") {
			const descLower = step.description.toLowerCase();
			if (
				descLower.includes("delete") ||
				descLower.includes("remove") ||
				descLower.includes("destroy")
			) {
				issues.push({
					stepId: step.id,
					severity: "warning",
					code: "RISK_LEVEL_MISMATCH",
					message:
						"Step appears to be a destructive operation but is marked as low risk",
					suggestion:
						"Review and update risk level if this is a destructive operation",
				});
			}
		}
	}

	return issues;
}

function findStepWithExecutor(steps: TaskStep[], executorId: string): string {
	const step = steps.find((s) => s.executor === executorId);
	return step?.id || "unknown";
}

function generateSuggestions(
	steps: TaskStep[],
	_executorAvailability: Map<string, ExecutorAvailabilityResult>,
	dependencyAnalysis: DependencyAnalysisResult,
): PlanSuggestion[] {
	const suggestions: PlanSuggestion[] = [];

	// Check for parallelization opportunities
	const parallelizableGroups = findParallelizableSteps(
		steps,
		dependencyAnalysis.dependencyGraph,
	);
	if (parallelizableGroups.length > 0) {
		suggestions.push({
			type: "efficiency",
			message: `${parallelizableGroups.length} group(s) of steps could be executed in parallel`,
			priority: "medium",
		});
	}

	// Check for redundant steps
	const similarSteps = findSimilarSteps(steps);
	if (similarSteps.length > 0) {
		suggestions.push({
			type: "optimization",
			message: `Found ${similarSteps.length} potentially redundant step(s) with similar descriptions`,
			priority: "low",
		});
	}

	// Check for inefficient executor usage
	const executorCounts = new Map<string, number>();
	for (const step of steps) {
		if (step.executor) {
			executorCounts.set(
				step.executor,
				(executorCounts.get(step.executor) || 0) + 1,
			);
		}
	}

	for (const [executor, count] of executorCounts) {
		if (count > 5) {
			suggestions.push({
				type: "efficiency",
				message: `Executor '${executor}' is used ${count} times - consider batching operations`,
				priority: "low",
			});
		}
	}

	return suggestions;
}

function findParallelizableSteps(
	steps: TaskStep[],
	dependencyGraph: Map<string, string[]>,
): string[][] {
	const groups: string[][] = [];
	const visited = new Set<string>();

	for (const step of steps) {
		if (visited.has(step.id)) {
			continue;
		}

		const deps = dependencyGraph.get(step.id) || [];

		// Find other steps with the same dependencies
		const parallelSteps = steps.filter((s) => {
			if (s.id === step.id || visited.has(s.id)) {
				return false;
			}
			const sDeps = dependencyGraph.get(s.id) || [];
			// Same dependencies and not dependent on each other
			return (
				JSON.stringify(deps.sort()) === JSON.stringify(sDeps.sort()) &&
				!deps.includes(s.id) &&
				!sDeps.includes(step.id)
			);
		});

		if (parallelSteps.length > 0) {
			const group = [step.id, ...parallelSteps.map((s) => s.id)];
			groups.push(group);
			group.forEach((id) => {
				visited.add(id);
			});
		} else {
			visited.add(step.id);
		}
	}

	return groups.filter((g) => g.length > 1);
}

function findSimilarSteps(steps: TaskStep[]): Array<[string, string]> {
	const similar: Array<[string, string]> = [];

	for (let i = 0; i < steps.length; i++) {
		for (let j = i + 1; j < steps.length; j++) {
			const similarity = calculateTextSimilarity(
				steps[i].description,
				steps[j].description,
			);
			if (similarity > 0.8) {
				similar.push([steps[i].id, steps[j].id]);
			}
		}
	}

	return similar;
}

function calculateTextSimilarity(text1: string, text2: string): number {
	const words1 = new Set(text1.toLowerCase().split(/\s+/));
	const words2 = new Set(text2.toLowerCase().split(/\s+/));

	const intersection = new Set([...words1].filter((x) => words2.has(x)));
	const union = new Set([...words1, ...words2]);

	return intersection.size / union.size;
}

function calculateEstimates(
	steps: TaskStep[],
	executorAvailability: Map<string, ExecutorAvailabilityResult>,
): PlanEstimates {
	let totalDurationMs = 0;
	let totalTokens = 0;

	// Base estimates per step type
	const durationEstimates: Record<string, number> = {
		research: 30000, // 30 seconds
		generate: 45000, // 45 seconds
		api: 10000, // 10 seconds
		browser: 60000, // 60 seconds
		verify: 20000, // 20 seconds
		hybrid: 45000, // 45 seconds
		agent: 30000, // 30 seconds
		workflow: 60000, // 60 seconds
	};

	const tokenEstimates: Record<string, number> = {
		research: 2000,
		generate: 4000,
		api: 500,
		browser: 1000,
		verify: 1500,
		hybrid: 3000,
		agent: 2500,
		workflow: 1000,
	};

	for (const step of steps) {
		const stepType = step.type || "generate";
		totalDurationMs += durationEstimates[stepType] || 30000;
		totalTokens += tokenEstimates[stepType] || 2000;
	}

	// Adjust for executor availability
	for (const [executorId, result] of executorAvailability) {
		if (result.healthStatus === "degraded") {
			// Add 50% overhead for degraded executors
			const affectedSteps = steps.filter(
				(s) => s.executor === executorId,
			);
			totalDurationMs += affectedSteps.length * 15000;
		}
	}

	return {
		estimatedDurationMs: totalDurationMs,
		estimatedTokenUsage: totalTokens,
		confidence: 0.7, // Medium confidence for estimates
	};
}
