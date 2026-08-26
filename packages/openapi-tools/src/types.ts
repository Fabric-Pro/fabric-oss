import type { OpenAPIAuthLocation, OpenAPIAuthType } from "@repo/database";
import { z } from "zod";

/**
 * Parsed tool definition from OpenAPI spec
 */
export interface ParsedOpenAPITool {
	operationId: string;
	name: string;
	description: string | null;
	method: string;
	path: string;
	parametersSchema: Record<string, unknown> | null;
	requestBodySchema: Record<string, unknown> | null;
	responseSchema: Record<string, unknown> | null;
	pathParams: ParameterInfo[];
	queryParams: ParameterInfo[];
	headerParams: ParameterInfo[];
	deprecated: boolean;
	tags: string[];
}

export interface ParameterInfo {
	name: string;
	required: boolean;
	description?: string;
	schema: Record<string, unknown>;
	in: "path" | "query" | "header" | "cookie";
}

/**
 * Result of parsing an OpenAPI spec
 */
export interface ParsedOpenAPISpec {
	title: string;
	description: string | null;
	version: string;
	baseUrl: string | null;
	tools: ParsedOpenAPITool[];
	specHash: string;
	authSchemes: AuthSchemeInfo[];
}

export interface AuthSchemeInfo {
	name: string;
	type: "apiKey" | "http" | "oauth2" | "openIdConnect";
	in?: "header" | "query" | "cookie";
	scheme?: string; // "bearer", "basic"
	bearerFormat?: string;
	flows?: Record<string, unknown>;
}

/**
 * Configuration for executing an OpenAPI tool
 */
export interface ToolExecutionConfig {
	baseUrl: string;
	authType: OpenAPIAuthType;
	authLocation?: OpenAPIAuthLocation | null;
	authKey?: string | null;
	authValue?: string | null;
	timeout?: number;
	headers?: Record<string, string>;
}

/**
 * Input for tool execution
 */
export interface ToolExecutionInput {
	tool: ParsedOpenAPITool;
	config: ToolExecutionConfig;
	arguments: Record<string, unknown>;
}

/**
 * Result of tool execution
 */
export interface ToolExecutionResult {
	success: boolean;
	statusCode?: number;
	data?: unknown;
	error?: string;
	responseTime: number;
	headers?: Record<string, string>;
}

// Zod schemas for validation
export const OnboardServiceInputSchema = z.object({
	specUrl: z.string().url(),
	name: z.string().min(1).max(100),
	description: z.string().max(500).optional(),
	baseUrl: z.string().url().optional(),
	authType: z
		.enum(["NONE", "API_KEY", "BEARER", "BASIC", "OAUTH2"])
		.default("NONE"),
	authLocation: z.enum(["HEADER", "QUERY", "COOKIE"]).optional(),
	authKey: z.string().optional(),
	authValue: z.string().optional(), // Will be encrypted before storage
	category: z.string().optional(),
	tags: z.array(z.string()).default([]),
});

export type OnboardServiceInput = z.infer<typeof OnboardServiceInputSchema>;

export const ExecuteToolInputSchema = z.object({
	serviceId: z.string(),
	toolId: z.string(),
	arguments: z.record(z.string(), z.unknown()).default({}),
});

export type ExecuteToolInput = z.infer<typeof ExecuteToolInputSchema>;

export const SyncServiceInputSchema = z.object({
	serviceId: z.string(),
});

export type SyncServiceInput = z.infer<typeof SyncServiceInputSchema>;
