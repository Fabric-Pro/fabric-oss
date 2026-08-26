/**
 * Variable Detection Utility
 * Detects common variable-like patterns in text that could be converted
 * to our supported format: ${variableName} or ${variableName:default}
 *
 * Ported from awesome-chatgpt-prompts with enhancements for Fabric
 */

export interface DetectedVariable {
	original: string;
	name: string;
	defaultValue?: string;
	pattern: VariablePattern;
	startIndex: number;
	endIndex: number;
}

type VariablePattern =
	| "double_bracket" // [[name]] or [[ name ]]
	| "double_curly" // {{name}} or {{ name }}
	| "single_bracket" // [NAME] or [name]
	| "single_curly" // {NAME} or {name}
	| "angle_bracket" // <NAME> or <name>
	| "percent" // %NAME% or %name%
	| "dollar_curly"; // ${name} (our standard format)

/**
 * Parse ${variablename:defaultvalue} or ${variablename} patterns
 * This is the standard format used in the prompt system
 */
export function parseVariables(content: string): DetectedVariable[] {
	const regex = /\$\{([^:}]+)(?::([^}]*))?\}/g;
	const variables: DetectedVariable[] = [];
	let match = regex.exec(content);

	while (match !== null) {
		variables.push({
			original: match[0],
			name: match[1].trim(),
			defaultValue: match[2]?.trim(),
			pattern: "dollar_curly",
			startIndex: match.index,
			endIndex: match.index + match[0].length,
		});

		match = regex.exec(content);
	}

	return variables;
}

/**
 * Get unique variable names with their default values
 */
export function getUniqueVariables(
	variables: DetectedVariable[],
): { name: string; defaultValue: string }[] {
	const seen = new Map<string, string>();
	for (const variable of variables) {
		if (!seen.has(variable.name)) {
			seen.set(variable.name, variable.defaultValue || "");
		}
	}
	return Array.from(seen.entries()).map(([name, defaultValue]) => ({
		name,
		defaultValue,
	}));
}

/**
 * Check if content has any variables (in our standard format)
 */
export function hasVariables(content: string): boolean {
	return /\$\{[^}]+\}/.test(content);
}

/**
 * Replace variables in content with provided values
 */
export function replaceVariables(
	content: string,
	values: Record<string, string>,
): string {
	return content.replace(
		/\$\{([^:}]+)(?::([^}]*))?\}/g,
		(match, name, defaultValue) => {
			const trimmedName = name.trim();
			return values[trimmedName] ?? defaultValue ?? match;
		},
	);
}
