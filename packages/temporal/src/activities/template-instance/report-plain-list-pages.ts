/**
 * Further pages of a plain list, such as a repository's pull requests or
 * releases. These tools take a `page` argument but return a bare array with no
 * `has_more`, so nothing in the reply says another page exists, and the model
 * does not ask for one. A page as long as the requested page size is the only
 * sign, so the loop reads the following pages itself.
 *
 * Pure apart from the page fetch the caller injects.
 */

import { clipText, isPlainObject, rawJsonSchema } from "./report-card-pages";

/**
 * Pages read for one plain list, the first included, when nothing says how far
 * back the report needs to go.
 */
export const MAX_PLAIN_LIST_PAGES = 3;

/**
 * Pages read for a dated list when the report period is known: the walk stops
 * once a page reaches back before the period starts. On staging, three months
 * of a busy repository held 2,045 commits, 21 pages of 100.
 */
export const MAX_DATED_LIST_PAGES = 25;

/** Pages read for one search: GitHub returns no result past the 1,000th. */
export const MAX_SEARCH_PAGES = 10;

/** Fields that date a list item, in the order they are read. */
const ITEM_DATE_FIELDS = [
	"created_at",
	"createdAt",
	"published_at",
	"publishedAt",
	"updated_at",
	"updatedAt",
];

/** When an item happened, or null when it carries no date. */
function itemTime(item: unknown): number | null {
	if (!isPlainObject(item)) {
		return null;
	}
	const nested =
		isPlainObject(item.commit) && isPlainObject(item.commit.author)
			? item.commit.author.date
			: undefined;
	for (const value of [...ITEM_DATE_FIELDS.map((key) => item[key]), nested]) {
		if (typeof value === "string") {
			const time = Date.parse(value);
			if (!Number.isNaN(time)) {
				return time;
			}
		}
	}
	return null;
}

/**
 * The earliest moment a report needs, from the `evidenceWindow` the workflow
 * puts in the gathering context: the period's start, or its comparison
 * period's start when that is earlier. Undefined when there is no window.
 */
export function reportPeriodStart(
	context: Record<string, string | undefined>,
): number | undefined {
	let window: unknown;
	try {
		window = JSON.parse(context.evidenceWindow ?? "null");
	} catch {
		return undefined;
	}
	if (!isPlainObject(window)) {
		return undefined;
	}
	const starts = [
		window.start,
		isPlainObject(window.comparison) ? window.comparison.start : undefined,
	]
		.map((value) =>
			typeof value === "string" ? Date.parse(value) : Number.NaN,
		)
		.filter((time) => !Number.isNaN(time));
	return starts.length > 0 ? Math.min(...starts) : undefined;
}

/**
 * The report's period parameter as written, such as "Last 3 months": the first
 * non-empty text parameter whose name speaks of a period.
 */
export function reportPeriodParameter(
	parameters: Record<string, unknown>,
): string | undefined {
	for (const [name, value] of Object.entries(parameters)) {
		if (/period/i.test(name) && typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

/** Where the person says deployments are recorded, from the `deploymentRecords` parameter. */
export function deploymentRecordsParameter(
	parameters: Record<string, unknown>,
): string | undefined {
	const value = parameters.deploymentRecords;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The gathering prompt's statement of the report settings that decide what to
 * read: the period, and where deployments are recorded when the person said.
 */
export function reportSettingsPromptLines(settings: {
	reportPeriod?: { text: string; start?: number };
	deploymentRecords?: string;
}): string[] {
	const lines: string[] = [];
	const { reportPeriod, deploymentRecords } = settings;
	if (reportPeriod) {
		const from =
			reportPeriod.start !== undefined
				? `, from ${new Date(reportPeriod.start).toISOString().slice(0, 10)} (UTC)`
				: "";
		lines.push(
			"",
			"## Report Period",
			`The report covers \`${reportPeriod.text}\`${from}. When a tool can filter or search by date, ask for this period.`,
		);
	}
	if (deploymentRecords) {
		lines.push(
			"",
			"## Deployment Records",
			`The person says deployments are recorded in: \`${deploymentRecords}\`. Read these records for the whole period, with their dates and outcomes, as well as anything else the report needs.`,
		);
	}
	return lines;
}

const MONTHS = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];

const PERIOD_UNITS = ["day", "week", "month", "quarter", "year"] as const;

type PeriodUnit = (typeof PERIOD_UNITS)[number];

function periodUnit(word: string | undefined): PeriodUnit | undefined {
	return PERIOD_UNITS.find((unit) => unit === word);
}

/** Midnight UTC at the start of the calendar unit holding `date`. */
function startOfUnit(date: Date, unit: PeriodUnit): Date {
	const start = new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
	);
	switch (unit) {
		case "day":
			return start;
		case "week":
			// Weeks start on Monday.
			start.setUTCDate(
				start.getUTCDate() - ((start.getUTCDay() + 6) % 7),
			);
			return start;
		case "month":
			start.setUTCDate(1);
			return start;
		case "quarter":
			start.setUTCDate(1);
			start.setUTCMonth(start.getUTCMonth() - (start.getUTCMonth() % 3));
			return start;
		case "year":
			start.setUTCMonth(0, 1);
			return start;
		default: {
			const unknownUnit: never = unit;
			throw new Error(`Unknown period unit: ${unknownUnit}`);
		}
	}
}

/**
 * `date` moved by whole months, keeping the day of the month where it exists
 * and taking the month's last day where it does not: 31 May back three months
 * is 28 February, not 3 March.
 */
function shiftMonths(date: Date, months: number): Date {
	const target = new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1),
	);
	const lastDay = new Date(
		Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
	).getUTCDate();
	target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
	return target;
}

