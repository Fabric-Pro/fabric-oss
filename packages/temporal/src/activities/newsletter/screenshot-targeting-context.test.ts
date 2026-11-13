/**
 * The pure half of screenshot targeting: how release notes name pull
 * requests, how story text is read, which tag a release follows, and the
 * block curation reads within its budget.
 */
import { describe, expect, it, vi } from "vitest";
import type { GitHubRelease } from "../daily-brief/collect-github-releases";
import {
	clipText,
	extractPullRequestRefs,
	formatTargetingContext,
	type NewsletterReleaseTargeting,
	plainStoryText,
	previousProductionTag,
	readReleaseListing,
	RELEASE_LISTING_PAGE_SIZE,
} from "./screenshot-targeting-context";

function release(
	tagName: string,
	publishedAt: string | null,
	over: Partial<GitHubRelease> = {},
): GitHubRelease {
	return {
		tag_name: tagName,
		name: tagName,
		draft: false,
		prerelease: false,
		published_at: publishedAt,
		html_url: `https://github.com/example-org/app/releases/tag/${tagName}`,
		author: null,
		body: null,
		...over,
	};
}

function targeting(
	over: Partial<NewsletterReleaseTargeting> = {},
): NewsletterReleaseTargeting {
	return {
		repoFullName: "example-org/app",
		tagName: "v1.2.0",
		changedPaths: [],
		pathsTruncated: false,
		workItems: [],
		...over,
	};
}

describe("extractPullRequestRefs", () => {
	it("reads pull request URLs and #number shorthands, without duplicates", () => {
		const refs = extractPullRequestRefs(
			[
				"- Saved filters (https://github.com/example-org/app/pull/42)",
				"- Faster search (#7)",
				"- Same PR again https://github.com/example-org/app/pull/42",
				"- GitLab: https://gitlab.example.com/group/app/-/merge_requests/9",
			].join("\n"),
			"example-org/app",
		);

		expect(refs.urls).toEqual([
			"https://github.com/example-org/app/pull/42",
			"https://gitlab.example.com/group/app/-/merge_requests/9",
		]);
		expect(refs.numbers).toEqual([42, 7]);
	});

	it("takes a number only from a URL of the release's own repository", () => {
		const refs = extractPullRequestRefs(
			[
				"- Upstream fix https://github.com/example-org/library/pull/12",
				"- Look-alike https://github.com/other-example-org/app/pull/13",
				"- Ours https://github.com/Example-Org/App/pull/14",
				"- GitLab ours https://gitlab.example.com/example-org/app/-/merge_requests/15",
			].join("\n"),
			"example-org/app",
		);

		expect(refs.urls).toHaveLength(4);
		expect(refs.numbers).toEqual([14, 15]);
	});

	it("ignores an anchor that is not a reference and an empty body", () => {
		expect(
			extractPullRequestRefs(
				"See docs#section2 for details",
				"example-org/app",
			),
		).toEqual({
			urls: [],
			numbers: [],
		});
		expect(extractPullRequestRefs(undefined, "example-org/app")).toEqual({
			urls: [],
			numbers: [],
		});
	});
});

describe("plainStoryText", () => {
	it("joins the text runs of a TipTap document", () => {
		const doc = JSON.stringify({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: 'Open the "Filters" panel.' },
					],
				},
				{
					type: "paragraph",
					content: [{ type: "text", text: "Save a filter." }],
				},
			],
		});

		expect(plainStoryText(doc)).toBe(
			'Open the "Filters" panel. Save a filter.',
		);
	});

	it("keeps plain text and treats empty values as empty", () => {
		expect(plainStoryText("  A plain description.  ")).toBe(
			"A plain description.",
		);
		expect(plainStoryText(null)).toBe("");
	});
});

describe("clipText", () => {
	it("marks text it cuts", () => {
		expect(clipText("abcdef", 3)).toBe("abc…");
		expect(clipText("abc", 3)).toBe("abc");
	});
});

