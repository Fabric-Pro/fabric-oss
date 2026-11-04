import { isRecord } from "./parlume-stream-auth";

// Parlume's "raised hand": every pass it may offer one short, unprompted
// contribution in the chat. It never speaks one until someone replies "go".

// A pass runs soon after a remark, so a suggestion arrives while the room is
// still on that topic; posts stay rare: at most one every two minutes and ten
// an hour. The service's bar for what is worth posting does the rest.
const PARLUME_SUGGESTION_INTERVAL_MS = 45_000;
/** Final speech segments since the last pass before another is worth asking for. */
const PARLUME_SUGGESTION_MIN_SEGMENTS = 2;
const PARLUME_SUGGESTIONS_PER_HOUR = 10;
const PARLUME_SUGGESTION_GAP_MS = 2 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_SUGGESTION_CHARS = 500;
const MAX_ANCHOR_CHARS = 120;
const NEAR_DUPLICATE_OVERLAP = 0.6;

/** Who sees a session's suggestions: everyone in the meeting chat, or only the project's team. */
export type ParlumeSuggestionAudience = "MEETING" | "TEAM";

export interface ParlumeSuggestionState {
	lastPassAt: number;
	/** Suggestions accepted within the last hour, oldest first, whoever they were for. */
	recent: Array<{ at: number; text: string; quote?: string }>;
}

/**
 * A suggestion and the remark it answers: who said it, their words, the
 * topic. A missed question names the remark that opened its topic.
 */
export interface ParlumeSuggestion {
	kind: "answer" | "missed_question";
	text: string;
	speaker: string;
	quote: string;
	topic: string;
}

/**
 * A meeting's first pass runs as soon as enough has been said: the interval
 * counts only from a pass that ran. Counting it from when the state was made
 * held the first suggestion of a staging meeting back by 45 seconds.
 */
export function emptyParlumeSuggestionState(
	now: number,
): ParlumeSuggestionState {
	return { lastPassAt: now - PARLUME_SUGGESTION_INTERVAL_MS, recent: [] };
}

function withinHour(
	state: ParlumeSuggestionState,
	now: number,
): ParlumeSuggestionState["recent"] {
	return state.recent.filter((entry) => now - entry.at < HOUR_MS);
}

/**
 * When the next pass may run once enough has been said: after the pass
 * interval, the gap since the last post, and room under the hourly cap.
 */
export function nextParlumeSuggestionPassAt(
	state: ParlumeSuggestionState,
	now: number,
): number {
	const recent = withinHour(state, now);
	const last = recent.at(-1);
	const capped =
		recent.length >= PARLUME_SUGGESTIONS_PER_HOUR
			? (recent[recent.length - PARLUME_SUGGESTIONS_PER_HOUR]?.at ??
					now) + HOUR_MS
			: 0;
	return Math.max(
		state.lastPassAt + PARLUME_SUGGESTION_INTERVAL_MS,
		last ? last.at + PARLUME_SUGGESTION_GAP_MS : 0,
		capped,
	);
}

/** Enough has been said since the last pass for another to be worth asking. */
export function hasParlumeSuggestionMaterial(newSegments: number): boolean {
	return newSegments >= PARLUME_SUGGESTION_MIN_SEGMENTS;
}

export function isParlumeSuggestionPassDue(
	state: ParlumeSuggestionState,
	input: { now: number; newSegments: number },
): boolean {
	return (
		hasParlumeSuggestionMaterial(input.newSegments) &&
		input.now >= nextParlumeSuggestionPassAt(state, input.now)
	);
}

function field(body: Record<string, unknown>, key: string, max: number) {
	const value = body[key];
	return typeof value === "string"
		? value.replace(/\s+/g, " ").trim().slice(0, max)
		: "";
}

/**
 * The suggestion in Fabric's answer, read leniently: anything malformed, or
 * not naming the remark it answers, is no suggestion. A missing or unknown
 * kind is an answer.
 */
export function parseParlumeSuggestion(
	body: unknown,
): ParlumeSuggestion | null {
	if (!isRecord(body) || body.suggest !== true) {
		return null;
	}
	const anchors = {
		text: field(body, "text", MAX_SUGGESTION_CHARS),
		speaker: field(body, "speaker", MAX_ANCHOR_CHARS),
		quote: field(body, "quote", MAX_ANCHOR_CHARS),
		topic: field(body, "topic", MAX_ANCHOR_CHARS),
	};
	return Object.values(anchors).every(Boolean)
		? {
				kind:
					body.kind === "missed_question"
						? "missed_question"
						: "answer",
				...anchors,
			}
		: null;
}

/**
 * The session's audience in Fabric's answer. Only an explicit TEAM keeps a
 * suggestion off the chat: an answer without one comes from a Fabric that
 * predates audiences, whose sessions all post in the meeting.
 */
export function parseParlumeSuggestionAudience(
	body: unknown,
): ParlumeSuggestionAudience | null {
	if (!isRecord(body)) {
		return null;
	}
	return body.audience === "TEAM"
		? "TEAM"
		: body.audience === "MEETING" || body.audience === undefined
			? "MEETING"
			: null;
}

function words(text: string): Set<string> {
	return new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? []);
}

/**
 * Answers a remark already answered within the hour, or shares most of its
 * words with a suggestion made then.
 */
export function isNearDuplicateParlumeSuggestion(
	state: ParlumeSuggestionState,
	suggestion: Pick<ParlumeSuggestion, "text" | "quote">,
	now: number,
): boolean {
	const candidate = words(suggestion.text);
	const quote = [...words(suggestion.quote)].join(" ");
	return withinHour(state, now).some((entry) => {
		if (entry.quote !== undefined && entry.quote === quote) {
			return true;
		}
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
	suggestion: Pick<ParlumeSuggestion, "text" | "quote">,
	now: number,
): void {
	state.recent = [
		...withinHour(state, now),
		{
			at: now,
			text: suggestion.text,
			quote: [...words(suggestion.quote)].join(" "),
		},
	];
}

/** The chat post: what it is about and whose words it answers, then the suggestion. */
export function formatParlumeSuggestion(
	tag: string,
	suggestion: ParlumeSuggestion,
): string {
	const anchor = `${suggestion.topic}, re ${suggestion.speaker}: "${suggestion.quote}". ${suggestion.text}`;
	switch (suggestion.kind) {
		case "answer":
			return `Suggestion on ${anchor} (reply "go ${tag}" and I'll say it)`;
		case "missed_question":
			return `Possibly missed question on ${anchor} (reply "go ${tag}" and I'll ask it)`;
		default: {
			const unreachable: never = suggestion.kind;
			return unreachable;
		}
	}
}

/** What "go P4" reads aloud: whose remark it answers, then the suggestion. */
export function spokenParlumeSuggestion(suggestion: ParlumeSuggestion): string {
	switch (suggestion.kind) {
		case "answer":
			return `${suggestion.speaker}, on ${suggestion.topic}: ${suggestion.text}`;
		case "missed_question":
			return `A question we may not have covered on ${suggestion.topic}: ${suggestion.text}`;
		default: {
			const unreachable: never = suggestion.kind;
			return unreachable;
		}
	}
}
