/**
 * Board-wide facts computed over every card a run read, before the gathered-data
 * budget shortens the card list. The analysis step is told to take its board-wide
 * numbers from here, so a large board's status, workload and velocity no longer
 * depend on how many cards fit in the prompt.
 *
 * Pure and deterministic: `now` is passed in.
 */

import { isCardListTool } from "./report-card-pages";
import { BOARD_FACTS_KEY, COVERAGE_KEY } from "./report-data-gate";

/** An open card with no activity for this long counts as stale. */
export const STALE_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const NO_COLUMN = "(no column)";

const DUE_FIELDS = ["due_on", "due_date", "due", "dueDate"];
const CLOSED_AT_FIELDS = ["closed_at", "closedAt", "completed_at", "closed_on"];
const LAST_ACTIVE_FIELDS = [
	"last_active_at",
	"updated_at",
	"updatedAt",
	"dateLastActivity",
];
const CREATED_FIELDS = ["created_at", "createdAt"];

export interface PeriodCounts {
	/** Keyed `YYYY-MM`, in UTC. */
	byMonth: Record<string, number>;
	/** Keyed by the Monday that starts the week, `YYYY-MM-DD`, in UTC. */
	byWeek: Record<string, number>;
}

export interface OpenClosedCounts {
	open: number;
	closed: number;
}

export interface BoardFacts {
	/** Unique cards read. Always `open + closed + postponed`. */
	total: number;
	open: number;
	closed: number;
	/** Set aside without being closed, such as a "Not now" pile. */
	postponed: number;
	/** The cards' own `status` or `state` field, over all cards. */
	byStatus: Record<string, number>;
	/** Open cards by workflow column, which is the state on a column board. */
	byColumn: Record<string, number>;
	byAssignee: Record<string, OpenClosedCounts>;
	byTag: Record<string, OpenClosedCounts>;
	/** Open cards with nobody assigned; null when no card carries assignees. */
	unassigned: number | null;
	/** Cards whose assignee list the source cut short, so workload may be low. */
	assigneeListsCut: number;
	/** Open cards past their due date; null when no card carries one. */
	overdue: number | null;
	/** Open cards with no recent activity; null when no card carries activity. */
	stale: { afterDays: number; count: number } | null;
	/**
	 * Closed cards per period. `basis` names the field used: `last_active_at`
	 * means the source has no close date, so the periods are approximate.
	 * Null when no closed card carries either.
	 */
	closedPerPeriod: (PeriodCounts & { basis: string }) | null;
	/** Cards created per period; null when no card carries a creation date. */
	createdPerPeriod: PeriodCounts | null;
}

/** The facts as stored under `_board_facts`, with how much of the board they cover. */
export interface StoredBoardFacts extends BoardFacts {
	/** True only when the source confirmed every listing was read to its end. */
	complete: boolean;
	/** Each listing that was not confirmed complete, and why. */
	gaps: string[];
}

type Card = Record<string, unknown>;

