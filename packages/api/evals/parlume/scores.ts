/**
 * The four scores of the Parlume notes evaluation. Matching is lenient by
 * design and fully deterministic:
 *
 * - Words are compared lowercased, split on anything but letters and digits.
 *   Two words are the same when they are equal, when the shorter one has at
 *   least four letters and starts the longer one ("ship", "shipping"), or
 *   when they share their first six letters ("migrate", "migration").
 * - A ground-truth item lists keyword slots. Produced text matches the item
 *   when every slot is met: `keep|stay` is met by either word, and a slot of
 *   several words needs all of them. The slots carry the meaning, negation
 *   included: "keep the audit log" has a slot `keep|stay|retain`, so "drop
 *   the audit log" does not match it, and "the app will not ship in March"
 *   has a slot `not|no|april|later`, so "the app ships in March" does not.
 */
import type { AnchorStats } from "@repo/temporal/parlume-notes-anchors";
import type { ParlumeNoteItem } from "@repo/utils/parlume-notes";
import type { ExpectedSuggestion, TruthAction, TruthDecision } from "./fixture";

/** A share as its parts, so runs and fixtures add up before dividing. */
export type Ratio = { hits: number; total: number };

export function rate({ hits, total }: Ratio): number | null {
	return total === 0 ? null : hits / total;
}

export function addRatios(a: Ratio, b: Ratio): Ratio {
	return { hits: a.hits + b.hits, total: a.total + b.total };
}

function words(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

function sameWord(a: string, b: string): boolean {
	if (a === b) {
		return true;
	}
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	if (shorter.length >= 4 && longer.startsWith(shorter)) {
		return true;
	}
	return shorter.length >= 6 && longer.startsWith(shorter.slice(0, 6));
}

function hasWord(haystack: ReadonlyArray<string>, word: string): boolean {
	return haystack.some((candidate) => sameWord(candidate, word));
}

/** Every keyword slot is met by `text`. */
export function meetsKeywords(
	text: string,
	keywords: ReadonlyArray<string>,
): boolean {
	const said = words(text);
	return keywords.every((slot) =>
		slot.split("|").some((alternative) => {
			const needed = words(alternative);
			return needed.length > 0 && needed.every((w) => hasWord(said, w));
		}),
	);
}

/** Anchor validity: proposed notes whose quote is in the line they cite. */
export function anchorValidity(stats: AnchorStats): Ratio {
	const { empty, segment_unknown, quote_not_in_segment } = stats.dropped;
	return {
		hits: stats.proposed - empty - segment_unknown - quote_not_in_segment,
		total: stats.proposed,
	};
}

export type DecisionScore = {
	produced: number;
	/** Decision notes that match none of the meeting's decisions. */
	invented: string[];
	/** The meeting's decisions some note matched. */
	matched: number;
	expected: number;
};

/**
 * Decisions in the notes that are not among the meeting's decisions. A
 * decision the meeting later replaced is still one of its decisions: the
 * ground truth lists it, and a note of it is not invented.
 */
export function scoreDecisions(
	notes: ReadonlyArray<ParlumeNoteItem>,
	truth: ReadonlyArray<TruthDecision>,
): DecisionScore {
	const decisions = notes.filter((note) => note.kind === "decision");
	const matched = new Set<TruthDecision>();
	const invented: string[] = [];
	for (const note of decisions) {
		const found = truth.filter((decision) =>
			meetsKeywords(note.text, decision.keywords),
		);
		if (found.length === 0) {
			invented.push(note.text);
		}
		for (const decision of found) {
			matched.add(decision);
		}
	}
	return {
		produced: decisions.length,
		invented,
		matched: matched.size,
		expected: truth.length,
	};
}

function nameWords(name: string): string[] {
	return words(name.replace(/\([^)]*\)/g, " "));
}

/**
 * The same person: every word of one name is a word of the other, so "Dev"
 * is "Dev Example". A transcript mark in brackets is ignored. Both unnamed
 * is a match; one named and one not is not.
 */
export function sameOwner(
	produced: string | undefined,
	expected: string | null,
): boolean {
	if (!produced || !expected) {
		return !produced && !expected;
	}
	const a = nameWords(produced);
	const b = nameWords(expected);
	return (
		a.length > 0 &&
		b.length > 0 &&
		(a.every((word) => b.includes(word)) ||
			b.every((word) => a.includes(word)))
	);
}

/** Words a due date is phrased with that say nothing about when. */
const DUE_FILLER = new Set([
	"by",
	"on",
	"at",
	"in",
	"the",
	"of",
	"before",
	"until",
	"no",
	"later",
	"than",
	"this",
]);

