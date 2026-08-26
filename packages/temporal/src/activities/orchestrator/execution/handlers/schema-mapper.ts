/**
 * Schema-Aware Input Mapper
 *
 * Dynamically maps step inputs to tool parameters based on schemas.
 * Handles common LLM mistakes like using wrong parameter names.
 */

import { getAllFabricAiTools } from "../../tools/fabric-ai-tools";

export interface ToolSchema {
	type?: string;
	properties?: Record<
		string,
		{
			type?: string;
			description?: string;
			default?: unknown;
		}
	>;
	required?: string[];
}

export interface MappedInputs {
	inputs: Record<string, unknown>;
	warnings: string[];
	missingRequired: string[];
}

/**
 * Get the input schema for a tool by name.
 * Checks Fabric AI tools first, then falls back to preloaded tools.
 */
export function getToolSchema(
	toolName: string,
	preloadedTools?: Record<
		string,
		{
			definition: {
				inputSchema?: Record<string, unknown>;
			};
		}
	>,
): ToolSchema | null {
	// Check Fabric AI tools
	const fabricTools = getAllFabricAiTools();
	const fabricTool = fabricTools.find((t) => t.name === toolName);
	if (fabricTool?.inputSchema) {
		return fabricTool.inputSchema as ToolSchema;
	}

	// Check preloaded MCP tools
	if (preloadedTools?.[toolName]?.definition?.inputSchema) {
		return preloadedTools[toolName].definition.inputSchema as ToolSchema;
	}

	return null;
}

/**
 * Map provided inputs to tool schema parameters.
 *
 * Handles common issues:
 * - Wrong parameter names (tries to match by type/description)
 * - Missing required parameters (reports them)
 * - Extra parameters (passes through with warning)
 */
export function mapInputsToSchema(
	providedInputs: Record<string, unknown> | undefined,
	schema: ToolSchema | null,
	toolName: string,
): MappedInputs {
	const result: MappedInputs = {
		inputs: providedInputs ? { ...providedInputs } : {},
		warnings: [],
		missingRequired: [],
	};

	if (!schema?.properties) {
		// No schema available, pass through as-is
		return result;
	}

	const schemaProps = schema.properties;
	const requiredParams = schema.required || [];
	const providedKeys = Object.keys(providedInputs || {});
	const schemaKeys = Object.keys(schemaProps);

	// Build a map of schema params by their characteristics
	const paramsByType: Record<string, string[]> = {};
	for (const [paramName, paramDef] of Object.entries(schemaProps)) {
		const type = paramDef.type || "string";
		if (!paramsByType[type]) {
			paramsByType[type] = [];
		}
		paramsByType[type].push(paramName);
	}

	// Check for missing required parameters and try to find alternatives
	for (const requiredParam of requiredParams) {
		if (providedInputs?.[requiredParam] !== undefined) {
			continue; // Already provided correctly
		}

		// Try to find a provided value that could map to this required param
		const paramDef = schemaProps[requiredParam];
		const expectedType = paramDef?.type || "string";

		// Look for common alternative names
		const alternatives = findAlternativeNames(
			requiredParam,
			paramDef?.description,
		);

		for (const altName of alternatives) {
			if (providedInputs?.[altName] !== undefined) {
				// Found an alternative - map it
				result.inputs[requiredParam] = providedInputs[altName];
				result.warnings.push(
					`Mapped '${altName}' to required parameter '${requiredParam}' for tool ${toolName}`,
				);
				break;
			}
		}

		// If still missing, check if there's a single provided value of matching type
		// BUT exclude certain semantically specific parameters from auto-mapping
		const noAutoMapParams = ["serverTool", "serverId", "toolId"]; // These have specific format requirements
		if (
			result.inputs[requiredParam] === undefined &&
			!noAutoMapParams.includes(requiredParam)
		) {
			const matchingProvided = providedKeys.filter((k) => {
				const value = providedInputs?.[k];
				return (
					!schemaKeys.includes(k) && matchesType(value, expectedType)
				);
			});

			if (matchingProvided.length === 1) {
				result.inputs[requiredParam] =
					providedInputs?.[matchingProvided[0]];
				result.warnings.push(
					`Auto-mapped '${matchingProvided[0]}' to required parameter '${requiredParam}' for tool ${toolName}`,
				);
			}
		}

		// Still missing after all attempts
		if (result.inputs[requiredParam] === undefined) {
			result.missingRequired.push(requiredParam);
		}
	}

	// Apply defaults for missing optional parameters
	for (const [paramName, paramDef] of Object.entries(schemaProps)) {
		if (
			result.inputs[paramName] === undefined &&
			paramDef.default !== undefined
		) {
			result.inputs[paramName] = paramDef.default;
		}
	}

	// Warn about unrecognized parameters
	for (const providedKey of providedKeys) {
		if (
			!schemaKeys.includes(providedKey) &&
			result.inputs[providedKey] !== undefined
		) {
			// Check if it wasn't remapped
			const wasRemapped = result.warnings.some((w) =>
				w.includes(`'${providedKey}'`),
			);
			if (!wasRemapped) {
				result.warnings.push(
					`Unknown parameter '${providedKey}' for tool ${toolName} - passing through`,
				);
			}
		}
	}

	// Transform values based on parameter semantics (e.g., extract URL from text)
	for (const [paramName, paramDef] of Object.entries(schemaProps)) {
		if (result.inputs[paramName] !== undefined) {
			result.inputs[paramName] = transformValueForParameter(
				result.inputs[paramName],
				paramName,
				paramDef,
			);
		}
	}

	return result;
}

