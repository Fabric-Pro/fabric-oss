/**
 * Pre-flight Validation Activity
 *
 * CUGA-inspired pre-execution validation for workflow steps.
 * Validates that all requirements are met before executing a step.
 *
 * Features:
 * - Input parameter validation
 * - Dependency checks
 * - Resource availability verification
 * - Risk assessment for high-risk operations
 * - Human approval triggers for critical steps
 * - Graph-level validation (empty graph, cycles, missing types)
 */

import { db } from "@repo/database";
import {
	createApproval,
	getApprovalStatus,
} from "@repo/database/prisma/queries/approvals";

// ============================================================================
// Graph-Level Validation Types
// ============================================================================

export interface GraphValidationInput {
	workflowId: string;
	nodes: GraphNode[];
	edges: GraphEdge[];
	userId: string;
	organizationId?: string;
}

export interface GraphNode {
	id: string;
	type: string;
	data?: Record<string, unknown>;
}

export interface GraphEdge {
	id: string;
	source: string;
	target: string;
}

export interface GraphValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
	hasCycles: boolean;
	cycleNodes?: string[];
	orphanedNodes: string[];
	missingNodeTypes: string[];
	executionOrder: string[];
}

// ============================================================================
// Step-Level Validation Types
// ============================================================================

export interface PreflightValidationInput {
	/** Workflow execution ID */
	executionId: string;
	/** Step/node being validated */
	stepId: string;
	/** Step type (e.g., "http-request", "ai-generate-text") */
	stepType: string;
	/** Step configuration */
	stepConfig: Record<string, unknown>;
	/** User ID for permission checks */
	userId: string;
	/** Organization ID for tenant scoping */
	organizationId?: string;
	/** Risk level of the step (0-100) */
	riskScore?: number;
	/** Whether to require human approval for high-risk steps */
	requireApprovalForHighRisk?: boolean;
	/** Threshold for triggering approval (default: 70) */
	approvalThreshold?: number;
}

export interface PreflightValidationResult {
	/** Whether validation passed */
	valid: boolean;
	/** Whether human approval is required */
	requiresApproval: boolean;
	/** Approval request ID if approval is needed */
	approvalRequestId?: string;
	/** List of validation issues */
	issues: ValidationIssue[];
	/** Warnings that don't block execution */
	warnings: string[];
	/** Validated/transformed configuration */
	validatedConfig: Record<string, unknown>;
	/** Risk assessment */
	riskAssessment?: RiskAssessment;
}

export interface ValidationIssue {
	field: string;
	message: string;
	severity: "error" | "warning" | "info";
}

export interface RiskAssessment {
	score: number;
	category: "low" | "medium" | "high" | "critical";
	factors: string[];
	mitigations: string[];
}

// ============================================================================
// Validation Rules by Step Type
// ============================================================================

interface ValidationRule {
	check: (config: Record<string, unknown>) => ValidationIssue | null;
}

