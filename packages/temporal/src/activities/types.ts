/**
 * Workflow Builder Execution Types
 */

import type { AiJobKey } from "@repo/ai";

/**
 * Result of executing a workflow node/step
 */
export interface NodeExecutionResult {
	success: boolean;
	output?: Record<string, unknown>;
	error?: string;
}

/**
 * Parameters passed to step functions
 */
export interface StepParams {
	nodeConfig: Record<string, unknown>;
	inputs: Record<string, unknown>;
	userId: string;
	organizationId?: string;
	projectId?: string;
	/** The workflow the node belongs to; absent for steps run outside a builder execution. */
	workflowId?: string;
	/** The `WorkflowExecution` row the node runs under. */
	executionId?: string;
	/** The node's id within the workflow graph. */
	nodeId?: string;
	/** Background-attribution label set by the executing pipeline (Fizzy #1894). */
	jobType?: AiJobKey;
}