/**
 * Find alternative parameter names that might map to the expected one.
 */
function findAlternativeNames(
	paramName: string,
	description?: string,
): string[] {
	const alternatives: string[] = [];
	const lowerName = paramName.toLowerCase();

	// Common parameter name alternatives
	const synonyms: Record<string, string[]> = {
		query: [
			"search",
			"q",
			"searchQuery",
			"searchTerm",
			"question",
			"text",
			"input",
		],
		url: ["link", "href", "uri", "address", "website", "page"],
		text: ["content", "input", "message", "body", "data"],
		input: ["text", "content", "data", "message", "query"],
		pattern: ["template", "format", "style", "type"],
		message: ["text", "content", "body", "input"],
	};

	if (synonyms[lowerName]) {
		alternatives.push(...synonyms[lowerName]);
	}

	// Also check reverse mappings
	for (const [key, values] of Object.entries(synonyms)) {
		if (values.includes(lowerName) && !alternatives.includes(key)) {
			alternatives.push(key);
		}
	}

	// Add description-based hints if available
	if (description) {
		const descLower = description.toLowerCase();
		if (descLower.includes("search") && !alternatives.includes("query")) {
			alternatives.push("query", "search");
		}
		if (descLower.includes("url") && !alternatives.includes("url")) {
			alternatives.push("url", "link");
		}
	}

	return alternatives;
}

/**
 * Extract a URL from text content.
 * Used when a parameter expects a URL but receives text that may contain URLs.
 */
function extractUrlFromText(text: string): string | null {
	// Match URLs in the text - look for http/https URLs
	const urlRegex = /https?:\/\/[^\s\])"'<>]+/gi;
	const matches = text.match(urlRegex);

	if (matches && matches.length > 0) {
		// Clean up the URL - remove trailing punctuation
		const url = matches[0].replace(/[.,;:!?)]+$/, "");
		return url;
	}

	return null;
}

/**
 * Check if a string looks like a URL.
 */
function looksLikeUrl(value: string): boolean {
	return /^https?:\/\//i.test(value.trim());
}

/**
 * Transform a value based on the expected parameter semantics.
 * This handles cases where the value needs to be extracted or converted.
 */
function transformValueForParameter(
	value: unknown,
	paramName: string,
	paramDef?: { type?: string; description?: string },
): unknown {
	if (typeof value !== "string") {
		return value;
	}

	const lowerParamName = paramName.toLowerCase();
	const description = paramDef?.description?.toLowerCase() || "";

	// Check if this parameter expects a URL
	const expectsUrl =
		lowerParamName === "url" ||
		lowerParamName === "link" ||
		lowerParamName === "href" ||
		lowerParamName === "uri" ||
		description.includes("url") ||
		description.includes("link to");

	if (expectsUrl && !looksLikeUrl(value)) {
		// Value is not a URL but parameter expects one - try to extract
		const extractedUrl = extractUrlFromText(value);
		if (extractedUrl) {
			console.log(
				`[SchemaMapper] Extracted URL from text for parameter '${paramName}': ${extractedUrl.substring(0, 100)}...`,
			);
			return extractedUrl;
		}
	}

	return value;
}

/**
 * Check if a value matches the expected type.
 */
function matchesType(value: unknown, expectedType: string): boolean {
	if (value === undefined || value === null) {
		return false;
	}

	switch (expectedType) {
		case "string":
			return typeof value === "string";
		case "number":
		case "integer":
			return typeof value === "number";
		case "boolean":
			return typeof value === "boolean";
		case "array":
			return Array.isArray(value);
		case "object":
			return typeof value === "object" && !Array.isArray(value);
		default:
			return true; // Unknown type, allow anything
	}
}

/**
 * Validate and map inputs for a tool execution.
 * Returns mapped inputs or throws an error with helpful message.
 */
export function validateAndMapInputs(
	toolName: string,
	providedInputs: Record<string, unknown> | undefined,
	preloadedTools?: Record<
		string,
		{ definition: { inputSchema?: Record<string, unknown> } }
	>,
): Record<string, unknown> {
	const schema = getToolSchema(toolName, preloadedTools);
	const mapped = mapInputsToSchema(providedInputs, schema, toolName);

	// Log warnings
	for (const warning of mapped.warnings) {
		console.warn(`[SchemaMapper] ${warning}`);
	}

	// Throw error for missing required parameters
	if (mapped.missingRequired.length > 0) {
		const schemaHint = schema?.properties
			? Object.entries(schema.properties)
					.map(([name, def]) => {
						const req = schema.required?.includes(name)
							? " [REQUIRED]"
							: "";
						return `  - ${name}${req}: ${def.description || def.type || "unknown"}`;
					})
					.join("\n")
			: "Schema not available";

		throw new Error(
			`Missing required parameter(s): ${mapped.missingRequired.join(", ")} for tool '${toolName}'.\n` +
				`Provided: ${JSON.stringify(providedInputs)}\n` +
				`Expected parameters:\n${schemaHint}`,
		);
	}

	return mapped.inputs;
}
