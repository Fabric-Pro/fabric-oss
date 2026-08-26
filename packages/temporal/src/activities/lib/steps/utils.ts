/**
 * Shared utilities for step functions
 */

/**
 * Escape a string value for safe inclusion in JSON strings.
 * This properly escapes control characters that would break JSON parsing.
 */
export function escapeJsonStringValue(value: string): string {
	return (
		value
			.replace(/\\/g, "\\\\") // Backslash first (must be first to avoid double-escaping)
			.replace(/"/g, '\\"') // Double quotes
			.replace(/\n/g, "\\n") // Newlines
			.replace(/\r/g, "\\r") // Carriage returns
			.replace(/\t/g, "\\t") // Tabs
			.replace(/\f/g, "\\f") // Form feeds
			// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching backspace control character
			.replace(/\u0008/g, "\\b") // Backspace (use \x08, not \b which is word boundary in regex)
			// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching all C0 control characters to escape them
			.replace(/[\u0000-\u001f]/g, (char) => {
				// Escape any remaining control characters as \uXXXX
				return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
			})
	);
}

/**
 * Interpolate template variables in a string, reporting anything that could
 * not be resolved.
 *
 * Supports:
 * - Simple variables: {{variableName}}
 * - Node references with spaces: {{Generate Text.text}}
 * - Node ID references: {{$nodeId.field}}
 * - Nested properties: {{nodeName.nested.field}}
 *
 * An unresolved reference becomes an EMPTY STRING, never the literal
 * `{{...}}` text. Leaving the placeholder in place meant a typo — or a
 * declared output field the step never actually returned — got delivered
 * verbatim: Slack messages reading "{{Create Ticket.id}}", emails with raw
 * placeholders in the body. An empty value is recoverable and visible; a
 * placeholder posing as data is neither. `unresolved` carries the offending
 * keys so callers can surface them.
 *
 * @param template - The template string with {{variable}} placeholders
 * @param variables - The variables to interpolate
 * @param options - Optional configuration
 * @param options.escapeForJson - If true, escapes control characters for JSON safety
 */
export function interpolateTemplateWithDiagnostics(
	template: string,
	variables: Record<string, unknown>,
	options?: { escapeForJson?: boolean },
): { text: string; unresolved: string[] } {
	const escapeForJson = options?.escapeForJson ?? false;
	const unresolved: string[] = [];

	// Match {{ followed by any characters until }} (non-greedy)
	// This supports spaces in node labels like "Generate Text.text"
	const text = template.replace(/\{\{([^}]+)\}\}/g, (_match, key) => {
		const trimmedKey = key.trim();
		// Every `return match` below became `return miss()`: same control
		// flow, but the reference is recorded and erased rather than emitted.
		const miss = (): string => {
			unresolved.push(trimmedKey);
			return "";
		};

		// Helper to format value with optional JSON escaping.
		//
		// Objects and arrays are serialised rather than stringified. `String({})`
		// is `"[object Object]"`, and that is what used to land in AI prompts and
		// Slack messages: the reference resolved, so nothing warned, and the
		// value was gone. The AI generator emits exactly this shape — a trigger
		// node outputs `{ triggered, data }`, and generated graphs reference
		// `{{Trigger.data}}` — so the useless form was the common one.
		const formatValue = (value: unknown): string => {
			const strValue =
				typeof value === "object" && value !== null
					? JSON.stringify(value)
					: String(value);
			return escapeForJson ? escapeJsonStringValue(strValue) : strValue;
		};

		// Split by the last dot to separate node name from property
		// Handle cases like "Generate Text.text" -> ["Generate Text", "text"]
		const lastDotIndex = trimmedKey.lastIndexOf(".");
		if (lastDotIndex === -1) {
			// No dot - just a simple variable name
			const value = variables[trimmedKey];
			if (value !== undefined) {
				return formatValue(value);
			}
			return miss();
		}

		const nodeName = trimmedKey.substring(0, lastDotIndex);
		const propertyPath = trimmedKey.substring(lastDotIndex + 1);

		// Get the node's output
		const nodeOutput = variables[nodeName];
		if (nodeOutput === undefined) {
			// Try with nested property access for $nodeId format
			const value = trimmedKey
				.split(".")
				.reduce((obj: unknown, k: string) => {
					if (obj && typeof obj === "object" && k in obj) {
						return (obj as Record<string, unknown>)[k];
					}
					return undefined;
				}, variables);
			if (value !== undefined) {
				return formatValue(value);
			}
			return miss();
		}

		// Access the property on the node output
		if (nodeOutput && typeof nodeOutput === "object") {
			const value = propertyPath
				.split(".")
				.reduce((obj: unknown, k: string) => {
					if (obj && typeof obj === "object" && k in obj) {
						return (obj as Record<string, unknown>)[k];
					}
					return undefined;
				}, nodeOutput);
			if (value !== undefined) {
				return formatValue(value);
			}
		}

		return miss();
	});

	return { text, unresolved };
}

/**
 * Interpolate template variables in a string.
 *
 * Thin wrapper over {@link interpolateTemplateWithDiagnostics} for the ~47
 * call sites that only want the resolved string. Unresolved references are
 * warned about here so they are at least visible in worker logs; surfacing
 * them per-node in the execution log is tracked separately.
 */
export function interpolateTemplate(
	template: string,
	variables: Record<string, unknown>,
	options?: { escapeForJson?: boolean },
): string {
	const { text, unresolved } = interpolateTemplateWithDiagnostics(
		template,
		variables,
		options,
	);

	if (unresolved.length > 0) {
		console.warn(
			`[Template] Unresolved reference(s) resolved to empty: ${unresolved
				.map((key) => `{{${key}}}`)
				.join(", ")}. Check the referenced node name and output field.`,
		);
	}

	return text;
}

