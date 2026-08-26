/**
 * OpenAPI Spec Parser
 *
 * Parses OpenAPI 3.x specifications and extracts tool definitions
 * for use with AI agents.
 */

import { createHash } from "node:crypto";
import SwaggerParser from "@apidevtools/swagger-parser";
import { logger } from "@repo/logs";
import type { OpenAPI, OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import type {
	AuthSchemeInfo,
	ParameterInfo,
	ParsedOpenAPISpec,
	ParsedOpenAPITool,
} from "../types";

type OpenAPI3Document = OpenAPIV3.Document | OpenAPIV3_1.Document;
type OperationObject = OpenAPIV3.OperationObject | OpenAPIV3_1.OperationObject;
type ParameterObject = OpenAPIV3.ParameterObject | OpenAPIV3_1.ParameterObject;
type ReferenceObject = OpenAPIV3.ReferenceObject | OpenAPIV3_1.ReferenceObject;
type RequestBodyObject =
	| OpenAPIV3.RequestBodyObject
	| OpenAPIV3_1.RequestBodyObject;
type SecuritySchemeObject =
	| OpenAPIV3.SecuritySchemeObject
	| OpenAPIV3_1.SecuritySchemeObject;

const HTTP_METHODS = [
	"get",
	"post",
	"put",
	"delete",
	"patch",
	"options",
	"head",
] as const;

/**
 * Parse an OpenAPI specification from URL or content
 */
export async function parseOpenAPISpec(
	specUrlOrContent: string,
	options: { isUrl?: boolean } = { isUrl: true },
): Promise<ParsedOpenAPISpec> {
	try {
		let api: OpenAPI.Document;
		let specContent: string;

		if (options.isUrl) {
			// Fetch and parse from URL
			const response = await fetch(specUrlOrContent, {
				headers: {
					Accept: "application/json, application/yaml, text/yaml",
				},
			});

			if (!response.ok) {
				throw new Error(
					`Failed to fetch OpenAPI spec: ${response.status} ${response.statusText}`,
				);
			}

			specContent = await response.text();
			api = await SwaggerParser.parse(specUrlOrContent);
		} else {
			// Parse from content directly
			specContent = specUrlOrContent;
			api = await SwaggerParser.parse(JSON.parse(specContent));
		}

		// Validate OpenAPI 3.x
		if (!isOpenAPI3(api)) {
			throw new Error("Only OpenAPI 3.x specifications are supported");
		}

		// Dereference to resolve $ref pointers
		const dereferencedApi = (await SwaggerParser.dereference(
			api,
		)) as OpenAPI3Document;

		// Calculate spec hash for change detection
		const specHash = createHash("sha256")
			.update(specContent)
			.digest("hex")
			.slice(0, 16);

		// Extract base URL from servers
		const baseUrl = extractBaseUrl(dereferencedApi);

		// Extract authentication schemes
		const authSchemes = extractAuthSchemes(dereferencedApi);

		// Extract tools from paths
		const tools = extractTools(dereferencedApi);

		return {
			title: dereferencedApi.info.title,
			description: dereferencedApi.info.description || null,
			version: dereferencedApi.info.version,
			baseUrl,
			tools,
			specHash,
			authSchemes,
		};
	} catch (error) {
		logger.error("Failed to parse OpenAPI spec", {
			error,
			specUrl: specUrlOrContent,
		});
		throw error;
	}
}

function isOpenAPI3(api: OpenAPI.Document): api is OpenAPI3Document {
	return "openapi" in api && api.openapi.startsWith("3.");
}

function extractBaseUrl(api: OpenAPI3Document): string | null {
	if (api.servers && api.servers.length > 0) {
		const server = api.servers[0];
		let url = server.url;

		// Handle server variables
		if (server.variables) {
			for (const [key, variable] of Object.entries(server.variables)) {
				const defaultValue = variable.default;
				url = url.replace(`{${key}}`, defaultValue);
			}
		}

		return url;
	}
	return null;
}

function extractAuthSchemes(api: OpenAPI3Document): AuthSchemeInfo[] {
	const schemes: AuthSchemeInfo[] = [];
	const securitySchemes = api.components?.securitySchemes;

	if (!securitySchemes) {
		return schemes;
	}

	for (const [name, schemeOrRef] of Object.entries(securitySchemes)) {
		if (isReference(schemeOrRef)) {
			continue;
		}

		const scheme = schemeOrRef as SecuritySchemeObject;
		schemes.push({
			name,
			type: scheme.type as AuthSchemeInfo["type"],
			in:
				scheme.type === "apiKey"
					? (scheme.in as "header" | "query" | "cookie")
					: undefined,
			scheme: scheme.type === "http" ? scheme.scheme : undefined,
			bearerFormat:
				scheme.type === "http" ? scheme.bearerFormat : undefined,
			flows:
				scheme.type === "oauth2"
					? (scheme.flows as Record<string, unknown>)
					: undefined,
		});
	}

	return schemes;
}

function extractTools(api: OpenAPI3Document): ParsedOpenAPITool[] {
	const tools: ParsedOpenAPITool[] = [];

	if (!api.paths) {
		return tools;
	}

	for (const [path, pathItem] of Object.entries(api.paths)) {
		if (!pathItem || isReference(pathItem)) {
			continue;
		}

		for (const method of HTTP_METHODS) {
			const operation = pathItem[method] as OperationObject | undefined;
			if (!operation) {
				continue;
			}

			const tool = extractToolFromOperation(
				path,
				method.toUpperCase(),
				operation,
			);
			if (tool) {
				tools.push(tool);
			}
		}
	}

	return tools;
}

function extractToolFromOperation(
	path: string,
	method: string,
	operation: OperationObject,
): ParsedOpenAPITool | null {
	// Generate operationId if not provided
	const operationId =
		operation.operationId || generateOperationId(method, path);

	// Generate friendly name
	const name = generateToolName(operationId, method, path);

	// Extract parameters by location
	const { pathParams, queryParams, headerParams } = extractParameters(
		operation.parameters,
	);

	// Build combined parameters schema
	const parametersSchema = buildParametersSchema(
		pathParams,
		queryParams,
		headerParams,
	);

	// Extract request body schema
	const requestBodySchema = extractRequestBodySchema(operation.requestBody);

	// Extract response schema (200 or default)
	const responseSchema = extractResponseSchema(operation.responses);

	return {
		operationId,
		name,
		description: operation.description || operation.summary || null,
		method,
		path,
		parametersSchema,
		requestBodySchema,
		responseSchema,
		pathParams,
		queryParams,
		headerParams,
		deprecated: operation.deprecated || false,
		tags: operation.tags || [],
	};
}

function generateOperationId(method: string, path: string): string {
	// Convert path to camelCase identifier
	// /users/{id}/orders -> getUsersIdOrders
	const pathParts = path
		.split("/")
		.filter(Boolean)
		.map((part) => {
			if (part.startsWith("{") && part.endsWith("}")) {
				// Parameter - capitalize first letter
				const paramName = part.slice(1, -1);
				return paramName.charAt(0).toUpperCase() + paramName.slice(1);
			}
			return part.charAt(0).toUpperCase() + part.slice(1);
		});

	return method.toLowerCase() + pathParts.join("");
}

function generateToolName(
	operationId: string,
	method: string,
	path: string,
): string {
	// Use operationId if it's readable, otherwise generate from method+path
	if (operationId && !operationId.includes("/")) {
		// Convert camelCase to readable format
		return operationId
			.replace(/([A-Z])/g, " $1")
			.trim()
			.toLowerCase()
			.replace(/^./, (s) => s.toUpperCase());
	}

	const pathName = path
		.split("/")
		.filter((p) => p && !p.startsWith("{"))
		.join(" ");

	return `${method} ${pathName}`.trim();
}

function extractParameters(
	parameters: (ParameterObject | ReferenceObject)[] | undefined,
): {
	pathParams: ParameterInfo[];
	queryParams: ParameterInfo[];
	headerParams: ParameterInfo[];
} {
	const pathParams: ParameterInfo[] = [];
	const queryParams: ParameterInfo[] = [];
	const headerParams: ParameterInfo[] = [];

	if (!parameters) {
		return { pathParams, queryParams, headerParams };
	}

	for (const param of parameters) {
		if (isReference(param)) {
			continue;
		}

		const paramInfo: ParameterInfo = {
			name: param.name,
			required: param.required || false,
			description: param.description,
			schema: (param.schema as Record<string, unknown>) || {
				type: "string",
			},
			in: param.in as ParameterInfo["in"],
		};

		switch (param.in) {
			case "path":
				paramInfo.required = true; // Path params are always required
				pathParams.push(paramInfo);
				break;
			case "query":
				queryParams.push(paramInfo);
				break;
			case "header":
				headerParams.push(paramInfo);
				break;
		}
	}

	return { pathParams, queryParams, headerParams };
}

function buildParametersSchema(
	pathParams: ParameterInfo[],
	queryParams: ParameterInfo[],
	headerParams: ParameterInfo[],
): Record<string, unknown> | null {
	const allParams = [...pathParams, ...queryParams, ...headerParams];
	if (allParams.length === 0) {
		return null;
	}

	const properties: Record<string, unknown> = {};
	const required: string[] = [];

	for (const param of allParams) {
		properties[param.name] = {
			...param.schema,
			description: param.description,
		};
		if (param.required) {
			required.push(param.name);
		}
	}

	return {
		type: "object",
		properties,
		required: required.length > 0 ? required : undefined,
	};
}

function extractRequestBodySchema(
	requestBody: RequestBodyObject | ReferenceObject | undefined,
): Record<string, unknown> | null {
	if (!requestBody || isReference(requestBody)) {
		return null;
	}

	const content = requestBody.content;
	if (!content) {
		return null;
	}

	// Prefer JSON, then form data
	const mediaType =
		content["application/json"] ||
		content["application/x-www-form-urlencoded"] ||
		content["multipart/form-data"] ||
		Object.values(content)[0];

	if (!mediaType?.schema) {
		return null;
	}

	return mediaType.schema as Record<string, unknown>;
}

function extractResponseSchema(
	responses:
		| OpenAPIV3.ResponsesObject
		| OpenAPIV3_1.ResponsesObject
		| undefined,
): Record<string, unknown> | null {
	if (!responses) {
		return null;
	}

	// Try 200, 201, default in order
	const response = responses[200] || responses[201] || responses.default;
	if (!response || isReference(response)) {
		return null;
	}

	const content = response.content;
	if (!content) {
		return null;
	}

	const mediaType = content["application/json"] || Object.values(content)[0];
	if (!mediaType?.schema) {
		return null;
	}

	return mediaType.schema as Record<string, unknown>;
}

function isReference(obj: unknown): obj is ReferenceObject {
	return typeof obj === "object" && obj !== null && "$ref" in obj;
}

/**
 * Validate a tool's input against its schema
 */
export function validateToolInput(
	tool: ParsedOpenAPITool,
	input: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	// Check required path params
	for (const param of tool.pathParams) {
		if (param.required && !(param.name in input)) {
			errors.push(`Missing required path parameter: ${param.name}`);
		}
	}

	// Check required query params
	for (const param of tool.queryParams) {
		if (param.required && !(param.name in input)) {
			errors.push(`Missing required query parameter: ${param.name}`);
		}
	}

	return { valid: errors.length === 0, errors };
}
