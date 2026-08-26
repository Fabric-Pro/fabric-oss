import type { GithubItem } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
	exclusionSignature,
	filterExcludedMergedPrs,
	type ReleaseNoteExclusion,
} from "../daily-brief-release-note-exclusions";

function makePr(overrides: Partial<GithubItem> = {}): GithubItem {
	return {
		occurredAt: new Date("2026-07-01T00:00:00.000Z"),
		title: "Add widget",
		fabricLink: undefined,
		kind: "pr_merged",
		prNumber: 100,
		repoFullName: "acme/repo",
		url: "https://github.com/acme/repo/pull/100",
		author: "octocat",
		state: "merged",
		baseRef: "staging",
		body: undefined,
		...overrides,
	};
}

describe("filterExcludedMergedPrs", () => {
	it("removes a pr_merged item matched by a pr-kind exclusion", () => {
		const github: GithubItem[] = [makePr({ prNumber: 100 })];
		const exclusions: ReleaseNoteExclusion[] = [
			{
				kind: "pr",
				repoFullName: "acme/repo",
				prNumber: 100,
				storyIdentifier: null,
			},
		];
		expect(filterExcludedMergedPrs(github, exclusions)).toEqual([]);
	});

	it("removes a pr_merged item whose title matches a story-kind exclusion", () => {
		const github: GithubItem[] = [
			makePr({ prNumber: 200, title: "FAB-123: fix the thing" }),
		];
		const exclusions: ReleaseNoteExclusion[] = [
			{
				kind: "story",
				repoFullName: null,
				prNumber: null,
				storyIdentifier: "FAB-123",
			},
		];
		expect(filterExcludedMergedPrs(github, exclusions)).toEqual([]);
	});

	it("retains a baseRef=production PR even when a matching pr exclusion exists", () => {
		const github: GithubItem[] = [
			makePr({ prNumber: 100, baseRef: "production" }),
		];
		const exclusions: ReleaseNoteExclusion[] = [
			{
				kind: "pr",
				repoFullName: "acme/repo",
				prNumber: 100,
				storyIdentifier: null,
			},
		];
		expect(filterExcludedMergedPrs(github, exclusions)).toEqual(github);
	});

	it("retains non-pr_merged items (e.g. pr_opened) even when matched", () => {
		const github: GithubItem[] = [
			makePr({ prNumber: 100, kind: "pr_opened" }),
		];
		const exclusions: ReleaseNoteExclusion[] = [
			{
				kind: "pr",
				repoFullName: "acme/repo",
				prNumber: 100,
				storyIdentifier: null,
			},
		];
		expect(filterExcludedMergedPrs(github, exclusions)).toEqual(github);
	});

	it("returns the array unchanged when exclusions is empty", () => {
		const github: GithubItem[] = [makePr({ prNumber: 100 })];
		const result = filterExcludedMergedPrs(github, []);
		expect(result).toBe(github);
		expect(result).toHaveLength(1);
		expect(result).toEqual(github);
	});
});

describe("exclusionSignature", () => {
	it("is order-independent for the same members", () => {
		const a: ReleaseNoteExclusion[] = [
			{
				kind: "pr",
				repoFullName: "acme/repo",
				prNumber: 1,
				storyIdentifier: null,
			},
			{
				kind: "story",
				repoFullName: null,
				prNumber: null,
				storyIdentifier: "FAB-1",
			},
		];
		const b: ReleaseNoteExclusion[] = [a[1], a[0]];
		expect(exclusionSignature(a)).toBe(exclusionSignature(b));
	});

	it("changes when a member is added or removed", () => {
		const base: ReleaseNoteExclusion[] = [
			{
				kind: "pr",
				repoFullName: "acme/repo",
				prNumber: 1,
				storyIdentifier: null,
			},
		];
		const withExtra: ReleaseNoteExclusion[] = [
			...base,
			{
				kind: "story",
				repoFullName: null,
				prNumber: null,
				storyIdentifier: "FAB-2",
			},
		];
		expect(exclusionSignature(base)).not.toBe(
			exclusionSignature(withExtra),
		);
		expect(exclusionSignature(withExtra)).not.toBe(exclusionSignature([]));
	});

	// Regression coverage for a Copilot PR-review finding: exclusionSignature() used to
	// include every row unconditionally, so a malformed `pr` row (null repoFullName/
	// prNumber) yielded `pr:null#null`, and any non-"pr" kind fell into an `else` branch
	// labeled `story:${storyIdentifier}` — mislabeling malformed/unknown-kind rows and
	// letting the signature change even though filterExcludedMergedPrs's output (which
	// already guards each row) did not. That drift could trigger an unnecessary
	// continueAsNew() rerun. exclusionSignature now derives from the same effective-keys
	// extractor as the filter, so a row only affects the signature if it also affects
	// filtering.
	it("does not count a malformed pr row (null repoFullName/prNumber) in the signature", () => {
		const validOnly: ReleaseNoteExclusion[] = [
			{
				kind: "pr",
				repoFullName: "acme/repo",
				prNumber: 1,
				storyIdentifier: null,
			},
		];
		const withMalformedPr: ReleaseNoteExclusion[] = [
			{
				kind: "pr",
				repoFullName: null,
				prNumber: null,
				storyIdentifier: null,
			},
			...validOnly,
		];
		expect(exclusionSignature(withMalformedPr)).toBe(
			exclusionSignature(validOnly),
		);
	});

	it("does not count a malformed story row (null storyIdentifier) in the signature", () => {
		const empty: ReleaseNoteExclusion[] = [];
		const withMalformedStory: ReleaseNoteExclusion[] = [
			{
				kind: "story",
				repoFullName: null,
				prNumber: null,
				storyIdentifier: null,
			},
		];
		expect(exclusionSignature(withMalformedStory)).toBe(
			exclusionSignature(empty),
		);
	});

	it("stays in lock-step with filterExcludedMergedPrs: equal filter output implies equal signature", () => {
		const github: GithubItem[] = [
			makePr({ prNumber: 1, repoFullName: "acme/repo" }),
		];
		const base: ReleaseNoteExclusion[] = [
			{
				kind: "pr",
				repoFullName: "acme/repo",
				prNumber: 1,
				storyIdentifier: null,
			},
		];
		const withMalformedExtra: ReleaseNoteExclusion[] = [
			...base,
			{
				kind: "pr",
				repoFullName: null,
				prNumber: null,
				storyIdentifier: null,
			},
			{
				kind: "story",
				repoFullName: null,
				prNumber: null,
				storyIdentifier: null,
			},
		];

		// Same filtering behavior on a fixed github[]...
		expect(filterExcludedMergedPrs(github, base)).toEqual(
			filterExcludedMergedPrs(github, withMalformedExtra),
		);
		// ...so the signatures must also match.
		expect(exclusionSignature(base)).toBe(
			exclusionSignature(withMalformedExtra),
		);
	});
});
