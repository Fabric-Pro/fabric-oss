/**
 * OpenAPI Tools Utility
 *
 * Functions for loading and executing OpenAPI tools from Fabric.
 */

import type { OpenAPIToolDescriptor, ToolExecutionResult } from "../types";

/**
 * Load OpenAPI tools from Fabric API
 *
 * @param fabricApiUrl - Base URL of the Fabric API
 * @param userId - Optional user ID for multi-tenancy
 * @param organizationId - Optional organization ID for multi-tenancy
 * @param authToken - Optional auth token for API calls
 * @returns Array of available OpenAPI tool descriptors
 */
export async function loadOpenAPITools(
	fabricApiUrl: string,
	userId?: string,
	organizationId?: string,
	authToken?: string,
): Promise<OpenAPIToolDescriptor[]> {
	try {
		const url = `${fabricApiUrl.replace(/\/$/, "")}/api/orpc/openapi/tools/load`;

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (authToken) {
			headers.Authorization = `Bearer ${authToken}`;
		}

		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				userId,
				organizationId,
			}),
		});

		if (!response.ok) {
			console.error(
				`[API Agent] Failed to load tools: ${response.status}`,
			);
			return [];
		}

		const data = (await response.json()) as {
			tools?: Array<{
				toolId: string;
				function: {
					name: string;
					description: string;
					parameters: Record<string, unknown>;
				};
				serviceId: string;
				serviceName: string;
			}>;
		};

		return (data.tools || []).map((tool) => ({
			id: tool.toolId,
			name: tool.function.name,
			description: tool.function.description,
			parameters: tool.function.parameters,
			serviceId: tool.serviceId,
			serviceName: tool.serviceName,
		}));
	} catch (error) {
		console.error("[API Agent] Error loading OpenAPI tools:", error);
		return [];
	}
}

/**
 * Execute an OpenAPI tool via Fabric API
 *
 * @param fabricApiUrl - Base URL of the Fabric API
 * @param toolId - ID of the tool to execute
 * @param args - Arguments for the tool
 * @param authToken - Optional auth token for API calls
 * @returns Execution result with success status and data/error
 */
export async function executeOpenAPITool(
	fabricApiUrl: string,
	toolId: string,
	args: Record<string, unknown>,
	authToken?: string,
): Promise<ToolExecutionResult> {
	try {
		const url = `${fabricApiUrl.replace(/\/$/, "")}/api/orpc/openapi/tools/${toolId}/test`;

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (authToken) {
			headers.Authorization = `Bearer ${authToken}`;
		}

		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				id: toolId,
				arguments: args,
			}),
		});

		const data = (await response.json()) as {
			success?: boolean;
			data?: unknown;
			error?: string;
			statusCode?: number;
			responseTime?: number;
		};

		return {
			success: data.success ?? response.ok,
			data: data.data,
			error: data.error,
			statusCode: data.statusCode || response.status,
			responseTime: data.responseTime || 0,
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Unknown error executing tool",
			responseTime: 0,
		};
	}
}

/**
 * Format a list of tools as a summary string
 *
 * @param tools - Array of tool descriptors
 * @param maxTools - Maximum number of tools to include (default: 30)
 * @returns Formatted tool summary string
 */
export function formatToolSummary(
	tools: OpenAPIToolDescriptor[],
	maxTools = 30,
): string {
	return tools
		.slice(0, maxTools)
		.map(
			(t, i) =>
				`${i + 1}. ${t.name} (${t.serviceName}): ${t.description || "No description"}`,
		)
		.join("\n");
}