const STEP_VALIDATION_RULES: Record<string, ValidationRule[]> = {
	"http-request": [
		{
			check: (config) => {
				if (!config.url) {
					return {
						field: "url",
						message: "URL is required",
						severity: "error",
					};
				}
				return null;
			},
		},
		{
			check: (config) => {
				const url = config.url as string;
				if (
					url &&
					!url.startsWith("http://") &&
					!url.startsWith("https://")
				) {
					return {
						field: "url",
						message: "URL must start with http:// or https://",
						severity: "error",
					};
				}
				return null;
			},
		},
		{
			check: (config) => {
				const method = config.method as string;
				if (
					method &&
					!["GET", "POST", "PUT", "DELETE", "PATCH"].includes(
						method.toUpperCase(),
					)
				) {
					return {
						field: "method",
						message: "Invalid HTTP method",
						severity: "error",
					};
				}
				return null;
			},
		},
	],
	"ai-generate-text": [
		{
			check: (config) => {
				// Check all possible prompt field names (workflow builder uses "aiPrompt", SDK uses "prompt"/"systemPrompt")
				// Also check for empty strings
				const prompt = config.prompt as string | undefined;
				const systemPrompt = config.systemPrompt as string | undefined;
				const aiPrompt = config.aiPrompt as string | undefined;

				const hasValidPrompt =
					(prompt && prompt.trim().length > 0) ||
					(systemPrompt && systemPrompt.trim().length > 0) ||
					(aiPrompt && aiPrompt.trim().length > 0);

				if (!hasValidPrompt) {
					console.log(
						"[Preflight] ai-generate-text validation failed. Config keys:",
						Object.keys(config),
					);
					console.log("[Preflight] Config values:", {
						prompt,
						systemPrompt,
						aiPrompt,
					});
					return {
						field: "prompt",
						message: "Prompt is required",
						severity: "error",
					};
				}
				return null;
			},
		},
		{
			check: (config) => {
				const temperature = config.temperature as number;
				if (
					temperature !== undefined &&
					(temperature < 0 || temperature > 2)
				) {
					return {
						field: "temperature",
						message: "Temperature must be between 0 and 2",
						severity: "warning",
					};
				}
				return null;
			},
		},
	],
	"slack-send": [
		{
			check: (config) => {
				// Workflow builder uses "slackChannel", SDK may use "channel" or "channelId"
				const slackChannel = config.slackChannel as string | undefined;
				const channel = config.channel as string | undefined;
				const channelId = config.channelId as string | undefined;

				const hasChannel =
					(slackChannel && slackChannel.trim().length > 0) ||
					(channel && channel.trim().length > 0) ||
					(channelId && channelId.trim().length > 0);

				if (!hasChannel) {
					return {
						field: "channel",
						message: "Slack channel is required",
						severity: "error",
					};
				}
				return null;
			},
		},
		{
			check: (config) => {
				// Workflow builder uses "slackMessage", SDK may use "message" or "text"
				const slackMessage = config.slackMessage as string | undefined;
				const message = config.message as string | undefined;
				const text = config.text as string | undefined;

				const hasMessage =
					(slackMessage && slackMessage.trim().length > 0) ||
					(message && message.trim().length > 0) ||
					(text && text.trim().length > 0);

				if (!hasMessage) {
					return {
						field: "message",
						message: "Message content is required",
						severity: "error",
					};
				}
				return null;
			},
		},
	],
	"linear-create-ticket": [
		{
			check: (config) => {
				// Workflow builder uses "ticketTitle", SDK may use "title"
				const ticketTitle = config.ticketTitle as string | undefined;
				const title = config.title as string | undefined;

				const hasTitle =
					(ticketTitle && ticketTitle.trim().length > 0) ||
					(title && title.trim().length > 0);

				if (!hasTitle) {
					return {
						field: "title",
						message: "Ticket title is required",
						severity: "error",
					};
				}
				return null;
			},
		},
	],
	"browser-automation": [
		{
			check: (config) => {
				if (!config.url && !config.startUrl) {
					return {
						field: "url",
						message: "Starting URL is required",
						severity: "error",
					};
				}
				return null;
			},
		},
		{
			check: (config) => {
				const actions = config.actions as unknown[];
				if (
					!actions ||
					!Array.isArray(actions) ||
					actions.length === 0
				) {
					return {
						field: "actions",
						message: "At least one browser action is required",
						severity: "error",
					};
				}
				return null;
			},
		},
	],
};

// ============================================================================
// Risk Assessment
// ============================================================================

/**
 * High-risk step types that may require approval
 */
const HIGH_RISK_STEP_TYPES = [
	"http-request", // External API calls
	"slack-send", // External communication
	"email-send", // Email sending
	"linear-create-ticket", // Creating external records
	"browser-automation", // Browser automation
	"database-query", // Database operations
	"file-delete", // Destructive operations
];

/**
 * Assess the risk of a step
 */
