import { isRecord } from "./parlume-stream-auth";

// Parlume's "raised hand": every pass it may offer one short, unprompted
// contribution in the chat. It never speaks one until someone replies "go".

export const PARLUME_SUGGESTION_INTERVAL_MS = 90_000;
/** Final speech segments since the last pass before another is worth asking for. */
const PARLUME_SUGGESTION_MIN_SEGMENTS = 3;
const PARLUME_SUGGESTIONS_PER_HOUR = 12;
const HOUR_MS = 60 * 60 * 1000;
const MAX_SUGGESTION_CHARS = 500;
const NEAR_DUPLICATE_OVERLAP = 0.6;

export interface ParlumeSuggestionState {
	lastPassAt: number;
	/** Suggestions posted within the last hour, oldest first. */
	recent: Array<{ at: number; text: string }>;
}

export function emptyParlumeSuggestionState(
	now: number,
): ParlumeSuggestionState {
	return { lastPassAt: now, recent: [] };
}

function withinHour(
	state: ParlumeSuggestionState,
	now: number,
): ParlumeSuggestionState["recent"] {
	return state.recent.filter((entry) => now - entry.at < HOUR_MS);
}

export function isParlumeSuggestionPassDue(
	state: ParlumeSuggestionState,
	input: { now: number; newSegments: number },
): boolean {
	return (
		input.now - state.lastPassAt >= PARLUME_SUGGESTION_INTERVAL_MS &&
		input.newSegments >= PARLUME_SUGGESTION_MIN_SEGMENTS &&
		withinHour(state, input.now).length < PARLUME_SUGGESTIONS_PER_HOUR
	);
}

/** The suggestion in Fabric's answer, read leniently: anything malformed is no suggestion. */
export function parseParlumeSuggestion(body: unknown): string | null {
	if (!isRecord(body) || body.suggest !== true) {
		return null;
	}
	const text =
		typeof body.text === "string"
			? body.text.replace(/\s+/g, " ").trim()
			: "";
	return text ? text.slice(0, MAX_SUGGESTION_CHARS) : null;
}

function words(text: string): Set<string> {
	return new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? []);
}

/** Shares most of its words with a suggestion made within the hour. */
export function isNearDuplicateParlumeSuggestion(
	state: ParlumeSuggestionState,
	text: string,
	now: number,
): boolean {
	const candidate = words(text);
	return withinHour(state, now).some((entry) => {
		const previous = words(entry.text);
		const shared = [...candidate].filter((word) =>
			previous.has(word),
		).length;
		const union = new Set([...candidate, ...previous]).size;
		return union > 0 && shared / union >= NEAR_DUPLICATE_OVERLAP;
	});
}

export function acceptParlumeSuggestion(
	state: ParlumeSuggestionState,
	text: string,
	now: number,
): void {
	state.recent = [...withinHour(state, now), { at: now, text }];
}

export function formatParlumeSuggestion(tag: string, text: string): string {
	return `Suggestion: ${text} (reply "go ${tag}" and I'll say it)`;
}
