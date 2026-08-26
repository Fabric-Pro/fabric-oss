/**
 * OpenAPI Tool Loader
 *
 * Loads OpenAPI tools from the database and converts them to LangChain-compatible tools.
 * This is the bridge between stored OpenAPI configurations and agent runtime.
 */

import { logger } from "@repo/logs";
import type { ParsedOpenAPITool, ToolExecutionConfig } from "../types";
import { createToolExecutor, toToolDefinition } from "./executor";

/**
 * OpenAPI tool ready for use with LangChain agents
 */
export interface OpenAPIAgentTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (args: Record<string, unknown>) => Promise<{
		success: boolean;
		data?: unknown;
		error?: string;
	}>;
}

/**
 * Options for loading OpenAPI tools
 */
export interface LoadOpenAPIToolsOptions {
	/** User ID for multi-tenancy */
	userId: string;
	/** Organization ID for multi-tenancy (optional) */
	organizationId?: string;
	/** Specific service IDs to load tools from (optional, loads all if not specified) */
	serviceIds?: string[];
	/** Only load enabled tools (default: true) */
	enabledOnly?: boolean;
}

/**
 * Result of loading OpenAPI tools
 */
export interface LoadOpenAPIToolsResult {
	tools: OpenAPIAgentTool[];
	errors: Array<{
		serviceId: string;
		serviceName: string;
		error: string;
	}>;
}

/**
 * Convert database tool record to ParsedOpenAPITool
 */
export function dbToolToParsedTool(dbTool: {
	id: string;
	name: string;
	description: string | null;
	method: string;
	path: string;
	operationId: string;
	parametersSchema: unknown;
	requestBodySchema: unknown;
	responseSchema: unknown;
	tags: string[];
}): ParsedOpenAPITool {
	const params =
		(dbTool.parametersSchema as {
			pathParams?: unknown[];
			queryParams?: unknown[];
			headerParams?: unknown[];
		}) || {};

	return {
		operationId: dbTool.operationId,
		name: dbTool.name,
		description: dbTool.description,
		method: dbTool.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
		path: dbTool.path,
		pathParams: (params.pathParams ||
			[]) as ParsedOpenAPITool["pathParams"],
		queryParams: (params.queryParams ||
			[]) as ParsedOpenAPITool["queryParams"],
		headerParams: (params.headerParams ||
			[]) as ParsedOpenAPITool["headerParams"],
		parametersSchema:
			(dbTool.parametersSchema as Record<string, unknown>) ?? null,
		requestBodySchema:
			(dbTool.requestBodySchema as Record<string, unknown>) ?? null,
		responseSchema:
			(dbTool.responseSchema as Record<string, unknown>) ?? null,
		deprecated: false,
		tags: dbTool.tags,
	};
}

/**
 * Convert database service config to ToolExecutionConfig
 */
export function dbServiceToConfig(dbService: {
	baseUrl: string | null;
	authType: string;
	authKey: string | null;
	authValue: string | null;
	authLocation: string | null;
}): ToolExecutionConfig {
	return {
		baseUrl: dbService.baseUrl || "",
		authType: dbService.authType as ToolExecutionConfig["authType"],
		authKey: dbService.authKey || undefined,
		authValue: dbService.authValue || undefined,
		authLocation:
			dbService.authLocation as ToolExecutionConfig["authLocation"],
	};
}

/**
 * Create an OpenAPI agent tool from database records
 */
export function createOpenAPIAgentTool(
	dbTool: Parameters<typeof dbToolToParsedTool>[0],
	dbService: Parameters<typeof dbServiceToConfig>[0],
): OpenAPIAgentTool {
	const parsedTool = dbToolToParsedTool(dbTool);
	const config = dbServiceToConfig(dbService);
	const definition = toToolDefinition(parsedTool);
	const executor = createToolExecutor(parsedTool, config);

	return {
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		execute: async (args: Record<string, unknown>) => {
			const result = await executor(args);
			return {
				success: result.success,
				data: result.data,
				error: result.error,
			};
		},
	};
}

/**
 * Convert OpenAPI agent tool to LangChain tool format
 * This creates a tool definition compatible with model.bindTools()
 */
export function toLangChainTool(tool: OpenAPIAgentTool): {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
} {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	};
}

/**
 * Log tool loading for debugging
 */
export function logToolsLoaded(
	serviceName: string,
	toolCount: number,
	userId: string,
): void {
	logger.info("OpenAPI tools loaded", {
		serviceName,
		toolCount,
		userId,
	});
}
