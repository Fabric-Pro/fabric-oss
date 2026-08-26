/**
 * JSON Parsing Utilities
 *
 * Robust extraction of JSON from AI model responses.
 * Handles cases where model outputs text before/after JSON, or markdown code blocks.
 */

/**
 * Safely extract and parse JSON from AI model response text.
 * Handles cases where model outputs text before/after JSON, or markdown code blocks.
 *
 * @param text - Raw text from AI model
 * @param type - "object" for {} or "array" for []
 * @returns Parsed JSON or null if parsing fails
 */
export function safeParseJson<T>(
	text: string,
	type: "object" | "array" = "object",
): T | null {
	if (!text) {
		return null;
	}

	// Remove markdown code blocks if present
	const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "");

	// Try parsing the cleaned text directly first
	try {
		const parsed = JSON.parse(cleaned.trim());
		const isExpectedType =
			type === "array"
				? Array.isArray(parsed)
				: typeof parsed === "object";
		if (isExpectedType) {
			return parsed as T;
		}
	} catch {
		// Continue to regex extraction
	}

	// Extract JSON using balanced bracket matching
	const startChar = type === "array" ? "[" : "{";
	const endChar = type === "array" ? "]" : "}";

	const startIdx = cleaned.indexOf(startChar);
	if (startIdx === -1) {
		return null;
	}

	let depth = 0;
	let endIdx = -1;

	for (let i = startIdx; i < cleaned.length; i++) {
		if (cleaned[i] === startChar) {
			depth++;
		} else if (cleaned[i] === endChar) {
			depth--;
		}

		if (depth === 0) {
			endIdx = i;
			break;
		}
	}

	if (endIdx === -1) {
		return null;
	}

	const jsonStr = cleaned.slice(startIdx, endIdx + 1);
	try {
		return JSON.parse(jsonStr) as T;
	} catch (e) {
		console.error("[safeParseJson] Failed to parse extracted JSON:", {
			error: e instanceof Error ? e.message : "Unknown error",
			sample: jsonStr.slice(0, 200),
		});
		return null;
	}
}