function assessRisk(
	stepType: string,
	config: Record<string, unknown>,
	providedRiskScore?: number,
): RiskAssessment {
	const factors: string[] = [];
	const mitigations: string[] = [];
	let score = providedRiskScore ?? 0;

	// Base risk from step type
	if (HIGH_RISK_STEP_TYPES.includes(stepType)) {
		score += 30;
		factors.push(`Step type "${stepType}" is inherently risky`);
	}

	// HTTP requests to external domains
	if (stepType === "http-request") {
		const url = config.url as string;
		if (url && !url.includes("localhost") && !url.includes("127.0.0.1")) {
			score += 20;
			factors.push("Makes external HTTP request");
			mitigations.push("Consider using API rate limiting");
		}
		const method = ((config.method as string) || "GET").toUpperCase();
		if (["POST", "PUT", "DELETE", "PATCH"].includes(method)) {
			score += 15;
			factors.push(`Uses mutating HTTP method: ${method}`);
			mitigations.push("Verify the target API endpoint is correct");
		}
	}

	// AI generation with high temperature
	if (stepType === "ai-generate-text") {
		const temperature = config.temperature as number;
		if (temperature && temperature > 1.2) {
			score += 10;
			factors.push("High temperature may produce unpredictable outputs");
			mitigations.push(
				"Consider lowering temperature for more consistent results",
			);
		}
	}

	// Browser automation
	if (stepType === "browser-automation") {
		score += 25;
		factors.push("Browser automation can interact with external websites");
		mitigations.push("Ensure target website is trusted");
		mitigations.push("Use headless mode when possible");
	}

	// Determine category
	let category: RiskAssessment["category"];
	if (score >= 80) {
		category = "critical";
	} else if (score >= 60) {
		category = "high";
	} else if (score >= 40) {
		category = "medium";
	} else {
		category = "low";
	}

	return {
		score: Math.min(score, 100),
		category,
		factors,
		mitigations,
	};
}

// ============================================================================
// Main Activity
// ============================================================================

/**
 * Pre-flight validation activity
 *
 * Validates a workflow step before execution:
 * 1. Validates input parameters against rules
 * 2. Assesses risk level
 * 3. Triggers human approval if needed
 * 4. Returns validated configuration
 */
export async function preflightValidation(
	input: PreflightValidationInput,
): Promise<PreflightValidationResult> {
	console.log(
		`[Preflight] Validating step: ${input.stepId} (${input.stepType})`,
	);

	const issues: ValidationIssue[] = [];
	const warnings: string[] = [];
	const validatedConfig = { ...input.stepConfig };

	// Step 1: Run validation rules for this step type
	const rules = STEP_VALIDATION_RULES[input.stepType] || [];
	for (const rule of rules) {
		const issue = rule.check(input.stepConfig);
		if (issue) {
			if (issue.severity === "warning") {
				warnings.push(issue.message);
			} else {
				issues.push(issue);
			}
		}
	}

	// Step 2: Assess risk
	const riskAssessment = assessRisk(
		input.stepType,
		input.stepConfig,
		input.riskScore,
	);

	// Add risk-based warnings
	for (const mitigation of riskAssessment.mitigations) {
		warnings.push(`Risk mitigation: ${mitigation}`);
	}

	// Step 3: Check if approval is required
	const approvalThreshold = input.approvalThreshold ?? 70;
	const requiresApproval =
		input.requireApprovalForHighRisk &&
		riskAssessment.score >= approvalThreshold;

	let approvalRequestId: string | undefined;

	if (requiresApproval) {
		console.log(
			`[Preflight] Step ${input.stepId} requires human approval (risk: ${riskAssessment.score})`,
		);

		// Create an approval request in the database
		// This would integrate with the AgentApproval table
		// For now, we log and set the flag
		// In a full implementation, this would create a HITL request

		// Generate a mock approval ID - in production this would be a real DB record
		approvalRequestId = `approval_${Date.now()}_${input.stepId}`;

		warnings.push(
			`Human approval required (risk score: ${riskAssessment.score})`,
		);
	}

	// Step 4: Determine if validation passed
	const hasErrors = issues.some((i) => i.severity === "error");
	const valid = !hasErrors;

	console.log(
		`[Preflight] Validation ${valid ? "passed" : "failed"} for step ${input.stepId}`,
	);
	if (!valid) {
		console.log(
			`[Preflight] Issues: ${issues.map((i) => i.message).join(", ")}`,
		);
	}

	return {
		valid,
		requiresApproval: requiresApproval ?? false,
		approvalRequestId,
		issues,
		warnings,
		validatedConfig,
		riskAssessment,
	};
}

/**
 * Wait for human approval
 *
 * This activity checks if a pending approval has been granted.
 * Polls the database for approval status with timeout.
 */
