import { readFileSync } from "node:fs";

/**
 * @typedef {Object} ToolCall
 * @property {string} [session_id]
 * @property {string} tool_name
 * @property {Record<string, unknown>} tool_input
 * @property {string} [cwd] Session's current working directory, if the
 *   PreToolUse payload provided it (Claude Code includes it).
 */

/**
 * Reads the PreToolUse JSON payload from stdin and parses it.
 *
 * Throws on malformed JSON. Callers are expected to catch the throw,
 * write a diagnostic to stderr, and exit 0 (fail-open on hook-bug —
 * a broken hook must never lock the team out of Claude Code).
 *
 * @returns {ToolCall}
 */
export function readToolInput() {
	const raw = readFileSync(0, "utf8");
	const parsed = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null) {
		throw new TypeError("hook input was not a JSON object");
	}
	return {
		session_id: parsed.session_id,
		tool_name: parsed.tool_name,
		tool_input: parsed.tool_input ?? {},
		cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
	};
}