function dueWords(due: string): string[] {
	return words(due).filter((word) => !DUE_FILLER.has(word));
}

/**
 * The same due date: the words that say when, of one, are all words of the
 * other, so "by Friday" is "Friday" and "by the end of the month" is "end of
 * month". Both absent is a match.
 */
export function sameDue(
	produced: string | undefined,
	expected: string | null,
): boolean {
	if (!produced || !expected) {
		return !produced && !expected;
	}
	const a = dueWords(produced);
	const b = dueWords(expected);
	return (
		a.length > 0 &&
		b.length > 0 &&
		(a.every((word) => hasWord(b, word)) ||
			b.every((word) => hasWord(a, word)))
	);
}

type ActionPair = {
	expected: string;
	produced: string;
	owner: { produced: string | null; expected: string | null; ok: boolean };
	due: { produced: string | null; expected: string | null; ok: boolean };
};

export type ActionScore = {
	/** Owner and due date checks: two per ground-truth action a note matched. */
	accuracy: Ratio;
	pairs: ActionPair[];
	/** Ground-truth actions no note matched. */
	missed: string[];
	/** Action notes that matched no ground-truth action. */
	extra: string[];
};

function actionPair(action: TruthAction, note: ParlumeNoteItem): ActionPair {
	return {
		expected: action.text,
		produced: note.text,
		owner: {
			produced: note.tentativeOwnerName ?? null,
			expected: action.owner,
			ok: sameOwner(note.tentativeOwnerName, action.owner),
		},
		due: {
			produced: note.dueHint ?? null,
			expected: action.due,
			ok: sameDue(note.dueHint, action.due),
		},
	};
}

function correctFields(pair: ActionPair): number {
	return (pair.owner.ok ? 1 : 0) + (pair.due.ok ? 1 : 0);
}

/**
 * Owners and due dates of the action items, against the meeting's. Each
 * ground-truth action, in order, is paired with the unpaired action note that
 * matches its keywords and gets most of its owner and due date right (the
 * first such note on a tie), so a note of an earlier, replaced due date does
 * not hide the note of the current one. Each pair is checked for its owner
 * and its due date.
 */
export function scoreActionOwners(
	notes: ReadonlyArray<ParlumeNoteItem>,
	truth: ReadonlyArray<TruthAction>,
): ActionScore {
	const actions = notes.filter((note) => note.kind === "action");
	const paired = new Set<ParlumeNoteItem>();
	const pairs: ActionPair[] = [];
	const missed: string[] = [];
	for (const action of truth) {
		let best: { note: ParlumeNoteItem; pair: ActionPair } | null = null;
		for (const note of actions) {
			if (
				paired.has(note) ||
				!meetsKeywords(note.text, action.keywords)
			) {
				continue;
			}
			const pair = actionPair(action, note);
			if (!best || correctFields(pair) > correctFields(best.pair)) {
				best = { note, pair };
			}
		}
		if (!best) {
			missed.push(action.text);
			continue;
		}
		paired.add(best.note);
		pairs.push(best.pair);
	}
	const correct = pairs.reduce((sum, pair) => sum + correctFields(pair), 0);
	return {
		accuracy: { hits: correct, total: pairs.length * 2 },
		pairs,
		missed,
		extra: actions
			.filter((note) => !paired.has(note))
			.map((note) => note.text),
	};
}

export type ProducedSuggestion = {
	afterSegment: number;
	kind: ExpectedSuggestion["kind"];
	text: string;
};

export type SuggestionScore = {
	precision: Ratio;
	/** For each produced suggestion, the expected one it matched, if any. */
	matches: Array<ProducedSuggestion & { matched: string | null }>;
};

/**
 * Suggestions the room was expected to get. A produced suggestion matches an
 * expected one of the same kind whose keywords its text meets. Each expected
 * suggestion is matched once: saying it again is noise in the meeting.
 */
export function scoreSuggestions(
	produced: ReadonlyArray<ProducedSuggestion>,
	expected: ReadonlyArray<ExpectedSuggestion>,
): SuggestionScore {
	const used = new Set<ExpectedSuggestion>();
	const matches = produced.map((suggestion) => {
		const match = expected.find(
			(candidate) =>
				!used.has(candidate) &&
				candidate.kind === suggestion.kind &&
				meetsKeywords(suggestion.text, candidate.keywords),
		);
		if (match) {
			used.add(match);
		}
		return { ...suggestion, matched: match?.text ?? null };
	});
	return {
		precision: {
			hits: matches.filter((match) => match.matched !== null).length,
			total: produced.length,
		},
		matches,
	};
}
