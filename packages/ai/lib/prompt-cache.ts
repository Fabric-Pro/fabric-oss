/**
 * Provider-agnostic prompt-cache markers for repeated LLM prompt prefixes.
 *
 * The caching MECHANISM is the stable prefix itself: OpenAI and Gemini
 * automatically cache a long, unchanging prompt prefix, so they benefit with no
 * marker at all. The `anthropic.cacheControl` breakpoint these helpers attach is
 * purely ADDITIVE — the AI SDK routes provider options by namespace, so a
 * non-Anthropic provider never reads the `anthropic` key and the marker is a
 * silent no-op there. There is deliberately NO branch on provider name: the
 * marker is always safe to attach, which is exactly what keeps caching
 * provider-agnostic.
 *
 * Two shapes for the two ways a prefix repeats:
 *  - {@link cacheableSystem} — a `system` message whose whole content is a cache
 *    breakpoint. For single-shot fan-outs that resend the SAME large system
 *    guidance on every call while only the user payload varies (e.g. the AI
 *    scanners: identical rubric per content chunk).
 *  - {@link withRollingCacheBreakpoint} — marks the LAST message so an
 *    append-only conversation is cached up to that point. For iterative agents
 *    that resend a GROWING message history every turn (e.g. the report agent
 *    loop): one breakpoint on the last message caches tools + system + every
 *    prior message, and each turn reuses the prefix the previous turn wrote.
 */

/**
 * The additive Anthropic ephemeral-cache breakpoint. Attach as `providerOptions`
 * on the message that should terminate the cached prefix. A no-op for providers
 * other than Anthropic.
 */
export const ANTHROPIC_EPHEMERAL_CACHE = {
	anthropic: { cacheControl: { type: "ephemeral" } },
} as const;

/**
 * A `system` model message whose prefix is a provider-agnostic cache breakpoint.
 * Pass as the `system` field of a `generateObject` / `generateText` / `streamText`
 * call so the fixed guidance isn't re-billed on every call in a fan-out.
 */
export function cacheableSystem(content: string) {
	return {
		role: "system" as const,
		content,
		providerOptions: ANTHROPIC_EPHEMERAL_CACHE,
	};
}

/**
 * Return a COPY of `messages` with a single rolling cache breakpoint on the last
 * message (a no-op on non-Anthropic providers). The input array is never
 * mutated, so a caller's persistent conversation history never accumulates
 * markers — each turn's request carries exactly one breakpoint, on its current
 * last message. That one breakpoint caches everything before it (tools, system,
 * and all prior messages), which is the whole append-only prefix.
 */
export function withRollingCacheBreakpoint(
	messages: readonly unknown[],
): unknown[] {
	if (messages.length === 0) {
		return [...messages];
	}
	const lastIndex = messages.length - 1;
	return messages.map((message, index) =>
		index === lastIndex && message !== null && typeof message === "object"
			? { ...message, providerOptions: ANTHROPIC_EPHEMERAL_CACHE }
			: message,
	);
}
