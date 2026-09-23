/**
 * The system-prompt line that tells the Direct chat model whether it has
 * tools this turn.
 *
 * The workflow retries a failed tools-bound turn once with tools disabled.
 * That retry used to get the same line as a user with nothing connected —
 * "No tools connected. Suggest the user connect tools in Settings." — so the
 * model confidently sent people to Settings for tools that were connected
 * and had merely failed (Fizzy #2040, review F4). The retry now says what
 * actually happened.
 */

const MAX_FAILURE_SUMMARY_CHARS = 300;

export function describeToolAvailability(params: {
	toolsEnabled: boolean;
	forceDisableTools?: boolean;
	toolFailureSummary?: string;
}): string {
	if (params.toolsEnabled) {
		return "- You have access to tools. Use them when they can help answer the user's question.";
	}
	if (!params.forceDisableTools) {
		return "- No tools connected. Suggest the user connect tools in Settings.";
	}
	const summary = params.toolFailureSummary?.trim();
	const reason = summary
		? ` The failure was: ${summary.slice(0, MAX_FAILURE_SUMMARY_CHARS)}`
		: "";
	return `- The user's tools ARE connected, but they failed earlier in this turn, so you are answering without them.${reason} Start by telling the user, in one short sentence, that their tools failed on this turn and this answer does not use them. Then answer as well as you can. Do not tell them to connect tools in Settings.`;
}