export async function waitForApproval(
	approvalRequestId: string,
	timeoutMs = 300000, // 5 minutes default
): Promise<{ approved: boolean; message?: string }> {
	console.log(`[Preflight] Waiting for approval: ${approvalRequestId}`);

	const startTime = Date.now();
	const pollInterval = 2000; // Poll every 2 seconds

	while (Date.now() - startTime < timeoutMs) {
		// Check approval status in database using query function
		const status = await getApprovalStatus(approvalRequestId);

		if (status) {
			if (status.status === "approved") {
				return { approved: true, message: "Approved by user" };
			}
			if (status.status === "rejected") {
				return {
					approved: false,
					message: status.feedback || "Rejected by user",
				};
			}
			if (status.status === "expired") {
				return { approved: false, message: "Approval request expired" };
			}
		}

		// Wait before next poll
		await new Promise((resolve) => setTimeout(resolve, pollInterval));
	}

	return {
		approved: false,
		message: `Approval timed out after ${timeoutMs / 1000} seconds`,
	};
}

/**
 * Create an approval request in the database
 *
 * Note: This requires an existing AgentTask to link to. For workflow executions,
 * create a task first or use the execution ID as a reference.
 */
export async function createApprovalRequest(input: {
	executionId: string;
	stepId: string;
	stepType: string;
	riskScore: number;
	riskFactors: string[];
	userId: string;
	organizationId?: string;
	taskId?: string;
}): Promise<string> {
	// If taskId is provided, use it; otherwise we need to create a temporary task
	// For now, we'll check if an AgentTask exists for this execution
	let taskId = input.taskId;

	if (!taskId) {
		// Look for an existing task with this execution ID
		const existingTask = await db.agentTask.findFirst({
			where: {
				userId: input.userId,
				workflowId: input.executionId,
			},
			select: { id: true },
		});

		if (existingTask) {
			taskId = existingTask.id;
		} else {
			// Create a temporary task for this approval
			const newTask = await db.agentTask.create({
				data: {
					userId: input.userId,
					organizationId: input.organizationId,
					agentId: "workflow-executor",
					status: "pending",
					stage: "approval",
					input: {
						executionId: input.executionId,
						stepId: input.stepId,
						stepType: input.stepType,
						riskScore: input.riskScore,
						riskFactors: input.riskFactors,
					},
					framework: "temporal",
					workflowId: input.executionId,
				},
			});
			taskId = newTask.id;
		}
	}

	// Create the approval request using the query function
	const approval = await createApproval({
		taskId,
		userId: input.userId,
		action: `Execute ${input.stepType} step: ${input.stepId}`,
		changes: {
			stepId: input.stepId,
			stepType: input.stepType,
			riskScore: input.riskScore,
			riskFactors: input.riskFactors,
		},
		confidence: 1 - input.riskScore / 100, // Convert risk to confidence
	});

	console.log(`[Preflight] Created approval request: ${approval.id}`);
	return approval.id;
}

// ============================================================================
// Graph-Level Validation
// ============================================================================

/**
 * Known node types that the workflow builder supports
 */
const KNOWN_NODE_TYPES = new Set([
	"trigger",
	"ai-generate-text",
	"http-request",
	"browser-automation",
	"firecrawl-scrape",
	"firecrawl-crawl",
	"linear-create-ticket",
	"slack-send",
	"email-send",
	"conditional",
	"loop",
	"delay",
	"transform",
	"output",
]);

/**
 * Detect cycles in the workflow graph using DFS
 */
function detectCycles(
	nodes: GraphNode[],
	edges: GraphEdge[],
): { hasCycles: boolean; cycleNodes: string[] } {
	const adjacencyList = new Map<string, string[]>();
	const nodeSet = new Set(nodes.map((n) => n.id));

	// Build adjacency list
	for (const node of nodes) {
		adjacencyList.set(node.id, []);
	}
	for (const edge of edges) {
		if (nodeSet.has(edge.source)) {
			adjacencyList.get(edge.source)?.push(edge.target);
		}
	}

	const visited = new Set<string>();
	const recursionStack = new Set<string>();
	const cycleNodes: string[] = [];

	function dfs(nodeId: string): boolean {
		visited.add(nodeId);
		recursionStack.add(nodeId);

		const neighbors = adjacencyList.get(nodeId) || [];
		for (const neighbor of neighbors) {
			if (!visited.has(neighbor)) {
				if (dfs(neighbor)) {
					cycleNodes.push(nodeId);
					return true;
				}
			} else if (recursionStack.has(neighbor)) {
				cycleNodes.push(neighbor);
				cycleNodes.push(nodeId);
				return true;
			}
		}

		recursionStack.delete(nodeId);
		return false;
	}

	for (const node of nodes) {
		if (!visited.has(node.id)) {
			if (dfs(node.id)) {
				return {
					hasCycles: true,
					cycleNodes: [...new Set(cycleNodes)],
				};
			}
		}
	}

	return { hasCycles: false, cycleNodes: [] };
}

