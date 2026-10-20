import { writeFileSync } from "node:fs";

/**
 * Emits a PreToolUse permission decision as JSON on stdout. The caller
 * must `process.exit(0)` afterward — exit 0 with this JSON is what Claude
 * Code treats as authoritative (the legacy "exit 2 = block" convention is
 * only used when a hook does NOT print decision JSON).
 *
 * `"ask"` escalates to an interactive user confirmation prompt; `reason`
 * is shown to the user there (it is not routed into the model's
 * conversation), so put the human-actionable findings in it.
 *
 * @param {string} reason
 */
export function writeAskDecision(reason) {
	writeFileSync(
		1,
		`${JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "ask",
				permissionDecisionReason: reason,
			},
		})}\n`,
	);
}

/**
 * Emits a PreToolUse denial as JSON on stdout. Claude Code shows `reason`
 * to the model so it can act on the refusal. The caller must exit 0 afterward
 * for the decision JSON to be authoritative.
 *
 * @param {string} reason
 */
export function writeDenyDecision(reason) {
	writeFileSync(
		1,
		`${JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: reason,
			},
		})}\n`,
	);
}
