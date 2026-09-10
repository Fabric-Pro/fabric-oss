import {
	cacheableSystem,
	isPromptCacheTarget,
	withRollingCacheBreakpoint,
} from "@repo/ai/prompt-cache";
import { getCurrentDateContext } from "@repo/ai/prompts";
import {
	buildSidekickSystemPrompt,
	SIDEKICK_SYSTEM_PROMPT,
} from "@repo/ai/sidekick/prompt";

interface SidekickPromptCacheRequest<Message> {
	system:
		| string
		| [
				ReturnType<typeof cacheableSystem>,
				{ role: "system"; content: string },
		  ];
	messages: Message[];
}

interface SidekickPromptCacheInput<Message> {
	provider: string;
	modelString: string;
	messages: readonly Message[];
}

/**
 * Build Sidekick's provider-specific prompt request. Cache-capable Anthropic
 * routes keep the stable prompt and historical prefix separate from the date
 * and current form state. Other providers retain the exact legacy system
 * string and receive copied, unmarked messages.
 */
export function buildSidekickPromptCacheRequest<
	Message extends { role?: unknown },
>({
	provider,
	modelString,
	messages,
}: SidekickPromptCacheInput<Message>): SidekickPromptCacheRequest<Message> {
	if (!isPromptCacheTarget(provider, modelString)) {
		return {
			system: buildSidekickSystemPrompt(),
			messages: [...messages],
		};
	}

	const currentUserIndex = messages.findLastIndex(
		(message) => message.role === "user",
	);
	const history =
		currentUserIndex === -1 ? [] : messages.slice(0, currentUserIndex);
	const currentAndTrailing =
		currentUserIndex === -1 ? messages : messages.slice(currentUserIndex);
	const markedHistory = withRollingCacheBreakpoint(history) as Message[];

	return {
		system: [
			cacheableSystem(SIDEKICK_SYSTEM_PROMPT),
			{ role: "system", content: getCurrentDateContext() },
		],
		messages: [...markedHistory, ...currentAndTrailing],
	};
}
