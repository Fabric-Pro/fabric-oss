#!/usr/bin/env node
import { writeBlockMessage } from "./lib/block-message.mjs";
import { readToolInput } from "./lib/parse-input.mjs";

/**
 * Forbidden phrases. The first is matched case-insensitively (spec §3.3
 * table); the other two are literal — collaborators sometimes write
 * about "generated" or "🤖" in legitimate contexts, so we require the
 * exact phrasing the policy forbids.
 */
const FORBIDDEN = [
	{
		needle: "co-authored-by: claude",
		caseInsensitive: true,
		label: "Co-Authored-By: Claude",
	},
	{
		needle: "Generated with Claude Code",
		caseInsensitive: false,
		label: "Generated with Claude Code",
	},
	{ needle: "🤖 Generated", caseInsensitive: false, label: "🤖 Generated" },
];

/**
 * Whole-command substring scan. This catches heredoc bodies, `--body`
 * strings, `-m` arguments, and any other place the forbidden phrase
 * might appear — defense-in-depth without per-flag tokenization.
 *
 * @param {string} command
 * @returns {string | null}    the label of the matched phrase, or null
 */
function detectForbidden(command) {
	const lower = command.toLowerCase();
	for (const { needle, caseInsensitive, label } of FORBIDDEN) {
		if (caseInsensitive) {
			if (lower.includes(needle)) {
				return label;
			}
		} else if (command.includes(needle)) {
			return label;
		}
	}
	return null;
}

/**
 * Restrict to `git commit` and `gh pr ...` — pre-filtered by the `if`
 * matcher in settings.json, but defense-in-depth: short-circuit here
 * too in case the matcher is misconfigured or a test invokes the hook
 * directly.
 *
 * @param {string} command
 */
function isInScope(command) {
	const trimmed = command.trimStart();
	return trimmed.startsWith("git commit") || trimmed.startsWith("gh pr");
}

function main() {
	let toolCall;
	try {
		toolCall = readToolInput();
	} catch (err) {
		process.stderr.write(`block-claude-attribution: ${err.message}\n`);
		process.exit(0);
	}

	if (toolCall.tool_name !== "Bash") {
		process.exit(0);
	}
	const command = String(toolCall.tool_input?.command ?? "");
	if (!command || !isInScope(command)) {
		process.exit(0);
	}

	const matched = detectForbidden(command);
	if (!matched) {
		process.exit(0);
	}

	writeBlockMessage({
		command,
		reason: `Claude attribution ("${matched}") is forbidden in commit messages and PR bodies`,
		sourceRef: "CLAUDE.md:175-176",
		proceedHint:
			"rewrite the message without the attribution line, " +
			'or set "disableAllHooks": true in .claude/settings.local.json',
	});
	process.exit(2);
}

main();
