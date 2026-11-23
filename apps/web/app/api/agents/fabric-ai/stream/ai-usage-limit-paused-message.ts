const LIMIT_WINDOWS = ["HOURLY", "DAILY", "WEEKLY", "MONTHLY"] as const;

type LimitWindow = (typeof LIMIT_WINDOWS)[number];

const LIMIT_WINDOW_WORDS = {
	HOURLY: "this hour",
	DAILY: "today",
	WEEKLY: "this week",
	MONTHLY: "this month",
} as const satisfies Record<LimitWindow, string>;

/** The window of a refusal in the chokepoint's message format. */
const LIMIT_REFUSAL_WINDOW =
	/AI usage limit exceeded:\s+[\w-]+\s+\((?:TOKENS|SPEND_USD),\s+(HOURLY|DAILY|WEEKLY|MONTHLY)\)/;

/**
 * What the person reads when a usage limit refused a run, in the words of
 * the "AI calls are paused" banner. The refusal's own message names the
 * limit's internal id, so it is never shown or saved as the run's text.
 */
export function aiUsageLimitPausedMessage(window: LimitWindow): string {
	return `AI calls are paused — the usage limit for ${LIMIT_WINDOW_WORDS[window]} is reached. Manage limits to raise it, or try again after it resets.`;
}

/**
 * The paused message for a failure whose text is a usage limit's refusal
 * (`AI usage limit exceeded: <id> (<dimension>, <window>) — …`), or null
 * for any other text. Imports nothing, so a chat can call it as it renders.
 */
export function aiUsageLimitPausedText(text: string): string | null {
	const matched = LIMIT_REFUSAL_WINDOW.exec(text)?.[1];
	const window = LIMIT_WINDOWS.find((candidate) => candidate === matched);
	return window ? aiUsageLimitPausedMessage(window) : null;
}
