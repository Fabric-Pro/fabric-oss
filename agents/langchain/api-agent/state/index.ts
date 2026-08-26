/**
 * API Agent State Module
 *
 * Defines the LangGraph state annotation for the API Agent.
 * Compatible with AG-UI protocol for predictive updates.
 */

import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type {
	ApiAgentStage,
	OpenAPIToolDescriptor,
	ToolExecutionResult,
} from "../types";

/**
 * API Agent State Annotation
 *
 * State structure for managing OpenAPI tool execution workflow.
 */
export const ApiAgentState = Annotation.Root({
	// Inherit message handling from MessagesAnnotation
	...MessagesAnnotation.spec,

	/**
	 * Current execution stage
	 */
	stage: Annotation<ApiAgentStage>({
		reducer: (x: ApiAgentStage | undefined, y: ApiAgentStage | undefined) =>
			y ?? x ?? "analyzing",
		default: () => "analyzing",
	}),

	/**
	 * Task description extracted from user message
	 */
	taskDescription: Annotation<string | undefined>({
		reducer: (x: string | undefined, y: string | undefined) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Additional context for the task
	 */
	context: Annotation<string | undefined>({
		reducer: (x: string | undefined, y: string | undefined) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * OpenAPI tools loaded from Fabric
	 */
	availableTools: Annotation<OpenAPIToolDescriptor[]>({
		reducer: (
			x: OpenAPIToolDescriptor[] | undefined,
			y: OpenAPIToolDescriptor[] | undefined,
		) => y ?? x ?? [],
		default: () => [],
	}),

	/**
	 * Fabric API URL for loading and executing tools
	 */
	fabricApiUrl: Annotation<string | undefined>({
		reducer: (x: string | undefined, y: string | undefined) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * User ID for multi-tenancy
	 */
	userId: Annotation<string | undefined>({
		reducer: (x: string | undefined, y: string | undefined) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Organization ID for multi-tenancy
	 */
	organizationId: Annotation<string | undefined>({
		reducer: (x: string | undefined, y: string | undefined) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Selected tool for execution
	 */
	selectedTool: Annotation<OpenAPIToolDescriptor | undefined>({
		reducer: (
			x: OpenAPIToolDescriptor | undefined,
			y: OpenAPIToolDescriptor | undefined,
		) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Tool execution parameters
	 */
	toolArguments: Annotation<Record<string, unknown> | undefined>({
		reducer: (
			x: Record<string, unknown> | undefined,
			y: Record<string, unknown> | undefined,
		) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Execution result
	 */
	executionResult: Annotation<ToolExecutionResult | undefined>({
		reducer: (
			x: ToolExecutionResult | undefined,
			y: ToolExecutionResult | undefined,
		) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Final response to user
	 */
	response: Annotation<string | undefined>({
		reducer: (x: string | undefined, y: string | undefined) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Error message if any
	 */
	error: Annotation<string | undefined>({
		reducer: (x: string | undefined, y: string | undefined) => y ?? x,
		default: () => undefined,
	}),
});

/**
 * Type for the API Agent state
 */
export type ApiAgentStateType = typeof ApiAgentState.State;
