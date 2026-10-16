/**
 * Provider-agnostic prompt-cache markers for repeated LLM prompt prefixes.
 *
 * The caching MECHANISM is the stable prefix itself: OpenAI and Gemini
 * automatically cache a long, unchanging prompt prefix, so they benefit with no
 * marker at all. The `anthropic.cacheControl` breakpoint these helpers attach is
 * purely ADDITIVE — the AI SDK routes provider options by namespace, so a
 * non-Anthropic provider never reads the `anthropic` key and the marker is a
 * silent no-op there. The marker helpers below deliberately do NOT branch on
 * provider name: the marker is safe to attach, which is exactly what keeps
 * caching provider-agnostic. The `prepareStep` helpers at the end of this file
 * are the exception: they return `undefined` unless the model passes
 * {@link isPromptCacheTarget}, because gateways such as Bedrock and Foundry use
 * request adapters that do not take the marker.
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
 *
 * Within one multi-step AI SDK call, the `prepareStep` helpers at the end of
 * this file move a breakpoint from step to step instead (see
 * {@link makeStepCacheBreakpoint}).
 */

import type { ModelMessage } from "ai";

/**
 * The additive Anthropic ephemeral-cache breakpoint. Attach as `providerOptions`
 * on the message that should terminate the cached prefix. A no-op for providers
 * other than Anthropic.
 */
export const ANTHROPIC_EPHEMERAL_CACHE = {
	anthropic: { cacheControl: { type: "ephemeral" } },
} as const;

/**
 * Returns whether a resolved model uses an Anthropic request path that supports
 * Fabric's explicit prompt-cache breakpoints.
 *
 * Direct Anthropic models always qualify. Vercel AI Gateway only qualifies
 * when its resolved model name is a Claude route. Bedrock, Foundry, and other
 * gateways use different request adapters and are intentionally excluded.
 */
export function isPromptCacheTarget(
	provider: string,
	modelString: string,
): boolean {
	if (provider === "ANTHROPIC_DIRECT") {
		return true;
	}
	if (provider !== "VERCEL_GATEWAY") {
		return false;
	}

	const normalizedModel = modelString.toLowerCase();
	return (
		normalizedModel.startsWith("claude") ||
		normalizedModel.startsWith("anthropic/")
	);
}

const MID_CONVERSATION_SYSTEM_MODEL_PATTERN =
	/^claude-(?:fable-5-1|mythos-5|opus-4(?:-8|\.8)|opus-5)(?:$|[-@:])/;

/**
 * Fail-closed capability check for Anthropic's mid-conversation system beta.
 *
 * Only model families explicitly documented as supported are admitted. Direct
 * Anthropic IDs are unqualified; Vercel Gateway IDs must be explicitly routed
 * through the `anthropic/` namespace. Unknown aliases and other Claude families
 * stay on top-level system blocks even when explicit prompt caching is enabled.
 */
export function supportsAnthropicMidConversationSystem(
	provider: string,
	modelString: string,
): boolean {
	const normalizedModel = modelString.toLowerCase();
	const directModel =
		provider === "ANTHROPIC_DIRECT"
			? normalizedModel
			: provider === "VERCEL_GATEWAY" &&
					normalizedModel.startsWith("anthropic/")
				? normalizedModel.slice("anthropic/".length)
				: undefined;

	return (
		directModel !== undefined &&
		MID_CONVERSATION_SYSTEM_MODEL_PATTERN.test(directModel)
	);
}

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

/*
 * Rolling Anthropic cache breakpoint for AI SDK multi-step loops.
 *
 * A `streamText`/`generateText` call with tools resends tools, instructions and
 * every earlier step on each step. Anthropic caches that prefix only up to an
 * explicit breakpoint, so these wrap a `prepareStep` callback to put one
 * breakpoint on the step's last message.
 *
 * AI SDK 7 carries a `prepareStep` messages override forward: the next step is
 * built from the returned array plus that step's response messages. A marker
 * added on one step would therefore still be on the array the next step
 * receives. Anthropic honours at most four breakpoints (the installed adapter
 * drops the rest with a warning), so accumulated markers would leave the cached
 * prefix stuck at an early step. Each step removes the markers earlier steps
 * added before it adds its own.
 */

type StepPreparer = (options: { messages: ModelMessage[] }) => {
	messages?: ModelMessage[];
};

interface StepCacheModel {
	provider: string;
	modelString: string;
	hasTools: boolean;
}

/**
 * A call with no tools runs one step, so nothing reads back the prefix a
 * breakpoint would write, and Anthropic bills a cache write above the normal
 * input price. Bedrock, Foundry and other gateways use request adapters that
 * do not take the marker (see {@link isPromptCacheTarget}).
 */
