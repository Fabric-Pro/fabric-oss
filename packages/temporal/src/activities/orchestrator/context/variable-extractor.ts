/**
 * Variable Extractor
 *
 * Extracts key variables from step outputs for use in subsequent steps.
 * Enables efficient context flow between execution steps.
 */

import type { AgentVariable, ExecuteStepOutput } from "../types";

// =============================================================================
// Types
// =============================================================================

export interface ExtractedVariable {
	/** Variable name */
	name: string;
	/** Extracted value */
	value: unknown;
	/** Step ID where this was extracted from */
	extractedFrom: string;
	/** When extraction occurred */
	extractedAt: Date;
	/** Confidence in the extraction (0-1) */
	confidence: number;
	/** Type of the value */
	type: "string" | "number" | "boolean" | "object" | "array" | "unknown";
}

export interface ExtractionPattern {
	/** Pattern name */
	name: string;
	/** Regex or string pattern to match */
	pattern: RegExp | string;
	/** Variable name to assign */
	variableName: string;
	/** Optional transform function */
	transform?: (match: string) => unknown;
}

export interface ExtractionConfig {
	/** Patterns to look for in outputs */
	patterns: ExtractionPattern[];
	/** Known output schemas by step type */
	outputSchemas?: Record<string, Record<string, string>>;
}

// =============================================================================
// Default Patterns
// =============================================================================

/**
 * Common extraction patterns for typical outputs.
 */