/**
 * Format output for human-readable display
 * Converts JSON to readable text, extracts key content from common response formats
 */
export function formatOutputForDisplay(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (result === null || result === undefined) {
		return "";
	}

	// Handle common response formats
	if (typeof result === "object") {
		const obj = result as Record<string, unknown>;

		// MCP tools often return { content: [{ type: "text", text: "..." }] }
		if (Array.isArray(obj.content)) {
			const textParts = obj.content
				.filter(
					(c: unknown) =>
						typeof c === "object" &&
						c !== null &&
						(c as Record<string, unknown>).type === "text",
				)
				.map(
					(c: unknown) =>
						(c as Record<string, unknown>).text as string,
				);
			if (textParts.length > 0) {
				return textParts.join("\n");
			}
		}

		// Extract text content from common fields
		if (obj.content && typeof obj.content === "string") {
			return obj.content;
		}
		if (obj.text && typeof obj.text === "string") {
			return obj.text;
		}
		if (obj.message && typeof obj.message === "string") {
			return obj.message;
		}
		if (obj.data && typeof obj.data === "string") {
			return obj.data;
		}

		// Firecrawl search results format: { success: true, data: [...] }
		if (obj.success && Array.isArray(obj.data)) {
			return formatArrayForDisplay(obj.data as unknown[]);
		}

		// Handle array of results (e.g., search results)
		if (Array.isArray(result)) {
			return formatArrayForDisplay(result);
		}

		// Pretty print JSON with 2-space indentation
		return JSON.stringify(result, null, 2);
	}

	return String(result);
}

/**
 * Format an array of items for display (e.g., search results)
 */
export function formatArrayForDisplay(items: unknown[]): string {
	return items
		.map((item, i) => {
			if (typeof item === "string") {
				return `${i + 1}. ${item}`;
			}
			if (typeof item === "object" && item !== null) {
				const itemObj = item as Record<string, unknown>;
				const title = itemObj.title || itemObj.name || "";
				const desc =
					itemObj.description ||
					itemObj.snippet ||
					itemObj.markdown ||
					itemObj.content ||
					"";
				const url = itemObj.url || itemObj.link || "";

				let formatted = "";
				if (title) {
					formatted += `${i + 1}. ${title}`;
				}
				if (desc) {
					formatted += `\n${String(desc).substring(0, 300)}${String(desc).length > 300 ? "..." : ""}`;
				}
				if (url) {
					formatted += `\n${url}`;
				}
				return formatted || `${i + 1}. ${JSON.stringify(item)}`;
			}
			return `${i + 1}. ${JSON.stringify(item)}`;
		})
		.join("\n\n");
}

/**
 * Format output for Slack with proper mrkdwn formatting
 */
export function formatOutputForSlack(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (result === null || result === undefined) {
		return "_No results_";
	}

	if (typeof result === "object") {
		const obj = result as Record<string, unknown>;

		// MCP tools often return { content: [{ type: "text", text: "..." }] }
		if (Array.isArray(obj.content)) {
			const textParts = obj.content
				.filter(
					(c: unknown) =>
						typeof c === "object" &&
						c !== null &&
						(c as Record<string, unknown>).type === "text",
				)
				.map(
					(c: unknown) =>
						(c as Record<string, unknown>).text as string,
				);
			if (textParts.length > 0) {
				return textParts.join("\n");
			}
		}

		// Extract text content
		if (obj.content && typeof obj.content === "string") {
			return obj.content;
		}
		if (obj.text && typeof obj.text === "string") {
			return obj.text;
		}

		// Firecrawl search results format: { success: true, data: [...] }
		if (obj.success && Array.isArray(obj.data)) {
			return formatArrayForSlack(obj.data as unknown[]);
		}

		// Handle array of search results nicely for Slack
		if (Array.isArray(result)) {
			return formatArrayForSlack(result);
		}

		// For simple objects with just a few fields, show them nicely
		const keys = Object.keys(obj);
		if (keys.length <= 5 && keys.every((k) => typeof obj[k] !== "object")) {
			return keys.map((k) => `*${k}:* ${obj[k]}`).join("\n");
		}

		// For complex objects, use code block with formatted JSON
		const jsonStr = JSON.stringify(result, null, 2);
		if (jsonStr.length > 2000) {
			return `\`\`\`${jsonStr.substring(0, 2000)}\n... (truncated)\`\`\``;
		}
		return `\`\`\`${jsonStr}\`\`\``;
	}

	return String(result);
}

/**
 * Format an array of items for Slack (e.g., search results)
 */
export function formatArrayForSlack(items: unknown[]): string {
	if (items.length === 0) {
		return "_No results found_";
	}

	return items
		.slice(0, 10) // Limit to 10 for Slack
		.map((item, i) => {
			if (typeof item === "string") {
				return `• ${item}`;
			}
			if (typeof item === "object" && item !== null) {
				const itemObj = item as Record<string, unknown>;
				const title = itemObj.title || itemObj.name || "";
				const desc =
					itemObj.description ||
					itemObj.snippet ||
					itemObj.markdown ||
					itemObj.content ||
					"";
				const url = itemObj.url || itemObj.link || "";

				let formatted = "";
				if (title) {
					formatted += `*${i + 1}. ${title}*`;
				} else {
					formatted += `*${i + 1}.*`;
				}
				if (desc) {
					formatted += `\n${String(desc).substring(0, 200)}${String(desc).length > 200 ? "..." : ""}`;
				}
				if (url) {
					formatted += `\n<${url}|View>`;
				}
				return formatted;
			}
			return `• ${JSON.stringify(item)}`;
		})
		.join("\n\n");
}