/** `date`, a UTC midnight, moved by `count` units, negative to go back. */
function shiftByUnits(date: Date, unit: PeriodUnit, count: number): Date {
	switch (unit) {
		case "day":
			return new Date(date.getTime() + count * 86_400_000);
		case "week":
			return new Date(date.getTime() + count * 7 * 86_400_000);
		case "month":
			return shiftMonths(date, count);
		case "quarter":
			return shiftMonths(date, count * 3);
		case "year":
			return shiftMonths(date, count * 12);
		default: {
			const unknownUnit: never = unit;
			throw new Error(`Unknown period unit: ${unknownUnit}`);
		}
	}
}

/**
 * When a period written as text starts, read against `now` in UTC: "Last 3
 * months", "Last month", "This quarter", "March 2026" or "2026-08-01 to
 * 2026-10-31". Undefined for text it cannot date, such as "Sprint 42".
 */
export function periodTextStart(
	text: string | undefined,
	now: number,
): number | undefined {
	const value = text?.trim().toLowerCase();
	if (!value) {
		return undefined;
	}
	const range = /^(\d{4}-\d{2}-\d{2})\s+to\s+\d{4}-\d{2}-\d{2}$/.exec(value);
	if (range) {
		const time = Date.parse(`${range[1]}T00:00:00.000Z`);
		return Number.isNaN(time) ? undefined : time;
	}
	const today = new Date(now);
	const counted =
		/^(?:last|past|previous)\s+(\d+)\s+(day|week|month|quarter|year)s?$/.exec(
			value,
		);
	const countedUnit = periodUnit(counted?.[2]);
	if (counted && countedUnit) {
		return shiftByUnits(
			startOfUnit(today, "day"),
			countedUnit,
			-Number(counted[1]),
		).getTime();
	}
	const calendar = /^(this|last|previous)\s+(week|month|quarter|year)$/.exec(
		value,
	);
	const unit = periodUnit(calendar?.[2]);
	if (calendar && unit) {
		const start = startOfUnit(today, unit);
		return (
			calendar[1] === "this" ? start : shiftByUnits(start, unit, -1)
		).getTime();
	}
	const named = /^([a-z]+)\s+(\d{4})$/.exec(value);
	const month = named ? MONTHS.indexOf(named[1]) : -1;
	if (named && month >= 0) {
		return Date.UTC(Number(named[2]), month, 1);
	}
	return undefined;
}

/**
 * True when a page's items are dated and its first is no older than its last,
 * as in a list sorted newest first. Only then does an old last item mean the
 * pages after it are older still.
 */
function isNewestFirst(page: unknown[]): boolean {
	const first = itemTime(page[0]);
	const last = itemTime(page.at(-1));
	return first !== null && last !== null && first >= last;
}

/** True when a page's last item is dated before `periodStart`. */
function reachesBefore(page: unknown[], periodStart: number): boolean {
	const time = itemTime(page.at(-1));
	return time !== null && time < periodStart;
}

/** Page sizes a source uses when the caller sets none. */
const DEFAULT_PAGE_SIZES: ReadonlySet<number> = new Set([30, 50, 100]);

/** The largest page most sources return, whatever size is asked for. */
const LARGEST_DEFAULT_PAGE_SIZE = Math.max(...DEFAULT_PAGE_SIZES);

const PAGE_SIZE_ARGS = ["perPage", "per_page", "limit", "page_size"];

/** One page of a search: its items and the match count. */
export interface SearchResultPage {
	items: unknown[];
	total: number;
}

