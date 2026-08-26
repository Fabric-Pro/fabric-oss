/**
 * Selects the `toolChoice` argument for the direct-chat `streamText` call.
 *
 * Two business rules encoded here:
 *
 *   1. Only force a tool name that actually exists in `availableTools`.
 *      The AI SDK throws a no-tool error when the forced name is missing
 *      from `tools`, so we defensively demote to `"auto"`.
 *
 *   2. Anthropic rejects `providerOptions.anthropic.thinking={type:"enabled"}`
 *      combined with `tool_choice={type:"tool",name:...}` with HTTP 400:
 *        "Thinking may not be enabled when tool_choice forces tool use."
 *      The same constraint was hit by the LangGraph excalidraw agent
 *      (PR #1177, chat-node.ts) and fixed there by skipping the force on
 *      Anthropic models. This is the symmetric fix for the direct-chat
 *      Vercel-AI-SDK path. The single source-of-truth for "is thinking
 *      actually enabled?" is `buildProviderOptions(...) !== undefined` —
 *      callers should pass `thinkingEnabled` as that boolean.
 *
 * Returns:
 *   - `undefined`              — no tools registered; omit `toolChoice` from
 *                                the wire body entirely.
 *   - `"auto"`                 — let the model pick (fallback for any of the
 *                                demotion paths above).
 *   - `{type:"tool",toolName}` — pin the model to a specific tool.
 */
export type ForcedToolChoice =
	| { type: "tool"; toolName: string }
	| "auto"
	| undefined;

export interface DecideForcedToolChoiceInput {
	/** Tool name selected by the upstream prompt heuristic, or `undefined`
	 *  when the heuristic did not match (most prompts). */
	forcedToolName: string | undefined;
	/** Tool map handed to `streamText` — keys are the tool names the SDK
	 *  will recognize on the wire. We never force a key absent from this
	 *  map. */
	availableTools: Record<string, unknown>;
	/** `true` when Anthropic extended thinking will be enabled on this
	 *  request (i.e. `buildProviderOptions(...)` returned a truthy value).
	 *  When `true`, we never emit a `{type:"tool"}` force regardless of
	 *  the heuristic. */
	thinkingEnabled: boolean;
}

export function decideForcedToolChoice(
	input: DecideForcedToolChoiceInput,
): ForcedToolChoice {
	const { forcedToolName, availableTools, thinkingEnabled } = input;
	const hasTools = Object.keys(availableTools).length > 0;

	if (!hasTools) {
		return undefined;
	}

	if (
		forcedToolName &&
		forcedToolName in availableTools &&
		!thinkingEnabled
	) {
		return { type: "tool", toolName: forcedToolName };
	}

	return "auto";
}