export const DEFAULT_EXTRACTION_PATTERNS: ExtractionPattern[] = [
	// IDs
	{
		name: "card_id",
		pattern: /card[_\s]?id[:\s]+["']?([a-zA-Z0-9_-]+)["']?/i,
		variableName: "cardId",
	},
	{
		name: "task_id",
		pattern: /task[_\s]?id[:\s]+["']?([a-zA-Z0-9_-]+)["']?/i,
		variableName: "taskId",
	},
	{
		name: "issue_id",
		pattern: /issue[_\s]?id[:\s]+["']?([a-zA-Z0-9_-]+)["']?/i,
		variableName: "issueId",
	},
	{
		name: "document_id",
		pattern: /document[_\s]?id[:\s]+["']?([a-zA-Z0-9_-]+)["']?/i,
		variableName: "documentId",
	},
	{
		name: "user_id",
		pattern: /user[_\s]?id[:\s]+["']?([a-zA-Z0-9_-]+)["']?/i,
		variableName: "userId",
	},

	// URLs
	{
		name: "url",
		pattern: /(?:url|link)[:\s]+["']?(https?:\/\/[^\s"']+)["']?/i,
		variableName: "url",
	},

	// Status
	{
		name: "status",
		pattern:
			/status[:\s]+["']?(success|completed|failed|pending|error)["']?/i,
		variableName: "status",
	},

	// Counts
	{
		name: "count",
		pattern: /(?:count|total)[:\s]+(\d+)/i,
		variableName: "count",
		transform: (m) => Number.parseInt(m, 10),
	},

	// Names
	{
		name: "name",
		pattern: /(?:name|title)[:\s]+["']([^"'\n]+)["']/i,
		variableName: "name",
	},
];

// =============================================================================
// Extraction Functions
// =============================================================================

/**
 * Extract variables from a step output.
 */
export function extractVariablesFromOutput(
	stepResult: ExecuteStepOutput,
	stepId: string,
	config?: ExtractionConfig,
): ExtractedVariable[] {
	const variables: ExtractedVariable[] = [];
	const patterns = config?.patterns || DEFAULT_EXTRACTION_PATTERNS;
	const now = new Date();

	// Extract from response text
	if (stepResult.response) {
		const responseVars = extractFromText(
			stepResult.response,
			stepId,
			patterns,
			now,
		);
		variables.push(...responseVars);
	}

	// Extract from outputs object
	if (stepResult.outputs) {
		const outputVars = extractFromObject(stepResult.outputs, stepId, now);
		variables.push(...outputVars);
	}

	// Extract from variables if present
	if (stepResult.variables) {
		for (const [key, value] of Object.entries(stepResult.variables)) {
			variables.push({
				name: key,
				value: value.value,
				extractedFrom: stepId,
				extractedAt: now,
				confidence: 1.0,
				type: getValueType(value.value),
			});
		}
	}

	// Extract from tool call results
	if (stepResult.toolCalls) {
		for (const toolCall of stepResult.toolCalls) {
			if (toolCall.status === "success" && toolCall.result) {
				const toolVars = extractFromToolResult(
					toolCall.name,
					toolCall.result,
					stepId,
					now,
				);
				variables.push(...toolVars);
			}
		}
	}

	// Deduplicate by name (keep highest confidence)
	return deduplicateVariables(variables);
}

/**
 * Extract variables from text using patterns.
 */
function extractFromText(
	text: string,
	stepId: string,
	patterns: ExtractionPattern[],
	timestamp: Date,
): ExtractedVariable[] {
	const variables: ExtractedVariable[] = [];

	for (const pattern of patterns) {
		const regex =
			typeof pattern.pattern === "string"
				? new RegExp(pattern.pattern, "gi")
				: pattern.pattern;

		const matches = text.match(regex);
		if (matches && matches.length > 0) {
			// Get the captured group if available
			const fullMatch = text.match(regex);
			if (fullMatch) {
				const execResult = regex.exec(text);
				const value = execResult?.[1] || fullMatch[0];
				const transformedValue = pattern.transform
					? pattern.transform(value)
					: value;

				variables.push({
					name: pattern.variableName,
					value: transformedValue,
					extractedFrom: stepId,
					extractedAt: timestamp,
					confidence: 0.8,
					type: getValueType(transformedValue),
				});
			}
		}
	}

	return variables;
}

/**
 * Extract variables from an object/dictionary.
 */
function extractFromObject(
	obj: Record<string, unknown>,
	stepId: string,
	timestamp: Date,
): ExtractedVariable[] {
	const variables: ExtractedVariable[] = [];

	// Common key patterns to extract
	const keyPatterns = [
		"id",
		"Id",
		"ID",
		"name",
		"title",
		"url",
		"status",
		"result",
		"output",
		"data",
		"response",
		"message",
	];

	for (const [key, value] of Object.entries(obj)) {
		// Check if key matches known patterns
		const isImportant =
			keyPatterns.some((p) =>
				key.toLowerCase().includes(p.toLowerCase()),
			) || key.endsWith("Id");

		if (isImportant && value !== null && value !== undefined) {
			variables.push({
				name: key,
				value,
				extractedFrom: stepId,
				extractedAt: timestamp,
				confidence: 0.9,
				type: getValueType(value),
			});
		}
	}

	return variables;
}

/**
 * Extract variables from tool call results.
 */
function extractFromToolResult(
	toolName: string,
	result: unknown,
	stepId: string,
	timestamp: Date,
): ExtractedVariable[] {
	const variables: ExtractedVariable[] = [];
	const toolPrefix = toolName.split("_")[0]; // e.g., "fizzy" from "fizzy_create_card"

	if (typeof result === "object" && result !== null) {
		const obj = result as Record<string, unknown>;

		// Extract ID fields
		for (const key of ["id", "cardId", "taskId", "issueId", "documentId"]) {
			if (obj[key]) {
				variables.push({
					name: `${toolPrefix}_${key}`,
					value: obj[key],
					extractedFrom: stepId,
					extractedAt: timestamp,
					confidence: 1.0,
					type: getValueType(obj[key]),
				});
			}
		}

		// Extract status/result
		if (obj.status || obj.result) {
			variables.push({
				name: `${toolPrefix}_status`,
				value: obj.status || obj.result,
				extractedFrom: stepId,
				extractedAt: timestamp,
				confidence: 1.0,
				type: getValueType(obj.status || obj.result),
			});
		}
	} else if (typeof result === "string" || typeof result === "number") {
		variables.push({
			name: `${toolPrefix}_result`,
			value: result,
			extractedFrom: stepId,
			extractedAt: timestamp,
			confidence: 0.9,
			type: getValueType(result),
		});
	}

	return variables;
}

/**
 * Get the type of a value.
 */
function getValueType(
	value: unknown,
): "string" | "number" | "boolean" | "object" | "array" | "unknown" {
	if (Array.isArray(value)) {
		return "array";
	}
	if (value === null) {
		return "unknown";
	}
	const t = typeof value;
	if (t === "string" || t === "number" || t === "boolean" || t === "object") {
		return t;
	}
	return "unknown";
}

/**
 * Deduplicate variables by name, keeping highest confidence.
 */
function deduplicateVariables(
	variables: ExtractedVariable[],
): ExtractedVariable[] {
	const byName = new Map<string, ExtractedVariable>();

	for (const variable of variables) {
		const existing = byName.get(variable.name);
		if (!existing || existing.confidence < variable.confidence) {
			byName.set(variable.name, variable);
		}
	}

	return Array.from(byName.values());
}

/**
 * Convert extracted variables to AgentVariable format.
 */
export function toAgentVariables(
	extracted: ExtractedVariable[],
): Record<string, AgentVariable> {
	const result: Record<string, AgentVariable> = {};

	for (const variable of extracted) {
		result[variable.name] = {
			name: variable.name,
			value: variable.value,
			setBy: variable.extractedFrom,
			setAt: variable.extractedAt.toISOString(),
			scope: "step" as const,
		};
	}

	return result;
}

/**
 * Merge new variables into existing variables.
 * New values override existing ones.
 */
export function mergeVariables(
	existing: Record<string, AgentVariable>,
	extracted: ExtractedVariable[],
): Record<string, AgentVariable> {
	const newVars = toAgentVariables(extracted);
	return { ...existing, ...newVars };
}
