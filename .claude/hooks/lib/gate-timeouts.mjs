/**
 * Time budget for the pr-quality-gate hook.
 *
 * Claude Code does not block the tool call when a command hook times out: the
 * hook's output is discarded and the call proceeds unchecked. So the gate must
 * finish, and say so, before the hook timeout. The per-check limits below
 * therefore have to sum to less than HOOK_TIMEOUT_SECONDS, leaving margin for
 * the git calls and the process-group teardown. settings-routing.test.mjs
 * enforces both that `.claude/settings.json` uses HOOK_TIMEOUT_SECONDS and that
 * the sum plus 30 s of margin stays within it.
 */
export const HOOK_TIMEOUT_SECONDS = 600;

/** Per-check limits in milliseconds. A check over its limit becomes an "ask". */
export const CHECK_TIMEOUTS_MS = {
	typeCheck: 420_000,
	lint: 60_000,
	format: 60_000,
};

/**
 * Test seam: a positive FABRIC_GATE_TIMEOUT_MS (milliseconds) shortens every
 * check's limit. It can only shorten: a larger value is ignored, so an
 * inherited override cannot push a check past the hook timeout.
 *
 * @param {number} defaultMs
 * @param {Record<string, string | undefined>} [env]
 */
export function effectiveTimeoutMs(defaultMs, env = process.env) {
	const override = Number(env.FABRIC_GATE_TIMEOUT_MS);
	return Number.isFinite(override) && override > 0
		? Math.min(override, defaultMs)
		: defaultMs;
}
