/**
 * Adaptive-only Claude (Opus 4.7/4.8 and the 5.x generation) rejects any
 * non-default `temperature` / `top_p` / `top_k`, and `@langchain/anthropic`
 * throws client-side when one is set.
 *
 * Mirror of `isAnthropicAdaptiveOnlyModel` in
 * `packages/agent-types/src/anthropic-model-constraints.ts` — this Next app
 * does not depend on or transpile workspace packages (same reason
 * `DEFAULT_MODEL` in ./constants.ts is copied), so keep the two patterns in
 * step.
 */
const ADAPTIVE_ONLY_CLAUDE_RE =
	/(?:^|[^a-z0-9])claude-(?:opus-4[.-][78]|(?:opus|sonnet|fable|mythos)-5|mythos-preview)(?![0-9])/i;

export function isAnthropicAdaptiveOnlyModel(model: string): boolean {
	return ADAPTIVE_ONLY_CLAUDE_RE.test(model);
}

/** `{ temperature }` when the Claude model accepts it, else nothing. */
export function anthropicTemperature(
	model: string,
	temperature: number,
): { temperature?: number } {
	return isAnthropicAdaptiveOnlyModel(model) ? {} : { temperature };
}
