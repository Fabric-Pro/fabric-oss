/**
 * Workflow Builder Execution Activities
 *
 * Activities for executing visual workflow nodes.
 * Based on Vercel workflow-builder-template patterns.
 *
 * Architecture:
 * - Uses a step registry pattern for scalability (like the Vercel template)
 * - Each node type has its own step file in ./lib/steps/
 * - Steps are lazy-loaded for better performance
 * - This file contains only the Temporal activity wrappers
 *
 * @see https://github.com/vercel-labs/workflow-builder-template
 */

import {
	createExecutionLog,
	db,
	getWorkflowById,
	isProjectReadOnly,
	type Prisma,
	updateExecutionLog,
	updateWorkflowExecution,
} from "@repo/database";
import { READ_ONLY_MODE_MESSAGE } from "@repo/utils/read-only-mode";
import { redactSensitiveData } from "./lib/redact-sensitive-data";
import {
	executeStep,
	hasStep,
	isExternalWriteNodeType,
} from "./lib/step-registry";
import { guardToolWriteForReadOnly } from "./shared/read-only-gate";
import type { NodeExecutionResult } from "./types";

/**
 * Get workflow definition
 */
export async function getWorkflowDefinition(params: {
	workflowId: string;
	userId: string;
	organizationId?: string;
}) {
	console.log("[Activity] Getting workflow definition:", params.workflowId);

	const workflow = await getWorkflowById(
		params.workflowId,
		params.userId,
		params.organizationId,
	);

	if (!workflow) {
		throw new Error("Workflow not found");
	}

	return workflow;
}

/**
 * Update workflow execution status
 */
export async function updateWorkflowExecutionStatus(params: {
	executionId: string;
	status: string;
	startedAt?: Date;
	completedAt?: Date;
	output?: Record<string, unknown>;
	error?: string;
	duration?: number;
}) {
	console.log(
		"[Activity] Updating execution status:",
		params.executionId,
		params.status,
	);

	await updateWorkflowExecution(params.executionId, {
		status: params.status as Prisma.EnumWorkflowExecutionStatusFieldUpdateOperationsInput["set"],
		startedAt: params.startedAt,
		completedAt: params.completedAt,
		output: params.output as Prisma.InputJsonValue | undefined,
		error: params.error,
		duration: params.duration,
	});
}

/**
 * Create workflow execution log entry
 * Redacts sensitive data before storing
 *
 * TENANT ISOLATION: userId and organizationId are required for proper tenant filtering.
 */
export async function createWorkflowExecutionLog(params: {
	executionId: string;
	nodeId: string;
	nodeType: string;
	status: string;
	input?: Record<string, unknown>;
	output?: Record<string, unknown>;
	error?: string;
	startedAt?: Date;
	completedAt?: Date;
	/** Wall-clock milliseconds the node took, recorded on the closing call. */
	duration?: number;
	// Tenant isolation fields
	userId: string;
	organizationId?: string;
}) {
	console.log(
		"[Activity] Creating execution log:",
		params.executionId,
		params.nodeId,
	);

	// Redact sensitive data from input and output before storing
	const redactedInput = params.input
		? (redactSensitiveData(params.input) as Record<string, unknown>)
		: undefined;
	const redactedOutput = params.output
		? (redactSensitiveData(params.output) as Record<string, unknown>)
		: undefined;

	const existing = await db.workflowExecutionLog.findFirst({
		where: {
			executionId: params.executionId,
			nodeId: params.nodeId,
		},
	});

	if (existing) {
		await updateExecutionLog(existing.id, {
			status: params.status as Prisma.EnumWorkflowNodeStatusFieldUpdateOperationsInput["set"],
			output: redactedOutput as Prisma.InputJsonValue | undefined,
			error: params.error,
			completedAt: params.completedAt,
			// The column existed and the panel rendered it, but nothing ever
			// wrote it: every per-node duration read null and the panel's
			// total was a sum of zeroes.
			duration: params.duration,
		});
	} else {
		await createExecutionLog({
			executionId: params.executionId,
			nodeId: params.nodeId,
			nodeType: params.nodeType,
			input: redactedInput as Prisma.InputJsonValue | undefined,
			userId: params.userId,
			organizationId: params.organizationId,
		});
	}
}

/**
 * Execute a single workflow node
 *
 * Uses the step registry pattern for scalability.
 * Each node type is handled by a dedicated step function in ./lib/steps/
 *
 * Benefits:
 * 1. Lazy loading - steps are imported only when needed
 * 2. Easy to add new steps - just add an entry to the registry
 * 3. Clear separation of concerns - each step is in its own file
 * 4. Type-safe - step functions have typed inputs and outputs
 * 5. Testable - individual steps can be unit tested
 */
export async function executeWorkflowNode(params: {
	executionId: string;
	nodeId: string;
	nodeType: string;
	nodeConfig: Record<string, unknown>;
	inputs: Record<string, unknown>;
	userId: string;
	organizationId?: string;
	/** Owning project when the workflow is project-linked — enables the Read-only mode write gate. */
	projectId?: string;
}): Promise<NodeExecutionResult> {
	const { withNodeLogging } = await import("./lib/node-logging");
	const { validateNodeConfig, isNodeTypeImplemented } = await import(
		"./lib/node-config-validator"
	);

	// Use the logging wrapper for consistent tracking
	return withNodeLogging(
		{
			executionId: params.executionId,
			nodeId: params.nodeId,
			nodeType: params.nodeType,
			nodeName: (params.nodeConfig.label as string) || undefined,
		},
		async () => {
			// Validate node configuration before execution
			const validation = validateNodeConfig(
				params.nodeType,
				params.nodeConfig,
			);

			if (!validation.valid) {
				return {
					success: false,
					error: validation.error || "Invalid node configuration",
				};
			}

			// Check if node type is registered. Fail closed: reporting success
			// for a node the worker cannot execute produced green runs that
			// did nothing, and let the registry drift from the plugin
			// definitions unnoticed.
			if (!hasStep(params.nodeType)) {
				const hint = isNodeTypeImplemented(params.nodeType)
					? ""
					: " (no step is registered for this node type)";
				return {
					success: false,
					error: `Unknown node type: ${params.nodeType}${hint}`,
				};
			}

			// Read-only mode: while the owning project is
			// read-only, steps that write to a connected external source must
			// not run. Membership in EXTERNAL_WRITE_NODE_TYPES decides — not
			// the shared name classifier, which would misread internal types
			// like "ai-generate-text" as writes.
			if (
				params.projectId &&
				isExternalWriteNodeType(params.nodeType) &&
				(await isProjectReadOnly(params.projectId))
			) {
				return { success: false, error: READ_ONLY_MODE_MESSAGE };
			}

			// The mcp-tool step dispatches an arbitrary tool on a connected
			// external MCP server (bypassing the gated `callMcpTool` funnel),
			// so gate it by the configured tool's own name via the shared
			// classifier.
			if (params.nodeType === "mcp-tool") {
				const toolName = params.nodeConfig.toolName;
				if (typeof toolName === "string" && toolName) {
					const blocked = await guardToolWriteForReadOnly(
						params.projectId ?? null,
						toolName,
					);
					if (blocked) {
						return { success: false, error: blocked.error };
					}
				}
			}

			// Execute the step using the registry
			return executeStep(params.nodeType, {
				nodeConfig: params.nodeConfig,
				inputs: params.inputs,
				userId: params.userId,
				organizationId: params.organizationId,
				projectId: params.projectId,
				jobType: "workflow-builder",
			});
		},
	);
}

// Re-export types for convenience
export type { NodeExecutionResult } from "./types";