describe("previousProductionTag", () => {
	const listing = [
		release("v1.3.0", "2026-11-03T10:00:00Z"),
		release("v1.3.0-rc.1", "2026-11-02T10:00:00Z", { prerelease: true }),
		release("v1.2.0", "2026-10-20T10:00:00Z"),
		release("v1.1.0", null, { draft: true }),
		release("v1.0.0", "2026-10-01T10:00:00Z"),
	];

	it("returns the newest published production tag older than the release", () => {
		expect(previousProductionTag(listing, "v1.3.0")).toBe("v1.2.0");
		expect(previousProductionTag(listing, "v1.2.0")).toBe("v1.0.0");
	});

	it("returns null for the first release and for a tag not in the listing", () => {
		expect(previousProductionTag(listing, "v1.0.0")).toBeNull();
		expect(previousProductionTag(listing, "v9.9.9")).toBeNull();
	});
});

describe("readReleaseListing", () => {
	const DAY_ZERO = Date.UTC(2020, 0, 1);
	const DAY_MS = 86_400_000;

	/** `count` stable releases, newest first, numbered from `first` down. */
	function page(first: number, count: number): GitHubRelease[] {
		return Array.from({ length: count }, (_, index) => {
			const minor = first - index;
			const published = new Date(DAY_ZERO + minor * DAY_MS);
			return release(`v1.${minor}.0`, published.toISOString());
		});
	}

	it("stops at the first page that holds every previous tag", async () => {
		const firstPage = page(500, RELEASE_LISTING_PAGE_SIZE);
		const fetchPage = vi.fn(async (n: number) =>
			n === 1 ? firstPage : [],
		);

		const listing = await readReleaseListing(fetchPage, ["v1.500.0"]);

		expect(fetchPage).toHaveBeenCalledTimes(1);
		expect(listing).toHaveLength(RELEASE_LISTING_PAGE_SIZE);
	});

	it("reads further pages until the previous tag appears", async () => {
		const pages = [page(500, 100), page(400, 100), page(300, 100)];
		const fetchPage = vi.fn(async (n: number) => pages[n - 1] ?? []);

		const listing = await readReleaseListing(fetchPage, [
			"v1.500.0",
			"v1.401.0",
		]);

		expect(fetchPage).toHaveBeenCalledTimes(2);
		expect(listing).toHaveLength(200);
	});

	it("stops when the listing ends or after five pages", async () => {
		const short = vi.fn(async () => page(10, 3));
		const endless = vi.fn(async (n: number) => page(1000 - n * 100, 100));

		await readReleaseListing(short, ["v9.9.9"]);
		await readReleaseListing(endless, ["v9.9.9"]);

		expect(short).toHaveBeenCalledTimes(1);
		expect(endless).toHaveBeenCalledTimes(5);
	});
});

describe("formatTargetingContext", () => {
	it("lists work items and changed files per release", () => {
		const text = formatTargetingContext([
			targeting({
				changedPaths: ["apps/web/filters/Panel.tsx"],
				pathsTruncated: true,
				workItems: [
					{
						identifier: "F-12",
						title: "Saved filters",
						description: "Save a filter from the panel.",
						acceptanceCriteria:
							"A saved filter appears in the list.",
					},
				],
			}),
		]);

		expect(text).toBe(
			[
				"- [v1.2.0] (example-org/app)",
				"  Work items:",
				"  - F-12: Saved filters",
				"    Save a filter from the panel.",
				"    Acceptance: A saved filter appears in the list.",
				"  Changed files (first ones only):",
				"  apps/web/filters/Panel.tsx",
			].join("\n"),
		);
	});

	it("lists the pull requests a release names after its work items", () => {
		const text = formatTargetingContext([
			targeting({
				pullRequests: [
					{
						number: 42,
						title: "Add saved filters to the board",
						body: "Adds a Save button to the filter panel.",
					},
					{ number: 43, title: "Fix filter order" },
				],
			}),
		]);

		expect(text).toBe(
			[
				"- [v1.2.0] (example-org/app)",
				"  Pull requests:",
				"  - #42: Add saved filters to the board",
				"    Adds a Save button to the filter panel.",
				"  - #43: Fix filter order",
			].join("\n"),
		);
	});

	it("leaves out a release with nothing to add", () => {
		expect(formatTargetingContext([targeting()])).toBe("");
	});

	it("names releases past the budget without their detail", () => {
		const text = formatTargetingContext(
			[
				targeting({ tagName: "v1.2.0", changedPaths: ["a.ts"] }),
				targeting({ tagName: "v1.3.0", changedPaths: ["b.ts"] }),
			],
			60,
		);

		expect(text).toContain("  a.ts");
		expect(text).toContain(
			"- [v1.3.0] (example-org/app) (details omitted for length)",
		);
		expect(text).not.toContain("b.ts");
	});
});
