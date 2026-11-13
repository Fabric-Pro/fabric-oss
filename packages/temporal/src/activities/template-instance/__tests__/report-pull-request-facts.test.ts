import { describe, expect, it } from "vitest";
import {
	attachPullRequestFacts,
	computePullRequestFacts,
} from "../report-pull-request-facts";

const NOW = new Date("2026-11-06T00:00:00.000Z");
const SINCE = Date.parse("2026-08-06T00:00:00.000Z");

/** A pull request as an issue search returns it, merged `minutes` after it opened. */
const searched = (number: number, mergedAt: string, minutes: number) => ({
	number,
	title: `Example change ${number}`,
	created_at: new Date(Date.parse(mergedAt) - minutes * 60_000).toISOString(),
	closed_at: mergedAt,
	pull_request: { merged_at: mergedAt },
});

describe("computePullRequestFacts", () => {
	it("gives the median and 90th percentile open-to-merge minutes of the merged pull requests", () => {
		const facts = computePullRequestFacts(
			[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((minutes, i) =>
				searched(
					i + 1,
					`2026-10-${String(i + 10)}T12:00:00.000Z`,
					minutes,
				),
			),
			SINCE,
			NOW,
		);

		expect(facts).toEqual({
			since: "2026-08-06T00:00:00.000Z",
			until: "2026-11-06T00:00:00.000Z",
			read: 10,
			merged: 10,
			withoutMergeDate: 0,
			firstMergedAt: "2026-10-10T12:00:00.000Z",
			lastMergedAt: "2026-10-19T12:00:00.000Z",
			openToMergeMinutes: { median: 55, p90: 90 },
			revertOrHotfix: 0,
			revertOrHotfixNumbers: [],
		});
	});

	it("counts the merged pull requests whose title marks a revert or a hotfix", () => {
		const titled = (number: number, title: string) => ({
			...searched(number, "2026-10-01T12:00:00.000Z", 30),
			title,
		});

		const facts = computePullRequestFacts(
			[
				titled(1, 'Revert "feat: example change"'),
				titled(2, "fix: hotfix for the example page"),
				titled(3, "Hot-fix the example worker"),
				titled(4, "feat: reverse the example list"),
				titled(5, "fix(web): example dialog height"),
			],
			SINCE,
			NOW,
		);

		expect(facts).toMatchObject({
			merged: 5,
			revertOrHotfix: 3,
			revertOrHotfixNumbers: [1, 2, 3],
		});
	});

	it("reads `merged_at` from a pull request listing and leaves out pull requests closed unmerged", () => {
		const facts = computePullRequestFacts(
			[
				{
					number: 1,
					created_at: "2026-10-01T10:00:00.000Z",
					merged_at: "2026-10-01T11:00:00.000Z",
				},
				{
					number: 2,
					created_at: "2026-10-01T10:00:00.000Z",
					closed_at: "2026-10-02T10:00:00.000Z",
					merged_at: null,
				},
			],
			SINCE,
			NOW,
		);

		expect(facts).toMatchObject({
			read: 2,
			merged: 1,
			withoutMergeDate: 1,
			openToMergeMinutes: { median: 60, p90: 60 },
		});
	});

	it("counts only pull requests merged in the period", () => {
		const facts = computePullRequestFacts(
			[
				searched(1, "2026-08-05T23:59:00.000Z", 30),
				searched(2, "2026-08-06T00:01:00.000Z", 30),
			],
			SINCE,
			NOW,
		);

		expect(facts).toMatchObject({
			read: 2,
			merged: 1,
			firstMergedAt: "2026-08-06T00:01:00.000Z",
		});
	});

	it("counts a pull request read twice once", () => {
		const pullRequest = searched(7, "2026-10-01T12:00:00.000Z", 30);

		expect(
			computePullRequestFacts(
				[pullRequest, { number: 7, title: "Example change 7" }],
				SINCE,
				NOW,
			),
		).toMatchObject({ read: 1, merged: 1 });
	});

	it("counts every merge when the report has no period", () => {
		const facts = computePullRequestFacts(
			[searched(1, "2020-01-01T00:00:00.000Z", 30)],
			undefined,
			NOW,
		);

		expect(facts).toMatchObject({ since: null, merged: 1 });
	});

	it("reports no open-to-merge time when no merge date was read", () => {
		const facts = computePullRequestFacts(
			[{ number: 1, title: "Example change" }],
			SINCE,
			NOW,
		);

		expect(facts).toMatchObject({
			merged: 0,
			withoutMergeDate: 1,
			openToMergeMinutes: null,
		});
	});
});

describe("attachPullRequestFacts", () => {
	it("adds the facts over every pull request list the run read", () => {
		const gatheredData: Record<string, unknown> = {
			search_pull_requests: [searched(1, "2026-10-01T12:00:00.000Z", 30)],
			list_pull_requests: [searched(2, "2026-10-02T12:00:00.000Z", 90)],
			list_releases: [
				{ id: 1, published_at: "2026-10-03T12:00:00.000Z" },
			],
		};

		attachPullRequestFacts(gatheredData, SINCE, NOW);

		expect(gatheredData._pull_request_facts).toMatchObject({
			read: 2,
			merged: 2,
			openToMergeMinutes: { median: 60 },
		});
	});

	it("adds nothing when the run read no pull requests", () => {
		const gatheredData: Record<string, unknown> = {
			list_releases: [{ id: 1 }],
			get_pull_request: { number: 1 },
		};

		attachPullRequestFacts(gatheredData, SINCE, NOW);

		expect(gatheredData._pull_request_facts).toBeUndefined();
	});
});
