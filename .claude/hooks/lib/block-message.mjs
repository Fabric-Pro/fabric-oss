const DEFAULT_PROCEED_HINT =
	'run outside Claude Code, or temporarily set "disableAllHooks": true in .claude/settings.local.json';

const MAX_COMMAND_LENGTH = 120;

/**
 * @typedef {Object} BlockMessageOptions
 * @property {string} command         The literal user-supplied command (truncated to ~120 chars).
 * @property {string} reason          One-line reason. Will be paired with the source ref.
 * @property {string} sourceRef       e.g. `CLAUDE.md:175-176` or `CONTRIBUTING.md:69`.
 * @property {string} [proceedHint]   Overrides the default escape-paths line.
 */

/**
 * Truncates `command` so the rendered block message stays readable.
 * @param {string} command
 */
function truncate(command) {
	if (command.length <= MAX_COMMAND_LENGTH) {
		return command;
	}
	return `${command.slice(0, MAX_COMMAND_LENGTH - 1)}…`;
}

/**
 * Writes the verbatim three-line block message to stderr. Caller is
 * responsible for `process.exit(2)` afterwards.
 *
 * @param {BlockMessageOptions} options
 */
export function writeBlockMessage(options) {
	const { command, reason, sourceRef, proceedHint } = options;
	const lines = [
		`Blocked: '${truncate(command)}'`,
		`Reason: ${reason} (${sourceRef})`,
		`To proceed: ${proceedHint ?? DEFAULT_PROCEED_HINT}`,
	];
	process.stderr.write(`${lines.join("\n")}\n`);
}
