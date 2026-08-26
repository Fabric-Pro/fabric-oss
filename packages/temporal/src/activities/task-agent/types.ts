/**
 * Task Agent Types
 *
 * Shared types for task agent activities.
 */

// =============================================================================
// Plan Management Types
// =============================================================================

export interface InitializeWorkflowPlanInput {
	planId: string;
	taskId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	status: string;
}

export interface UpdateWorkflowPlanInput {
	planId: string;
	status?: string;
	steps?: unknown[];
	currentStepIndex?: number;
	checkpointData?: unknown | null;
	result?: unknown;
	summary?: string;
}

export interface AddWorkflowLogInput {
	planId: string;
	level: string;
	message: string;
	stepId?: string;
	metadata?: Record<string, unknown>;
}

// =============================================================================
// Agent Message Types
// =============================================================================

export type AgentMessage =
	| { role: "user"; content: string }
	| {
			role: "assistant";
			content: string | Array<{ type: string; [key: string]: unknown }>;
	  }
	| { role: "tool"; content: string; tool_call_id: string };

// =============================================================================
// Agent Execution Types
// =============================================================================

export interface ExecuteAgentTurnInput {
	planId: string;
	turnIndex: number;
	messages: AgentMessage[];
	mcpConfig: MCPConfiguration;
	userId: string;
	organizationId?: string;
	projectId?: string;
}

export interface ExecuteAgentTurnOutput {
	response: string;
	summary: string;
	toolCalls?: Array<{
		id: string;
		name: string;
		args: Record<string, unknown>;
	}>;
	stopReason: string;
}

// =============================================================================
// MCP Types
// =============================================================================

export interface ExecuteMcpToolInput {
	toolName: string;
	args: Record<string, unknown>;
	userId: string;
	organizationId?: string;
	mcpConfig: MCPConfiguration;
	/**
	 * Owning project — enables the Read-only mode write-gate on
	 * the external dispatch branches, and puts the id on args[0] where the
	 * project-context activity interceptor finds it.
	 */
	projectId?: string;
}

export interface LoadMcpConfigurationInput {
	userId: string;
	organizationId?: string;
}

export interface MCPConfiguration {
	tools: Array<{
		name: string;
		description: string;
		inputSchema: Record<string, unknown>;
		configId: string;
		serverName: string;
		/** Fields that must be present in approval data for this tool */
		approvalRequiredFields?: string[];
	}>;
}

// =============================================================================
// RAG Types
// =============================================================================

export interface RetrieveProjectContextsInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	taskTitle: string;
	taskDescription: string;
	limit?: number;
}

// =============================================================================
// Approval Types
// =============================================================================

export interface ValidateApprovalFieldsInput {
	toolName: string;
	data: Record<string, unknown>;
	mcpConfig: MCPConfiguration;
}

export type ValidateApprovalFieldsResult =
	| { valid: false; error: string; missingFields: string[] }
	| { valid: true };

// =============================================================================
// Broadcast Types
// =============================================================================

export interface BroadcastProgressInput {
	planId: string;
	projectId: string;
	type: string;
	data: Record<string, unknown>;
}
