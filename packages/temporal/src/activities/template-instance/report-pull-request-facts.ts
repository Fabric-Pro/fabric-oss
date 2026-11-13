/**
 * Counts and open-to-merge times computed over every pull request a report
 * read. A model handed hundreds of pull requests declines to work out a median
 * from them, so the report would call lead time unavailable with the data in
 * hand.
 */

import { isPlainObject } from "./report-card-pages";
import { PULL_REQUEST_FACTS_KEY } from "./report-data-gate";

/** The facts as stored under `_pull_request_facts`. */
export interface PullRequestFacts {
	/** Start of the counted window, or null when the report has no period. */
	since: string | null;
	until: string;
	/** Distinct pull requests read. */
	read: number;
	/** Merged in the window. */
	merged: number;
	/** Read without a merge date: open, closed unmerged, or the field was not asked for. */
	withoutMergeDate: number;
	firstMergedAt: string | null;
	lastMergedAt: string | null;
	/** Minutes from opened to merged over the `merged` pull requests. */
	openToMergeMinutes: { median: number; p90: number } | null;
	/** Of the `merged` pull requests, those whose title marks a revert or a hotfix. */
	revertOrHotfix: number;
	revertOrHotfixNumbers: number[];
}

const REVERT_OR_HOTFIX = /\brevert(s|ed)?\b|\bhot-?fix(es)?\b/i;

function isPullRequestListTool(key: string): boolean {
	return /(^|_)(search|list)_pull_requests$/.test(key);
}

function timeOf(value: unknown): number | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const time = Date.parse(value);
	return Number.isNaN(time) ? undefined : time;
}

/** A pull request listing carries `merged_at`; an issue search carries it under `pull_request`. */
function mergedAtOf(item: Record<string, unknown>): number | undefined {
	const nested = item.pull_request;
	return (
		timeOf(item.merged_at) ??
		(isPlainObject(nested) ? timeOf(nested.merged_at) : undefined)
	);
}

function median(sorted: number[]): number {
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

export function computePullRequestFacts(
	items: unknown[],
	since: number | undefined,
	now: Date,
): PullRequestFacts {
	const until = now.getTime();
	const seen = new Set<string>();
	const durations: number[] = [];
	const mergedTimes: number[] = [];
	const revertOrHotfixNumbers: number[] = [];
	let read = 0;
	let revertOrHotfix = 0;
	let withoutMergeDate = 0;
	for (const item of items) {
		if (!isPlainObject(item)) {
			continue;
		}
		const identity = item.number ?? item.id ?? item.html_url;
		if (identity !== undefined && identity !== null) {
			if (seen.has(String(identity))) {
				continue;
			}
			seen.add(String(identity));
		}
		read += 1;
		const mergedAt = mergedAtOf(item);
		if (mergedAt === undefined) {
			withoutMergeDate += 1;
			continue;
		}
		if ((since !== undefined && mergedAt < since) || mergedAt > until) {
			continue;
		}
		mergedTimes.push(mergedAt);
		if (
			typeof item.title === "string" &&
			REVERT_OR_HOTFIX.test(item.title)
		) {
			revertOrHotfix += 1;
			if (typeof item.number === "number") {
				revertOrHotfixNumbers.push(item.number);
			}
		}
		const createdAt = timeOf(item.created_at);
		if (createdAt !== undefined && createdAt <= mergedAt) {
			durations.push((mergedAt - createdAt) / 60_000);
		}
	}
	durations.sort((a, b) => a - b);
	mergedTimes.sort((a, b) => a - b);
	const iso = (time: number | undefined) =>
		time === undefined ? null : new Date(time).toISOString();
	return {
		since: iso(since),
		until: new Date(until).toISOString(),
		read,
		merged: mergedTimes.length,
		withoutMergeDate,
		firstMergedAt: iso(mergedTimes[0]),
		lastMergedAt: iso(mergedTimes.at(-1)),
		openToMergeMinutes:
			durations.length === 0
				? null
				: {
						median: Math.round(median(durations)),
						p90: Math.round(
							durations[Math.ceil(durations.length * 0.9) - 1],
						),
					},
		revertOrHotfix,
		revertOrHotfixNumbers,
	};
}

/** Add `_pull_request_facts` when the run read any pull request list. */
export function attachPullRequestFacts(
	gatheredData: Record<string, unknown>,
	since: number | undefined,
	now: Date,
): void {
	const items = Object.entries(gatheredData).flatMap(([key, value]) =>
		isPullRequestListTool(key) && Array.isArray(value) ? value : [],
	);
	if (items.length === 0) {
		return;
	}
	gatheredData[PULL_REQUEST_FACTS_KEY] = computePullRequestFacts(
		items,
		since,
		now,
	);
}

/** The analysis prompt's statement of the pull request facts. */
export function buildPullRequestFactsHeader(facts: unknown): string {
	if (!isPlainObject(facts)) {
		return "";
	}
	const window =
		typeof facts.since === "string"
			? `merged from ${facts.since} to ${String(facts.until)}`
			: "merged at any time, because the report has no period";
	return `## Pull Request Facts (authoritative)
These were computed from every pull request read, before any list below was shortened. \`merged\` counts the pull requests ${window}, and \`openToMergeMinutes\` gives the median and 90th percentile minutes from opened to merged over them. \`revertOrHotfix\` counts those whose title marks a revert or a hotfix, numbered in \`revertOrHotfixNumbers\`. Take these counts and times from here, not from counting the list. \`withoutMergeDate\` counts pull requests read without a merge date, which are not in these numbers. A null value means it cannot be computed from what was read: say it is not available.
${JSON.stringify(facts)}

`;
}
