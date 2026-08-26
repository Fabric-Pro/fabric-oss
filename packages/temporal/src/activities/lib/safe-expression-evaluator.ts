/**
 * Safe Expression Evaluator
 *
 * Replaces dangerous eval() with a safe expression parser.
 * Supports basic comparison operators and logical operations.
 */

type ExpressionContext = Record<string, unknown>;

/**
 * Safely evaluate a simple expression without using eval()
 * Supports: ==, ===, !=, !==, >, <, >=, <=, &&, ||, !
 */
export function safeEvaluateExpression(
	expression: string,
	context: ExpressionContext,
): boolean {
	// Interpolate variables first
	let interpolated = interpolateExpression(expression, context);

	// Remove any potential dangerous characters
	interpolated = sanitizeExpression(interpolated);

	// Parse and evaluate the expression
	return evaluateSimpleExpression(interpolated);
}

/**
 * Interpolate template variables like {{variable.field}}
 */
function interpolateExpression(
	expression: string,
	context: ExpressionContext,
): string {
	// `[^}]+` rather than `[\w.]+`: node references are written with the node's
	// *label*, and almost every default label contains a space — "Generate
	// Text", "HTTP Request", "Send Slack Message". A `\w`-only key silently
	// failed to match those, so the placeholder survived interpolation as
	// literal text, sanitising to something non-empty and therefore truthy.
	// A condition referencing any normally-named node was always true.
	// This matches the reference forms the step interpolator already accepts.
	return expression.replace(/\{\{([^}]+)\}\}/g, (_, rawKey) => {
		const key = String(rawKey).trim();
		const value = getNestedValue(context, key);
		// Return the value as a JSON-safe representation
		if (typeof value === "string") {
			return JSON.stringify(value);
		}
		if (value === undefined || value === null) {
			return "null";
		}
		return String(value);
	});
}

/**
 * Get nested value from object using dot notation
 */
function getNestedValue(obj: ExpressionContext, path: string): unknown {
	const keys = path.split(".");
	let current: unknown = obj;

	for (const key of keys) {
		if (current === null || current === undefined) {
			return undefined;
		}
		if (typeof current === "object" && key in current) {
			current = (current as Record<string, unknown>)[key];
		} else {
			return undefined;
		}
	}

	return current;
}

/**
 * Sanitize expression to only allow safe characters
 */
function sanitizeExpression(expression: string): string {
	// Only allow: alphanumerics, spaces, quotes, comparison operators, logical operators, parentheses
	const sanitized = expression.replace(/[^a-zA-Z0-9\s'"=!<>&|().,_\-+]/g, "");
	return sanitized;
}

/**
 * Recognise `<subject>.includes(<quoted needle>)`.
 *
 * The subject is whatever the template interpolated — usually a node's text
 * output — and is compared literally, so surrounding quotes on either side are
 * stripped. Returns null when the expression is not a substring test, leaving
 * the comparison path untouched.
 */
function matchSubstringTest(
	expression: string,
): { haystack: string; needle: string } | null {
	const match = expression.match(
		/^(.*)\.includes\(\s*(['"])([\s\S]*?)\2\s*\)$/,
	);
	if (!match) {
		return null;
	}

	const subject = match[1].trim();
	const unquoted =
		(subject.startsWith('"') && subject.endsWith('"')) ||
		(subject.startsWith("'") && subject.endsWith("'"))
			? subject.slice(1, -1)
			: subject;

	return { haystack: unquoted, needle: match[3] };
}

/**
 * Evaluate a simple boolean expression
 * Supports basic comparisons and logical operations
 */
function evaluateSimpleExpression(expression: string): boolean {
	const trimmed = expression.trim();

	// Handle logical operators (lowest precedence)
	const orParts = splitByOperator(trimmed, "||");
	if (orParts.length > 1) {
		return orParts.some((part) => evaluateSimpleExpression(part));
	}

	const andParts = splitByOperator(trimmed, "&&");
	if (andParts.length > 1) {
		return andParts.every((part) => evaluateSimpleExpression(part));
	}

	// Handle NOT operator
	if (trimmed.startsWith("!") && !trimmed.startsWith("!=")) {
		return !evaluateSimpleExpression(trimmed.slice(1));
	}

	// Handle parentheses
	if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
		return evaluateSimpleExpression(trimmed.slice(1, -1));
	}

	// Substring tests, before the comparison fallback.
	//
	// This is the shape the builder advertises — the AI generator is told to
	// emit `{{Node.text}}.includes('success')`, and the docs show the same —
	// but nothing evaluated it. With no comparison operator the expression fell
	// through to a truthiness check on the whole interpolated string, which is
	// non-empty whenever the referenced node produced any text. A "contains"
	// condition therefore took its true branch every single time, silently
	// routing every run down one path.
	const substringTest = matchSubstringTest(trimmed);
	if (substringTest) {
		return substringTest.haystack.includes(substringTest.needle);
	}

	// Handle comparison operators
	return evaluateComparison(trimmed);
}

/**
 * Split expression by operator, respecting parentheses
 */
function splitByOperator(expression: string, operator: string): string[] {
	const parts: string[] = [];
	let current = "";
	let depth = 0;
	let i = 0;

	while (i < expression.length) {
		const char = expression[i];

		if (char === "(") {
			depth++;
			current += char;
		} else if (char === ")") {
			depth--;
			current += char;
		} else if (
			depth === 0 &&
			expression.slice(i, i + operator.length) === operator
		) {
			parts.push(current.trim());
			current = "";
			i += operator.length;
			continue;
		} else {
			current += char;
		}
		i++;
	}

	if (current.trim()) {
		parts.push(current.trim());
	}

	return parts;
}

/**
 * Evaluate a simple comparison expression
 */
function evaluateComparison(expression: string): boolean {
	// Match comparison operators
	const operators = ["===", "!==", "==", "!=", ">=", "<=", ">", "<"];

	for (const op of operators) {
		const parts = expression.split(op);
		if (parts.length === 2) {
			const left = parseValue(parts[0].trim());
			const right = parseValue(parts[1].trim());

			switch (op) {
				case "===":
					return left === right;
				case "!==":
					return left !== right;
				case "==":
					// biome-ignore lint/suspicious/noDoubleEquals: Intentional loose comparison
					return left == right;
				case "!=":
					// biome-ignore lint/suspicious/noDoubleEquals: Intentional loose comparison
					return left != right;
				case ">":
					return Number(left) > Number(right);
				case "<":
					return Number(left) < Number(right);
				case ">=":
					return Number(left) >= Number(right);
				case "<=":
					return Number(left) <= Number(right);
			}
		}
	}

	// If no operator, treat as truthy check
	const value = parseValue(expression);
	return Boolean(value);
}

/**
 * Parse a value from string representation
 */
function parseValue(str: string): unknown {
	const trimmed = str.trim();

	// Handle quoted strings
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}

	// Handle null/undefined
	if (trimmed === "null" || trimmed === "undefined") {
		return null;
	}

	// Handle booleans
	if (trimmed === "true") {
		return true;
	}
	if (trimmed === "false") {
		return false;
	}

	// Handle numbers
	const num = Number(trimmed);
	if (!Number.isNaN(num)) {
		return num;
	}

	// Return as string
	return trimmed;
}
