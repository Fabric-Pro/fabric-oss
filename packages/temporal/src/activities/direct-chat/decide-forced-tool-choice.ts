import { anthropicModelRejectsForcedToolChoice } from "@repo/agent-types";

/**
 * Selects the `toolChoice` argument for the direct-chat `streamText` call
 * (and, for its frame/slideshow force, the orchestrator's
 * `run-agent-iteration.ts`).
 *
 * Three business rules encoded here:
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
 *   3. Some Claude models (`anthropicModelRejectsForcedToolChoice` in
 *      `@repo/agent-types`: Opus 5.5, Fable 5.1, Mythos 5.1) return HTTP 400
 *      for ANY forced `tool_choice`, whatever the thinking setting — Opus
 *      5.5 cannot even disable thinking. For them we never force, on any
 *      provider route. Callers pass every name that identifies the
 *      resolved model in `modelNames` (catalog canonical name and wire
 *      model string: a Databricks serving alias alone hides the model).
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
	/** Names identifying the resolved model (e.g. catalog canonical name and
	 *  wire model string). When any of them names a model that rejects a
	 *  forced `tool_choice`, we never emit a `{type:"tool"}` force. */
	modelNames?: ReadonlyArray<string | null | undefined>;
}

/** True when any of `modelNames` rejects a forced `tool_choice`. */
export function modelRejectsForcedToolChoice(
	modelNames: ReadonlyArray<string | null | undefined> | undefined,
): boolean {
	return (modelNames ?? []).some((name) =>
		anthropicModelRejectsForcedToolChoice(name),
	);
}

export function decideForcedToolChoice(
	input: DecideForcedToolChoiceInput,
): ForcedToolChoice {
	const { forcedToolName, availableTools, thinkingEnabled, modelNames } =
		input;
	const hasTools = Object.keys(availableTools).length > 0;

	if (!hasTools) {
		return undefined;
	}

	if (
		forcedToolName &&
		forcedToolName in availableTools &&
		!thinkingEnabled &&
		!modelRejectsForcedToolChoice(modelNames)
	) {
		return { type: "tool", toolName: forcedToolName };
	}

	return "auto";
}
