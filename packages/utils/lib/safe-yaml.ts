/**
 * Safe JSON / YAML parsing for untrusted documents (plan Slice 4).
 *
 * - YAML is parsed with the `yaml` package's core schema (no custom tags, no
 *   code execution) and an alias-expansion budget so "billion laughs"
 *   documents fail fast instead of exhausting memory.
 * - Both JSON and YAML results are depth-checked after parsing; anything
 *   nested deeper than `maxDepth` (default 50) is rejected.
 * - Callers are expected to size-cap the input before parsing (the pinned
 *   fetch does this); `maxBytes` here is a second guard.
 */

import { parse as parseYaml } from "yaml";

export interface SafeParseOptions {
	/** Maximum nesting depth of the parsed document (default 50). */
	maxDepth?: number;
	/** Maximum YAML alias expansions (default 100). */
	maxAliasCount?: number;
	/** Maximum input size in bytes (default 5 MB). */
	maxBytes?: number;
}

export const SAFE_PARSE_DEFAULT_MAX_DEPTH = 50;
export const SAFE_PARSE_DEFAULT_MAX_ALIAS_COUNT = 100;
export const SAFE_PARSE_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export class UnsafeDocumentError extends Error {
	readonly code: "TOO_DEEP" | "TOO_LARGE" | "ALIAS_LIMIT" | "PARSE_ERROR";
	constructor(code: UnsafeDocumentError["code"], message: string) {
		super(message);
		this.name = "UnsafeDocumentError";
		this.code = code;
	}
}

/** Iterative depth check (no recursion, so a deep document cannot blow the stack). */
export function assertMaxDepth(value: unknown, maxDepth: number): void {
	const stack: Array<{ value: unknown; depth: number }> = [
		{ value, depth: 0 },
	];
	while (stack.length > 0) {
		const item = stack.pop();
		if (!item) {
			break;
		}
		const { value: current, depth } = item;
		if (current === null || typeof current !== "object") {
			continue;
		}
		if (depth >= maxDepth) {
			throw new UnsafeDocumentError(
				"TOO_DEEP",
				`Document nesting exceeds ${maxDepth} levels`,
			);
		}
		const children = Array.isArray(current)
			? current
			: current instanceof Map
				? Array.from(current.values())
				: Object.values(current as Record<string, unknown>);
		for (const child of children) {
			if (child !== null && typeof child === "object") {
				stack.push({ value: child, depth: depth + 1 });
			}
		}
	}
}

function assertSize(text: string, maxBytes: number): void {
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		throw new UnsafeDocumentError(
			"TOO_LARGE",
			`Document exceeds ${maxBytes} bytes`,
		);
	}
}

export function parseJsonSafe(
	text: string,
	options: SafeParseOptions = {},
): unknown {
	const maxDepth = options.maxDepth ?? SAFE_PARSE_DEFAULT_MAX_DEPTH;
	assertSize(text, options.maxBytes ?? SAFE_PARSE_DEFAULT_MAX_BYTES);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new UnsafeDocumentError(
			"PARSE_ERROR",
			`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	assertMaxDepth(parsed, maxDepth);
	return parsed;
}

export function parseYamlSafe(
	text: string,
	options: SafeParseOptions = {},
): unknown {
	const maxDepth = options.maxDepth ?? SAFE_PARSE_DEFAULT_MAX_DEPTH;
	const maxAliasCount =
		options.maxAliasCount ?? SAFE_PARSE_DEFAULT_MAX_ALIAS_COUNT;
	assertSize(text, options.maxBytes ?? SAFE_PARSE_DEFAULT_MAX_BYTES);
	let parsed: unknown;
	try {
		parsed = parseYaml(text, {
			schema: "core",
			maxAliasCount,
			uniqueKeys: false,
			logLevel: "silent",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const code = /alias/i.test(message) ? "ALIAS_LIMIT" : "PARSE_ERROR";
		throw new UnsafeDocumentError(code, `Invalid YAML: ${message}`);
	}
	assertMaxDepth(parsed, maxDepth);
	return parsed;
}

/**
 * Parse a document that may be JSON or YAML. JSON is tried first when the
 * text looks like JSON (leading `{` / `[`); YAML is a superset of JSON so
 * the fallback still covers JSON with a BOM or leading comments.
 */
export function parseJsonOrYamlSafe(
	text: string,
	options: SafeParseOptions = {},
): unknown {
	const trimmed = text.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return parseJsonSafe(text, options);
		} catch (error) {
			if (
				error instanceof UnsafeDocumentError &&
				error.code !== "PARSE_ERROR"
			) {
				throw error;
			}
			// Fall through to YAML for JSON-looking YAML (e.g. flow mappings).
		}
	}
	return parseYamlSafe(text, options);
}