/**
 * Get topological execution order of nodes
 */
function getExecutionOrder(nodes: GraphNode[], edges: GraphEdge[]): string[] {
	const inDegree = new Map<string, number>();
	const adjacencyList = new Map<string, string[]>();

	// Initialize
	for (const node of nodes) {
		inDegree.set(node.id, 0);
		adjacencyList.set(node.id, []);
	}

	// Build graph
	for (const edge of edges) {
		if (inDegree.has(edge.target)) {
			inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
		}
		adjacencyList.get(edge.source)?.push(edge.target);
	}

	// Kahn's algorithm
	const queue: string[] = [];
	const result: string[] = [];

	for (const [nodeId, degree] of inDegree) {
		if (degree === 0) {
			queue.push(nodeId);
		}
	}

	while (queue.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: queue.shift() is non-null since queue.length > 0 was checked
		const current = queue.shift()!;
		result.push(current);

		for (const neighbor of adjacencyList.get(current) || []) {
			const newDegree = (inDegree.get(neighbor) || 1) - 1;
			inDegree.set(neighbor, newDegree);
			if (newDegree === 0) {
				queue.push(neighbor);
			}
		}
	}

	return result;
}

/**
 * Validate the entire workflow graph before execution
 */
export async function validateWorkflowGraph(
	input: GraphValidationInput,
): Promise<GraphValidationResult> {
	console.log(`[Preflight] Validating workflow graph: ${input.workflowId}`);

	const errors: string[] = [];
	const warnings: string[] = [];

	// Check 1: Empty graph
	if (!input.nodes || input.nodes.length === 0) {
		errors.push("Workflow has no nodes. Add at least one node to execute.");
		return {
			valid: false,
			errors,
			warnings,
			hasCycles: false,
			orphanedNodes: [],
			missingNodeTypes: [],
			executionOrder: [],
		};
	}

	// Check 2: Missing node types
	const missingNodeTypes: string[] = [];
	for (const node of input.nodes) {
		if (!node.type) {
			errors.push(`Node ${node.id} has no type defined`);
			missingNodeTypes.push(node.id);
		} else if (!KNOWN_NODE_TYPES.has(node.type)) {
			warnings.push(`Node ${node.id} has unknown type: ${node.type}`);
		}
	}

	// Check 3: Orphaned nodes (not connected to any edges)
	const connectedNodes = new Set<string>();
	for (const edge of input.edges || []) {
		connectedNodes.add(edge.source);
		connectedNodes.add(edge.target);
	}

	const orphanedNodes: string[] = [];
	for (const node of input.nodes) {
		if (input.nodes.length > 1 && !connectedNodes.has(node.id)) {
			orphanedNodes.push(node.id);
			warnings.push(
				`Node ${node.id} is not connected to any other nodes`,
			);
		}
	}

	// Check 4: Cycle detection
	const { hasCycles, cycleNodes } = detectCycles(
		input.nodes,
		input.edges || [],
	);
	if (hasCycles) {
		errors.push(
			`Workflow contains cycles involving nodes: ${cycleNodes.join(", ")}. Remove circular dependencies.`,
		);
	}

	// Check 5: Get execution order (only if no cycles)
	const executionOrder = hasCycles
		? []
		: getExecutionOrder(input.nodes, input.edges || []);

	// Check 6: Verify execution order covers all nodes
	if (!hasCycles && executionOrder.length !== input.nodes.length) {
		warnings.push(
			"Some nodes may not be reachable from the start of the workflow",
		);
	}

	// Check 7: Ensure at least one trigger node exists
	const hasTrigger = input.nodes.some((n) => n.type === "trigger");
	if (!hasTrigger) {
		warnings.push(
			"Workflow has no trigger node. Execution will start from first node.",
		);
	}

	const valid = errors.length === 0;
	console.log(
		`[Preflight] Graph validation ${valid ? "passed" : "failed"}: ${errors.length} errors, ${warnings.length} warnings`,
	);

	return {
		valid,
		errors,
		warnings,
		hasCycles,
		cycleNodes: hasCycles ? cycleNodes : undefined,
		orphanedNodes,
		missingNodeTypes,
		executionOrder,
	};
}
