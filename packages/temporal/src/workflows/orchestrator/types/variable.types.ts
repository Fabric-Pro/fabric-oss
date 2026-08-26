/**
 * Variable Types
 *
 * Defines cross-agent variable management types.
 * Used for sharing data between agents and steps during execution.
 */

// =============================================================================
// Agent Variable
// =============================================================================

export interface AgentVariable {
	name: string;
	value: unknown;
	/** Which agent set this variable */
	setBy: string;
	/** When this variable was set */
	setAt: string;
	/** Scope: workflow-wide or step-specific */
	scope: "workflow" | "step";
	/** Step ID if scope is step */
	stepId?: string;
	/** Whether this variable is read-only */
	readonly?: boolean;
}

// =============================================================================
// Variable Context
// =============================================================================

export interface VariableContext {
	/** Workflow-scoped variables accessible by all agents */
	workflowVariables: Record<string, AgentVariable>;
	/** Step-scoped variables (cleared after step) */
	stepVariables: Record<string, AgentVariable>;
	/** System variables (readonly) */
	systemVariables: Record<string, AgentVariable>;
}
