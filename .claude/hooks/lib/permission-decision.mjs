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
	process.stdout.write(
		`${JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "ask",
				permissionDecisionReason: reason,
			},
		})}\n`,
	);
}
