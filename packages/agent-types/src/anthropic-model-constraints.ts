/**
 * Anthropic request constraints keyed on model properties.
 *
 * Shared by the LangChain model factory (`@repo/agent-core`
 * `services/langchain-models.ts`) and the Temporal chat activities
 * (`@repo/temporal` direct-chat `build-provider-options.ts` /
 * `decide-forced-tool-choice.ts` and orchestrator `run-agent-iteration.ts`).
 * It lives here because this package has no dependencies, both consumers
 * already depend on it, and the LangGraph agent bundles inline it (they keep
 * `@repo/ai` external, so a helper there would become a runtime dependency of
 * every agent image).
 *
 * Model strings reach those paths in many spellings: bare
 * (`claude-opus-5-5`), Vercel gateway (`anthropic/claude-opus-5.5`), Bedrock
 * (`anthropic.claude-opus-5-5`, `us.anthropic.…`), Databricks
 * (`system.ai.claude-opus-5-5`, `databricks-claude-opus-5`) and dated
 * (`claude-opus-5-5-20260901`). The patterns therefore accept any
 * non-alphanumeric boundary before `claude-`, dotted or dashed minor
 * versions, and require the version not to continue with another digit
 * (`claude-sonnet-50` is not `claude-sonnet-5`).
 */

/**
 * Adaptive-only Claude: Opus 4.7/4.8 and the 5.x generation (Opus, Sonnet,
 * Fable, Mythos, including point releases such as Opus 5.5), plus the Mythos
 * preview id.
 *
 * Mirrors `ADAPTIVE_ONLY_MODEL_PREFIXES` in `@langchain/anthropic`
 * (`dist/utils/params.cjs`, which throws client-side for these) and the
 * `rejectsSamplingParameters` / `supportsAdaptiveThinking` rows of
 * `getModelCapabilities` in `@ai-sdk/anthropic`. Keep the three in step when
 * a vendor list changes.
 */
const ADAPTIVE_ONLY_CLAUDE_RE =
	/(?:^|[^a-z0-9])claude-(?:opus-4[.-][78]|(?:opus|sonnet|fable|mythos)-5|mythos-preview)(?![0-9])/i;

/**
 * Claude models that return HTTP 400 for a forced `tool_choice`
 * (`{type:"any"}` / `{type:"tool"}`, i.e. AI SDK `toolChoice: "required"` or
 * `{type:"tool", toolName}`) regardless of thinking settings: Opus 5.5,
 * Sonnet 5.5, Fable 5.1 and Mythos 5.1. `claude-opus-5` and `claude-sonnet-5`
 * accept a forced tool choice and are deliberately not matched.
 */
const REJECTS_FORCED_TOOL_CHOICE_CLAUDE_RE =
	/(?:^|[^a-z0-9])claude-(?:(?:opus|sonnet)-5[.-]5|(?:fable|mythos)-5[.-]1)(?![0-9])/i;

/**
 * True for Claude models whose only thinking on-mode is
 * `thinking: { type: "adaptive" }` (depth via `output_config.effort`). They
 * return HTTP 400 for `thinking: { type: "enabled", budget_tokens }` and for
 * any non-default `temperature` / `top_p` / `top_k`.
 */
export function isAnthropicAdaptiveOnlyModel(
	model: string | null | undefined,
): boolean {
	return model ? ADAPTIVE_ONLY_CLAUDE_RE.test(model) : false;
}

/**
 * True for Claude models that reject a forced `tool_choice` outright. Callers
 * must fall back to `"auto"` (plus whatever prompt steering they already
 * apply) instead of forcing a tool for these models.
 */
export function anthropicModelRejectsForcedToolChoice(
	model: string | null | undefined,
): boolean {
	return model ? REJECTS_FORCED_TOOL_CHOICE_CLAUDE_RE.test(model) : false;
}
