import type { DirectChatUsageLimitRefusal } from "../types";

/**
 * Visible text for a failed agent mention reply. Shared threads can be read
 * by everyone in the conversation, so keep raw provider/Temporal errors and
 * usage-limit IDs and counters in the existing logs and stats, outside the
 * posted message (Fizzy #3242).
 */
export function failedAgentMentionReply(
	usageLimit?: DirectChatUsageLimitRefusal,
): string {
	return usageLimit
		? "Sorry, I couldn't respond: an AI usage limit was reached."
		: "Sorry, I ran into an error and couldn't respond.";
}