/**
 * A search reply, such as GitHub's `{ total_count, items }`, or null for any
 * other shape. Its query already bounds the results, so it is read up to its
 * match count rather than to a date.
 */
export function searchResultPage(output: unknown): SearchResultPage | null {
	if (
		!isPlainObject(output) ||
		!Array.isArray(output.items) ||
		typeof output.total_count !== "number"
	) {
		return null;
	}
	return { items: output.items, total: output.total_count };
}

/**
 * Searches one query becomes, at most, when its date range is split. GitHub
 * returns no more than 1,000 results for a query however it is paged, so a
 * busy repository's three months of merged pull requests need two or more.
 */
export const MAX_SEARCH_WINDOWS = 8;

const SEARCH_QUERY_ARGS = ["query", "q"];

/** A search qualifier over dates, such as `merged:2026-08-07..2026-11-07`. */
const DATE_RANGE_QUALIFIER =
	/\b([a-z-]+):(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})\b/;

const DAY_MS = 86_400_000;

/**
 * The search's arguments split at the middle day of its query's date range,
 * later half first so the result stays newest first, each from page 1. Null
 * when the query has no date range spanning two days or more.
 */
export function splitSearchDateRange(
	args: Record<string, unknown>,
): [Record<string, unknown>, Record<string, unknown>] | null {
	for (const key of SEARCH_QUERY_ARGS) {
		const query = args[key];
		if (typeof query !== "string") {
			continue;
		}
		const match = DATE_RANGE_QUALIFIER.exec(query);
		if (!match) {
			continue;
		}
		const [text, qualifier, from, to] = match;
		const start = Date.parse(`${from}T00:00:00Z`);
		const end = Date.parse(`${to}T00:00:00Z`);
		if (!(end > start)) {
			return null;
		}
		const middle = start + Math.floor((end - start) / DAY_MS / 2) * DAY_MS;
		const day = (time: number) => new Date(time).toISOString().slice(0, 10);
		const window = (first: number, last: number) => ({
			...args,
			[key]: query.replace(
				text,
				`${qualifier}:${day(first)}..${day(last)}`,
			),
			page: 1,
		});
		return [window(middle + DAY_MS, end), window(start, middle)];
	}
	return null;
}

