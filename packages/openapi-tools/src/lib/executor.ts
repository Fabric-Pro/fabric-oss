/**
 * OpenAPI Tool Executor
 *
 * Executes OpenAPI tools by making HTTP requests based on tool definitions.
 */

import { logger } from "@repo/logs";
import type {
	ParsedOpenAPITool,
	ToolExecutionConfig,
	ToolExecutionInput,
	ToolExecutionResult,
} from "../types";
import { validateToolInput } from "./parser";

const DEFAULT_TIMEOUT = 30000; // 30 seconds

/**
 * Execute an OpenAPI tool with the given arguments
 */
export async function executeOpenAPITool(
	input: ToolExecutionInput,
): Promise<ToolExecutionResult> {
	const { tool, config, arguments: args } = input;
	const startTime = Date.now();

	try {
		// Validate input
		const validation = validateToolInput(tool, args);
		if (!validation.valid) {
			return {
				success: false,
				error: `Validation failed: ${validation.errors.join(", ")}`,
				responseTime: Date.now() - startTime,
			};
		}

		// Build URL with path parameters
		const url = buildUrl(tool, config, args);

		// Build request options
		const requestInit = buildRequest(tool, config, args);

		// Execute request
		const controller = new AbortController();
		const timeout = config.timeout || DEFAULT_TIMEOUT;
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		try {
			const response = await fetch(url, {
				...requestInit,
				signal: controller.signal,
			});

			const responseTime = Date.now() - startTime;
			const responseHeaders: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				responseHeaders[key] = value;
			});

			// Parse response body
			let data: unknown;
			const contentType = response.headers.get("content-type") || "";

			if (contentType.includes("application/json")) {
				data = await response.json();
			} else if (contentType.includes("text/")) {
				data = await response.text();
			} else {
				// For binary responses, return a placeholder
				data = {
					type: "binary",
					size: response.headers.get("content-length"),
				};
			}

			if (!response.ok) {
				return {
					success: false,
					statusCode: response.status,
					data,
					error: `HTTP ${response.status}: ${response.statusText}`,
					responseTime,
					headers: responseHeaders,
				};
			}

			return {
				success: true,
				statusCode: response.status,
				data,
				responseTime,
				headers: responseHeaders,
			};
		} finally {
			clearTimeout(timeoutId);
		}
	} catch (error) {
		const responseTime = Date.now() - startTime;

		if (error instanceof Error && error.name === "AbortError") {
			return {
				success: false,
				error: `Request timeout after ${config.timeout || DEFAULT_TIMEOUT}ms`,
				responseTime,
			};
		}

		logger.error("OpenAPI tool execution failed", {
			error,
			toolId: tool.operationId,
		});

		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
			responseTime,
		};
	}
}

/**
 * Build the full URL with path parameters and query string
 */
function buildUrl(
	tool: ParsedOpenAPITool,
	config: ToolExecutionConfig,
	args: Record<string, unknown>,
): string {
	// Start with base URL
	const baseUrl = config.baseUrl.replace(/\/$/, "");

	// Replace path parameters
	let path = tool.path;
	for (const param of tool.pathParams) {
		const value = args[param.name];
		if (value !== undefined) {
			path = path.replace(
				`{${param.name}}`,
				encodeURIComponent(String(value)),
			);
		}
	}

	// Build query string
	const queryParams = new URLSearchParams();
	for (const param of tool.queryParams) {
		const value = args[param.name];
		if (value !== undefined && value !== null) {
			if (Array.isArray(value)) {
				for (const v of value) {
					queryParams.append(param.name, String(v));
				}
			} else {
				queryParams.append(param.name, String(value));
			}
		}
	}

	// Add API key to query if configured
	if (
		config.authType === "API_KEY" &&
		config.authLocation === "QUERY" &&
		config.authKey &&
		config.authValue
	) {
		queryParams.append(config.authKey, config.authValue);
	}

	const queryString = queryParams.toString();
	return `${baseUrl}${path}${queryString ? `?${queryString}` : ""}`;
}

/**
 * Build the request init object (method, headers, body)
 */
function buildRequest(
	tool: ParsedOpenAPITool,
	config: ToolExecutionConfig,
	args: Record<string, unknown>,
): RequestInit {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json",
		...config.headers,
	};

	// Add authentication headers
	switch (config.authType) {
		case "API_KEY":
			if (
				config.authLocation === "HEADER" &&
				config.authKey &&
				config.authValue
			) {
				headers[config.authKey] = config.authValue;
			}
			break;
		case "BEARER":
			if (config.authValue) {
				headers.Authorization = `Bearer ${config.authValue}`;
			}
			break;
		case "BASIC":
			if (config.authValue) {
				headers.Authorization = `Basic ${config.authValue}`;
			}
			break;
	}

	// Add header parameters from args
	for (const param of tool.headerParams) {
		const value = args[param.name];
		if (value !== undefined) {
			headers[param.name] = String(value);
		}
	}

	const init: RequestInit = {
		method: tool.method,
		headers,
	};

	// Add request body for POST, PUT, PATCH
	if (["POST", "PUT", "PATCH"].includes(tool.method)) {
		// Extract body arguments (everything that's not a path, query, or header param)
		const paramNames = new Set([
			...tool.pathParams.map((p) => p.name),
			...tool.queryParams.map((p) => p.name),
			...tool.headerParams.map((p) => p.name),
		]);

		const bodyArgs: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(args)) {
			if (!paramNames.has(key)) {
				bodyArgs[key] = value;
			}
		}

		// If there's a "body" key, use it directly; otherwise use all remaining args
		if ("body" in args && typeof args.body === "object") {
			init.body = JSON.stringify(args.body);
		} else if (Object.keys(bodyArgs).length > 0) {
			init.body = JSON.stringify(bodyArgs);
		}
	}

	return init;
}

/**
 * Convert an OpenAPI tool to a LangChain-compatible tool definition
 */
export function toToolDefinition(tool: ParsedOpenAPITool): {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
} {
	// Combine parameters and request body schema
	const properties: Record<string, unknown> = {};
	const required: string[] = [];

	// Add path, query, header params
	for (const param of [
		...tool.pathParams,
		...tool.queryParams,
		...tool.headerParams,
	]) {
		properties[param.name] = {
			...param.schema,
			description: param.description,
		};
		if (param.required) {
			required.push(param.name);
		}
	}

	// Add request body properties if present
	if (tool.requestBodySchema && typeof tool.requestBodySchema === "object") {
		const bodySchema = tool.requestBodySchema as {
			properties?: Record<string, unknown>;
			required?: string[];
		};
		if (bodySchema.properties) {
			Object.assign(properties, bodySchema.properties);
		}
		if (bodySchema.required) {
			required.push(...bodySchema.required);
		}
	}

	return {
		name: tool.operationId,
		description: tool.description || `${tool.method} ${tool.path}`,
		parameters: {
			type: "object",
			properties,
			required: required.length > 0 ? required : undefined,
		},
	};
}

/**
 * Create an executable function for use with AI agents
 */
export function createToolExecutor(
	tool: ParsedOpenAPITool,
	config: ToolExecutionConfig,
): (args: Record<string, unknown>) => Promise<ToolExecutionResult> {
	return async (args: Record<string, unknown>) => {
		return executeOpenAPITool({ tool, config, arguments: args });
	};
}
