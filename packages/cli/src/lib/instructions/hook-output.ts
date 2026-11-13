/**
 * What a `check --hook` or `sync --hook` run prints, written once when the
 * run ends, because the two coding tools read a SessionStart hook's stdout
 * one way or the other, never both:
 *
 *  - plain text is added to the agent's context and shown to nobody;
 *  - one JSON object is read for its fields: `systemMessage` is shown to the
 *    developer (Claude Code and Codex both document it as shown to the user),
 *    and `hookSpecificOutput.additionalContext` is the agent's context.
 *
 * Stderr is no channel at all: Claude Code drops what a hook that exits 0
 * wrote there. So a line meant for the developer (a skipped check, kept local
 * edits, what a new version changed, a self-update) is a message, and a line
 * meant for the agent (the checkout's state, a sign-in that cannot be used,
 * an upgrade) is context. With no message the context stays plain text, as
 * it always was; with one, both go in a single JSON object on one line, and
 * nothing else is written to stdout.
 */

export interface HookOutput {
	/** Lines for the agent's context. */
	context: string[];
	/** Lines for the developer, shown as the hook's message. */
	messages: string[];
}

export function emptyHookOutput(): HookOutput {
	return { context: [], messages: [] };
}

/** Everything the run prints on stdout, or `null` when it has nothing to say. */
export function hookOutputText(output: HookOutput): string | null {
	if (output.messages.length === 0) {
		return output.context.length === 0
			? null
			: `${output.context.join("\n")}\n`;
	}
	const message = {
		systemMessage: output.messages.join("\n"),
		...(output.context.length === 0
			? {}
			: {
					hookSpecificOutput: {
						hookEventName: "SessionStart",
						additionalContext: output.context.join("\n"),
					},
				}),
	};
	return `${JSON.stringify(message)}\n`;
}
