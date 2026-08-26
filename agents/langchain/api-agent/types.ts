/**
 * API Agent Types
 *
 * Type definitions for the OpenAPI-based API Agent.
 */

/**
 * Stages of the API Agent execution
 */
export type ApiAgentStage =
	| "analyzing"
	| "executing"
	| "formatting"
	| "complete"
	| "error";

/**
 * OpenAPI Tool descriptor loaded from Fabric
 */
export interface OpenAPIToolDescriptor {
	id: string;
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
	serviceId: string;
	serviceName: string;
}

/**
 * Result of executing an OpenAPI tool
 */
export interface ToolExecutionResult {
	success: boolean;
	data?: unknown;
	error?: string;
	statusCode?: number;
	responseTime: number;
	headers?: Record<string, string>;
}

/**
 * A2A Message format for inter-agent communication
 */
export interface A2AMessage {
	role: "user" | "assistant";
	content: string;
	metadata?: Record<string, unknown>;
}

/**
 * A2A Task result
 */
export interface A2ATaskResult {
	taskId: string;
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	response?: string;
	error?: string;
	artifacts?: Array<{
		id: string;
		name: string;
		description?: string;
		mimeType: string;
		parts: Array<{ type: string; text?: string; data?: string }>;
	}>;
	metadata?: Record<string, unknown>;
}