function isCard(value: unknown): value is Card {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstField(card: Card, fields: string[]): unknown {
	for (const field of fields) {
		if (card[field] !== undefined && card[field] !== null) {
			return card[field];
		}
	}
	return undefined;
}

function parseTime(value: unknown): number | null {
	if (typeof value !== "string" && typeof value !== "number") {
		return null;
	}
	const time = new Date(value).getTime();
	return Number.isNaN(time) ? null : time;
}

function isClosed(card: Card): boolean {
	return (
		card.closed === true ||
		firstField(card, CLOSED_AT_FIELDS) !== undefined ||
		firstField(card, ["state"]) === "closed"
	);
}

/** Closed or set aside: the cards a report quotes least. */
export function isSettledCard(card: unknown): boolean {
	return isCard(card) && (isClosed(card) || card.postponed === true);
}

function labelOf(value: unknown): string | null {
	if (typeof value === "string") {
		return value;
	}
	if (isCard(value)) {
		const label = value.name ?? value.title ?? value.id;
		return label === undefined || label === null ? null : String(label);
	}
	return null;
}

function bump(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

function bumpOpenClosed(
	counts: Record<string, OpenClosedCounts>,
	key: string,
	closed: boolean,
): void {
	const entry = counts[key] ?? { open: 0, closed: 0 };
	if (closed) {
		entry.closed++;
	} else {
		entry.open++;
	}
	counts[key] = entry;
}

function sortedByKey<T>(counts: Record<string, T>): Record<string, T> {
	return Object.fromEntries(
		Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

function addToPeriods(periods: PeriodCounts, time: number): void {
	const date = new Date(time);
	bump(periods.byMonth, date.toISOString().slice(0, 7));
	const daysSinceMonday = (date.getUTCDay() + 6) % 7;
	bump(
		periods.byWeek,
		new Date(time - daysSinceMonday * DAY_MS).toISOString().slice(0, 10),
	);
}

function sortedPeriods(periods: PeriodCounts): PeriodCounts {
	return {
		byMonth: sortedByKey(periods.byMonth),
		byWeek: sortedByKey(periods.byWeek),
	};
}

/** A date-only due value is still on time through the end of that day. */
function isPastDue(value: unknown, now: Date): boolean {
	const time = parseTime(value);
	if (time === null) {
		return false;
	}
	const dateOnly = typeof value === "string" && value.length === 10;
	return (dateOnly ? time + DAY_MS : time) < now.getTime();
}

/**
 * Count a board from its full, de-duplicated card array. A count whose field no
 * card carries is null rather than zero, so the report can say the source does
 * not provide it instead of claiming nothing is overdue.
 */
export function computeBoardFacts(cards: unknown[], now: Date): BoardFacts {
	const facts: BoardFacts = {
		total: 0,
		open: 0,
		closed: 0,
		postponed: 0,
		byStatus: {},
		byColumn: {},
		byAssignee: {},
		byTag: {},
		unassigned: null,
		assigneeListsCut: 0,
		overdue: null,
		stale: null,
		closedPerPeriod: null,
		createdPerPeriod: null,
	};
	const closedByDate: PeriodCounts = { byMonth: {}, byWeek: {} };
	const closedByActivity: PeriodCounts = { byMonth: {}, byWeek: {} };
	const created: PeriodCounts = { byMonth: {}, byWeek: {} };
	let sawClosedDate = false;
	let sawClosedActivity = false;

	for (const card of cards) {
		if (!isCard(card)) {
			continue;
		}
		facts.total++;
		const closed = isClosed(card);
		const postponed = !closed && card.postponed === true;
		const open = !closed && !postponed;
		if (closed) {
			facts.closed++;
		} else if (postponed) {
			facts.postponed++;
		} else {
			facts.open++;
		}

		const status = labelOf(card.status ?? card.state);
		if (status !== null) {
			bump(facts.byStatus, status);
		}
		if (open) {
			bump(facts.byColumn, labelOf(card.column) ?? NO_COLUMN);
		}

		if (Array.isArray(card.assignees)) {
			facts.unassigned ??= 0;
			if (open && card.assignees.length === 0) {
				facts.unassigned++;
			}
			if (card.has_more_assignees === true) {
				facts.assigneeListsCut++;
			}
			if (!postponed) {
				for (const assignee of card.assignees) {
					const label = labelOf(assignee);
					if (label !== null) {
						bumpOpenClosed(facts.byAssignee, label, closed);
					}
				}
			}
		}
		if (Array.isArray(card.tags) && !postponed) {
			for (const tag of card.tags) {
				const label = labelOf(tag);
				if (label !== null) {
					bumpOpenClosed(facts.byTag, label, closed);
				}
			}
		}

		const due = firstField(card, DUE_FIELDS);
		if (due !== undefined) {
			facts.overdue ??= 0;
			if (open && isPastDue(due, now)) {
				facts.overdue++;
			}
		}
		const active = parseTime(firstField(card, LAST_ACTIVE_FIELDS));
		if (active !== null) {
			facts.stale ??= { afterDays: STALE_AFTER_DAYS, count: 0 };
			if (open && now.getTime() - active > STALE_AFTER_DAYS * DAY_MS) {
				facts.stale.count++;
			}
		}

		if (closed) {
			const closedAt = parseTime(firstField(card, CLOSED_AT_FIELDS));
			if (closedAt !== null) {
				sawClosedDate = true;
				addToPeriods(closedByDate, closedAt);
			}
			if (active !== null) {
				sawClosedActivity = true;
				addToPeriods(closedByActivity, active);
			}
		}

		const createdAt = parseTime(firstField(card, CREATED_FIELDS));
		if (createdAt !== null) {
			facts.createdPerPeriod = created;
			addToPeriods(created, createdAt);
		}
	}

	if (sawClosedDate) {
		facts.closedPerPeriod = {
			basis: "closed_at",
			...sortedPeriods(closedByDate),
		};
	} else if (sawClosedActivity) {
		facts.closedPerPeriod = {
			basis: "last_active_at",
			...sortedPeriods(closedByActivity),
		};
	}
	if (facts.createdPerPeriod) {
		facts.createdPerPeriod = sortedPeriods(created);
	}
	facts.byStatus = sortedByKey(facts.byStatus);
	facts.byColumn = sortedByKey(facts.byColumn);
	facts.byAssignee = sortedByKey(facts.byAssignee);
	facts.byTag = sortedByKey(facts.byTag);
	return facts;
}

/**
 * What a run left unread however far its listings went: the whole listing when
 * it only read filtered ones, and the closed cards a tool lists separately. A
 * listing scoped to one board reads that board whole, so the board filter does
 * not count as a filter here.
 */
function listingScopeGaps(
	gatheredData: Record<string, unknown>,
	listingKeys: string[],
	closedListingTools: ReadonlySet<string>,
): string[] {
	const filtersByTool = new Map<string, Set<string>>();
	for (const key of listingKeys) {
		const bracket = key.indexOf("[");
		const tool = bracket === -1 ? key : key.slice(0, bracket);
		const filters =
			bracket === -1
				? ""
				: key
						.slice(bracket + 1, -1)
						.split(",")
						.filter((filter) => !filter.startsWith("board_id="))
						.join(",");
		filtersByTool.set(
			tool,
			(filtersByTool.get(tool) ?? new Set<string>()).add(filters),
		);
	}
	const gaps: string[] = [];
	for (const [tool, filters] of filtersByTool) {
		if (!filters.has("")) {
			gaps.push(
				`${tool}: only filtered listings were read, not the whole listing`,
			);
		}
	}
	for (const tool of closedListingTools) {
		if (
			Array.isArray(gatheredData[tool]) &&
			!filtersByTool.get(tool)?.has("indexed_by=closed")
		) {
			gaps.push(`${tool}: closed cards were not read`);
		}
	}
	return gaps;
}

/** The listings the source did not confirm as read to their end. */
function coverageGaps(
	gatheredData: Record<string, unknown>,
	closedListingTools: ReadonlySet<string>,
): string[] {
	const coverage = gatheredData[COVERAGE_KEY];
	const entries = isCard(coverage) ? Object.entries(coverage) : [];
	if (entries.length === 0) {
		return [
			"the source did not report pagination, so totals are unconfirmed",
		];
	}
	const gaps: string[] = [];
	for (const [listing, entry] of entries) {
		if (!isCard(entry) || entry.complete !== true) {
			const reason =
				isCard(entry) && typeof entry.reason === "string"
					? entry.reason
					: "not every page was read";
			gaps.push(`${listing}: ${reason}`);
		}
	}
	gaps.push(
		...listingScopeGaps(
			gatheredData,
			entries.map(([listing]) => listing),
			closedListingTools,
		),
	);
	if (gatheredData._board_fix) {
		gaps.push(
			"cards were re-read one column page at a time, so coverage is unknown",
		);
	}
	return gaps;
}

/**
 * Add `_board_facts` when the run gathered any card list, de-duplicating across
 * listings and tools first. Runs that read no cards get no facts.
 * `closedListingTools` names the card-list tools that keep closed cards in a
 * listing of their own.
 */
export function attachBoardFacts(
	gatheredData: Record<string, unknown>,
	now: Date,
	closedListingTools: ReadonlySet<string> = new Set(),
): void {
	const cardLists = Object.entries(gatheredData).filter(
		([key, value]) => isCardListTool(key) && Array.isArray(value),
	);
	if (cardLists.length === 0) {
		return;
	}
	const seen = new Set<string>();
	const cards: unknown[] = [];
	for (const [, list] of cardLists) {
		for (const card of list as unknown[]) {
			const id = isCard(card) ? card.id : undefined;
			if (id !== undefined && id !== null) {
				if (seen.has(String(id))) {
					continue;
				}
				seen.add(String(id));
			}
			cards.push(card);
		}
	}
	const gaps = coverageGaps(gatheredData, closedListingTools);
	const stored: StoredBoardFacts = {
		...computeBoardFacts(cards, now),
		complete: gaps.length === 0,
		gaps,
	};
	gatheredData[BOARD_FACTS_KEY] = stored;
}

/** True when a listing is known to have stopped before its end. */
export function hasIncompleteListing(
	gatheredData: Record<string, unknown>,
): boolean {
	const coverage = gatheredData[COVERAGE_KEY];
	return (
		isCard(coverage) &&
		Object.values(coverage).some(
			(entry) => isCard(entry) && entry.complete === false,
		)
	);
}

/**
 * True when the source confirmed every listing was read to its end. A gap in
 * coverage, including a stopped listing, leaves `complete` false.
 */
export function isBoardFullyRead(
	gatheredData: Record<string, unknown>,
): boolean {
	const facts = gatheredData[BOARD_FACTS_KEY];
	return isCard(facts) && facts.complete === true;
}

/**
 * The opening of the analysis prompt. A stored report definition can keep older
 * instructions that call the visible cards a sample, so this has to state that
 * it takes precedence over them, not merely add to them. `listedCards` is how
 * many cards the prompt lists: told only that a list was shortened, a model
 * assumes cards are missing and declines to compare them.
 */
export function buildBoardFactsHeader(facts: unknown, listedCards = 0): string {
	if (!isCard(facts)) {
		return "";
	}
	const lines = ["## Board Facts (authoritative)"];
	lines.push(
		"These counts were computed from every card read from the source, before any card list below was shortened to fit. Take every board-wide total and every status, column, workload, tag, overdue, stale and per-period number from here, not from counting the cards you can see. These facts override any instruction below that calls the cards a sample, or that tells you to cite `total_count` or `_coverage` as the board total. A card below with few fields was shortened, so a missing field on it does not mean the card has no such value.",
	);
	if (facts.complete === true) {
		lines.push(
			`Coverage is complete: all ${String(facts.total)} cards were read. Do not describe this data as a sample or as partial, and do not report these numbers as unknown.`,
		);
	} else {
		const gaps = Array.isArray(facts.gaps) ? facts.gaps.map(String) : [];
		lines.push(
			`Coverage is partial: these counts cover only the ${String(facts.total)} cards that were read. Say so plainly at the start of the report and qualify board-wide numbers. What was not confirmed: ${gaps.join("; ")}.`,
		);
	}
	const closedPerPeriod = facts.closedPerPeriod;
	if (isCard(closedPerPeriod) && closedPerPeriod.basis !== "closed_at") {
		lines.push(
			"The source has no close date, so `closedPerPeriod` groups closed cards by their last activity. Present it as approximate.",
		);
	}
	lines.push(
		"A null value means the source does not provide that field: say it is not available, and do not present it as zero.",
	);
	lines.push(
		"On a large board the list below keeps open cards' fields longest, and closed and postponed cards lose theirs first. Answer a question about individual cards from the fields those cards still have, and name a field only when it is really missing from the cards the question is about.",
	);
	if (
		typeof facts.total === "number" &&
		facts.total > 0 &&
		listedCards >= facts.total
	) {
		lines.push(
			`All ${String(facts.total)} cards read are listed below. Shortening removed fields from cards and left no card out, so do not say cards were omitted. When a question compares cards, such as ranking open cards by a date, compare the listed cards that it covers and answer it.`,
		);
	}
	lines.push(JSON.stringify(facts));
	return `${lines.join("\n")}\n\n`;
}