/** Items in order, each item with an `id` or `number` kept once. */
function uniqueItems(items: unknown[]): unknown[] {
	const seen = new Set<unknown>();
	return items.filter((item) => {
		const key = isPlainObject(item) ? (item.id ?? item.number) : undefined;
		if (key === undefined || key === null) {
			return true;
		}
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

/**
 * A commit cut to what a report reads: its hash, subject line, author and
 * date, in the source's own shape. Its full message, often a squashed pull
 * request's whole description, and its URLs and e-mail addresses made 1,000
 * commits 1.4 MB on staging, and the run's data limit dropped 200 of them.
 * Anything that is not a commit is returned as it came.
 */
export function slimCommit(item: unknown): unknown {
	if (
		!isPlainObject(item) ||
		typeof item.sha !== "string" ||
		!isPlainObject(item.commit)
	) {
		return item;
	}
	const { message, author } = item.commit;
	return {
		sha: item.sha,
		commit: {
			message:
				typeof message === "string"
					? message.split("\n", 1)[0]
					: message,
			author: isPlainObject(author)
				? { name: author.name, date: author.date }
				: author,
		},
		...(isPlainObject(item.author) && typeof item.author.login === "string"
			? { author: { login: item.author.login } }
			: {}),
	};
}

/** The link of a GitHub issue or pull request. */
const ISSUE_OR_PULL_URL = /\/(?:issues|pull)\/\d+$/;

/** Plain fields of an issue or pull request that a report reads. */
const PULL_REQUEST_FIELDS = [
	"number",
	"title",
	"state",
	"draft",
	"created_at",
	"updated_at",
	"closed_at",
	"merged_at",
	"html_url",
	"comments",
];

/** Longest description kept on an issue or pull request. */
const MAX_BODY_CHARS = 280;

/**
 * An issue or pull request cut to what a report reads: its number, title,
 * state, dates, author, labels, branches and the start of its description, in
 * the source's own shape. A search item keeps its merge date under
 * `pull_request`. On staging, a search for 1,022 merged pull requests came to
 * 3.9 MB, and the run's data limit dropped 498 of them. Anything else is
 * returned as it came.
 */
export function slimPullRequest(item: unknown): unknown {
	if (
		!isPlainObject(item) ||
		typeof item.html_url !== "string" ||
		!ISSUE_OR_PULL_URL.test(item.html_url)
	) {
		return item;
	}
	const login = (person: unknown) =>
		isPlainObject(person) ? { login: person.login } : person;
	const slim: Record<string, unknown> = {};
	for (const key of PULL_REQUEST_FIELDS) {
		if (item[key] !== undefined) {
			slim[key] = item[key];
		}
	}
	if (isPlainObject(item.pull_request)) {
		slim.pull_request = { merged_at: item.pull_request.merged_at };
	}
	if (typeof item.body === "string" && item.body.length > 0) {
		slim.body = clipText(item.body, MAX_BODY_CHARS);
	}
	if (item.user !== undefined) {
		slim.user = login(item.user);
	}
	if (Array.isArray(item.assignees)) {
		slim.assignees = item.assignees.map(login);
	}
	if (Array.isArray(item.labels)) {
		slim.labels = item.labels.map((label) =>
			isPlainObject(label) ? { name: label.name } : label,
		);
	}
	if (isPlainObject(item.milestone)) {
		slim.milestone = { title: item.milestone.title };
	}
	for (const key of ["base", "head"]) {
		const branch = item[key];
		if (isPlainObject(branch)) {
			slim[key] = { ref: branch.ref };
		}
	}
	return slim;
}

/** A commit, issue or pull request cut to what a report reads. */
function slimListItem(item: unknown): unknown {
	return slimPullRequest(slimCommit(item));
}

/** True when a tool's input takes a numeric `page`. */
export function takesPageArgument(inputSchema: unknown): boolean {
	const properties = rawJsonSchema(inputSchema)?.properties;
	if (!isPlainObject(properties) || !isPlainObject(properties.page)) {
		return false;
	}
	const type = properties.page.type;
	const types = Array.isArray(type) ? type : [type];
	return types.includes("integer") || types.includes("number");
}

/**
 * The page size a full page holds, or null when it cannot be known. A request
 * above the largest common size that returns a common size met the source's
 * own limit, so that page is full: asking GitHub for 250 returns 100.
 */
function pageSizeOf(
	args: Record<string, unknown>,
	firstPage: unknown[],
): number | null {
	for (const key of PAGE_SIZE_ARGS) {
		const value = Number(args[key]);
		if (Number.isInteger(value) && value > 0) {
			return value > LARGEST_DEFAULT_PAGE_SIZE &&
				DEFAULT_PAGE_SIZES.has(firstPage.length)
				? firstPage.length
				: value;
		}
	}
	return DEFAULT_PAGE_SIZES.has(firstPage.length) ? firstPage.length : null;
}

export interface PlainListPages {
	/** The first page's items followed by those of every later page read. */
	items: unknown[];
	/** The number of the first page read, which the model asked for. */
	startPage: number;
	/** Pages read, the first included. */
	pages: number;
	/** How many matches a search reported in all, when the list came from one. */
	total?: number;
	/** How many narrower date ranges a split search was read in. */
	windows?: number;
	/** Set when the walk stopped with more possibly left to read. */
	stoppedEarly?: string;
}

/**
 * Read the pages after `firstPage` while each comes back full. A short, empty
 * or non-list page ends the walk, and so, in a list sorted newest first, does a
 * page whose last item is dated before `periodStart`. A page that fails ends
 * it too, keeping what was read, because the first page already answered the
 * model's call.
 */
export async function readFullPages(params: {
	args: Record<string, unknown>;
	firstPage: unknown[];
	fetchPage: (args: Record<string, unknown>) => Promise<unknown>;
	/** Called before each page so a Temporal activity stays alive. */
	beat: () => void;
	/** Earliest moment the report needs, in milliseconds. */
	periodStart?: number;
	/** How many items the source holds in all, when it says: the walk ends there. */
	total?: number;
	maxPages?: number;
}): Promise<PlainListPages> {
	const { args, firstPage, fetchPage, beat, periodStart, total } = params;
	// The cutoff applies only to a dated list sorted newest first.
	const cutoff =
		periodStart !== undefined && isNewestFirst(firstPage)
			? periodStart
			: null;
	const maxPages =
		params.maxPages ??
		(cutoff !== null ? MAX_DATED_LIST_PAGES : MAX_PLAIN_LIST_PAGES);
	const pageSize = pageSizeOf(args, firstPage);
	const items = [...firstPage];
	const firstNumber = Number(args.page);
	const startPage =
		Number.isInteger(firstNumber) && firstNumber > 0 ? firstNumber : 1;
	let pages = 1;
	// Items before the first page read count toward a stated total too.
	const readAll = () =>
		total !== undefined &&
		pageSize !== null &&
		(startPage - 1) * pageSize + items.length >= total;
	if (
		pageSize === null ||
		firstPage.length < pageSize ||
		readAll() ||
		(cutoff !== null && reachesBefore(firstPage, cutoff))
	) {
		return { items, startPage, pages };
	}
	let page = startPage;

	while (pages < maxPages) {
		beat();
		page++;
		let output: unknown;
		try {
			output = await fetchPage({ ...args, page });
		} catch (error) {
			const detail =
				error instanceof Error ? error.message : "unknown error";
			return {
				items,
				startPage,
				pages,
				stoppedEarly: `page ${page} could not be read: ${detail}`,
			};
		}
		if (!Array.isArray(output)) {
			return { items, startPage, pages };
		}
		pages++;
		items.push(...output);
		if (
			output.length < pageSize ||
			readAll() ||
			(cutoff !== null && reachesBefore(output, cutoff))
		) {
			return { items, startPage, pages };
		}
	}
	return {
		items,
		startPage,
		pages,
		stoppedEarly: `stopped after ${maxPages} full pages`,
	};
}

/**
 * The full result of a call to a tool that takes a `page` argument: a plain
 * list read past its first page, or a search read up to its match count. A
 * search comes back as its bare item list, with the match count on `read`: the
 * gathered-data budget can shorten a list but not a list inside a reply, and a
 * 717-item search of 3.8 MB once crowded every other source down to one record.
 * Any other output, or a tool without a page argument, is returned as it came.
 */
export async function readToolResultPages(params: {
	output: unknown;
	args: Record<string, unknown>;
	inputSchema: unknown;
	fetchPage: (args: Record<string, unknown>) => Promise<unknown>;
	beat: () => void;
	periodStart?: number;
}): Promise<{ output: unknown; read?: PlainListPages }> {
	const { output, args, inputSchema, fetchPage, beat, periodStart } = params;
	if (!takesPageArgument(inputSchema)) {
		return { output };
	}
	if (Array.isArray(output)) {
		const read = await readFullPages({
			args,
			firstPage: output,
			fetchPage,
			beat,
			periodStart,
		});
		return { output: read.items.map(slimListItem), read };
	}
	const search = searchResultPage(output);
	if (!search) {
		return { output };
	}
	const read = await readSearch({
		args,
		first: search,
		fetchPage,
		beat,
		periodStart,
		windows: { used: 1 },
	});
	return { output: read.items.map(slimListItem), read };
}

/**
 * A search read up to its match count. When the walk stops short and the
 * query names a date range, the range is split in two and each half is read
 * the same way, until every match is held or `MAX_SEARCH_WINDOWS` searches
 * are used. `pages` counts every call, the caller's first one included.
 */
async function readSearch(params: {
	args: Record<string, unknown>;
	first: SearchResultPage;
	fetchPage: (args: Record<string, unknown>) => Promise<unknown>;
	beat: () => void;
	periodStart?: number;
	windows: { used: number };
}): Promise<PlainListPages> {
	const { args, first, fetchPage, beat, periodStart, windows } = params;
	const read = await readFullPages({
		args,
		firstPage: first.items,
		fetchPage: async (pageArgs) => {
			const next = await fetchPage(pageArgs);
			return searchResultPage(next)?.items ?? next;
		},
		beat,
		periodStart,
		total: first.total,
		maxPages: MAX_SEARCH_PAGES,
	});
	const whole: PlainListPages = { ...read, total: first.total };
	const halves = read.stoppedEarly ? splitSearchDateRange(args) : null;
	if (!halves || windows.used >= MAX_SEARCH_WINDOWS) {
		return whole;
	}
	windows.used++;
	let pages = read.pages;
	const parts: PlainListPages[] = [];
	for (const half of halves) {
		beat();
		let output: unknown;
		try {
			output = await fetchPage(half);
		} catch (error) {
			const detail =
				error instanceof Error ? error.message : "unknown error";
			return {
				...whole,
				pages,
				stoppedEarly: `a narrower search could not be read: ${detail}`,
			};
		}
		pages++;
		const page = searchResultPage(output);
		if (!page) {
			return { ...whole, pages };
		}
		const part = await readSearch({ ...params, args: half, first: page });
		pages += part.pages - 1;
		parts.push(part);
	}
	const stoppedEarly = parts.find((part) => part.stoppedEarly)?.stoppedEarly;
	return {
		items: uniqueItems(parts.flatMap((part) => part.items)),
		startPage: read.startPage,
		pages,
		total: first.total,
		windows: parts.reduce((count, part) => count + (part.windows ?? 1), 0),
		...(stoppedEarly ? { stoppedEarly } : {}),
	};
}