function takesStepCacheBreakpoint(model: StepCacheModel): boolean {
	return (
		model.hasTools && isPromptCacheTarget(model.provider, model.modelString)
	);
}

/**
 * The `prepareStep` for a tool loop whose messages carry no breakpoint of
 * their own: the rolling cache breakpoint alone, so message content is passed
 * through and only the message-level cache marker changes. Every request
 * carries one marker, on its last message, and any marker the caller placed
 * is removed.
 *
 * Returns `undefined`, meaning no `prepareStep` at all, when the call has no
 * tools or the model does not take the marker.
 */
export function makeStepCacheBreakpoint(
	model: StepCacheModel,
): StepPreparer | undefined {
	return takesStepCacheBreakpoint(model)
		? withStepCacheBreakpoint(({ messages }) => ({ messages }))
		: undefined;
}

/**
 * Wrap a `prepareStep` (for example an in-flight compactor) so the messages it
 * returns carry exactly one cache breakpoint, on the last message.
 */
export function withStepCacheBreakpoint(prepareStep: StepPreparer) {
	return (options: { messages: ModelMessage[] }) => {
		const prepared = prepareStep(options);
		const messages = (prepared.messages ?? options.messages).map(
			withoutCacheBreakpoint,
		);
		const last = messages.at(-1);
		if (last) {
			messages[messages.length - 1] = withCacheBreakpoint(last);
		}
		return { ...prepared, messages };
	};
}

/**
 * The `prepareStep` for a tool loop whose caller already marked its messages,
 * such as direct chat and Sidekick, which mark the last history message up
 * front so the next turn reuses the cached history. {@link makeStepCacheBreakpoint}
 * would strip that marker; this one leaves the messages the call started with
 * exactly as the caller sent them and rolls a single marker over the messages
 * added during the call:
 *
 * - On the first step the last message is one the caller sent, so nothing is
 *   added and the caller's markers decide what is cached.
 * - On later steps the last message is a response or tool result added during
 *   the call. It gets the marker, and a marker on any other added message (the
 *   one an earlier step placed, carried forward by the SDK) is removed.
 *
 * The call's own messages are told apart by position: the AI SDK passes
 * `initialMessages` (the `messages` the call was given) to every step, and each
 * step's array starts with those messages because this callback returns them
 * in place and appends nothing. A request therefore carries the caller's
 * markers plus at most one more.
 *
 * Returns `undefined`, meaning no `prepareStep` at all, when the call has no
 * tools or the model does not take the marker.
 */
export function makeAppendedStepCacheBreakpoint(
	model: StepCacheModel,
):
	| ((options: {
			messages: ModelMessage[];
			initialMessages: ModelMessage[];
	  }) => { messages: ModelMessage[] })
	| undefined {
	if (!takesStepCacheBreakpoint(model)) {
		return undefined;
	}
	return ({ messages, initialMessages }) => {
		const callerCount = initialMessages.length;
		const prepared = messages.map((message, index) =>
			index < callerCount ? message : withoutCacheBreakpoint(message),
		);
		const lastIndex = prepared.length - 1;
		if (lastIndex >= callerCount) {
			prepared[lastIndex] = withCacheBreakpoint(prepared[lastIndex]);
		}
		return { messages: prepared };
	};
}

/** Add `anthropic.cacheControl`, keeping the message's other provider options. */
function withCacheBreakpoint(message: ModelMessage): ModelMessage {
	return {
		...message,
		providerOptions: {
			...message.providerOptions,
			anthropic: {
				...message.providerOptions?.anthropic,
				cacheControl: { type: "ephemeral" },
			},
		},
	} as ModelMessage;
}

/**
 * Drop a message-level `anthropic.cacheControl`, keeping any other provider
 * options on the message. Messages without one are returned as is.
 */
function withoutCacheBreakpoint(message: ModelMessage): ModelMessage {
	const anthropic = message.providerOptions?.anthropic;
	if (!anthropic || !("cacheControl" in anthropic)) {
		return message;
	}
	const { cacheControl: _removed, ...restAnthropic } = anthropic;
	const { anthropic: _anthropic, ...restProviders } =
		message.providerOptions ?? {};
	const providerOptions =
		Object.keys(restAnthropic).length > 0
			? { ...restProviders, anthropic: restAnthropic }
			: restProviders;
	const { providerOptions: _old, ...rest } = message;
	return (
		Object.keys(providerOptions).length > 0
			? { ...rest, providerOptions }
			: rest
	) as ModelMessage;
}
