/**
 * The pure half of screenshot targeting: the shapes, how release notes name
 * pull requests, and the block curation reads. No I/O, so curation and its
 * tests import it without pulling in repository clients.
 */
import { PRODUCTION_TAG_PATTERN } from "../../workflows/newsletter-release-select";
import type { GitHubRelease } from "../daily-brief/collect-github-releases";

/** Changed paths kept per release; the rest is reported as truncated. */
export const TARGETING_PATHS_MAX = 200;
/** Work items kept per release. */
export const TARGETING_WORK_ITEMS_MAX = 5;
/** Pull requests a release names that are read, per release. */
export const TARGETING_PULL_REQUESTS_MAX = 5;
/** Characters the whole targeting block may add to the curation prompt. */
const TARGETING_PROMPT_BUDGET = 16_000;

export interface NewsletterTargetingWorkItem {
	identifier: string;
	title: string;
	description?: string;
	acceptanceCriteria?: string;
}

export interface NewsletterTargetingPullRequest {
	number: number;
	title: string;
	body?: string;
}

export interface NewsletterReleaseTargeting {
	repoFullName: string;
	tagName: string;
	changedPaths: string[];
	pathsTruncated: boolean;
	workItems: NewsletterTargetingWorkItem[];
	/** Optional: a payload recorded before pull requests were read has none. */
	pullRequests?: NewsletterTargetingPullRequest[];
}

const URL_ORIGIN = /^https?:\/\/[^/]+/i;
const PULL_REQUEST_SUFFIX =
	/(?:\/-)?\/(?:pull|pull-requests|pullrequest|merge_requests)\/\d+$/i;

/**
 * Whether a pull request URL belongs to `repoFullName` (`owner/repo`): the
 * path before the pull request part ends with it. GitLab's `/-` separator is
 * ignored.
 */
function isSameRepositoryUrl(url: string, repoFullName: string): boolean {
	const path = url.replace(URL_ORIGIN, "").replace(PULL_REQUEST_SUFFIX, "");
	return path.toLowerCase().endsWith(`/${repoFullName.toLowerCase()}`);
}

/**
 * Pull request references in a release body: full pull/merge request URLs,
 * and `#123` shorthands. A number is matched against the release's own
 * repository, so only shorthands and URLs of that repository give one; a URL
 * from another repository is kept for matching by URL only.
 */
export function extractPullRequestRefs(
	body: string | undefined,
	repoFullName: string,
): {
	urls: string[];
	numbers: number[];
} {
	if (!body) {
		return { urls: [], numbers: [] };
	}
	const urls = new Set<string>();
	const numbers = new Set<number>();
	for (const match of body.matchAll(
		/https?:\/\/[^\s)<>"']+\/(?:pull|pull-requests|pullrequest|merge_requests)\/(\d+)/gi,
	)) {
		urls.add(match[0]);
		if (isSameRepositoryUrl(match[0], repoFullName)) {
			numbers.add(Number(match[1]));
		}
	}
	for (const match of body.matchAll(/(?:^|[\s(])#(\d{1,7})\b/g)) {
		numbers.add(Number(match[1]));
	}
	return { urls: [...urls].slice(0, 50), numbers: [...numbers].slice(0, 50) };
}

/**
 * A story field as plain text. Descriptions are stored as TipTap JSON or as
 * plain text; for JSON, the text runs are joined.
 */
export function plainStoryText(value: string | null | undefined): string {
	if (!value) {
		return "";
	}
	const trimmed = value.trim();
	if (!trimmed.startsWith("{")) {
		return trimmed;
	}
	const runs = [...trimmed.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(
		(match) => {
			try {
				return String(JSON.parse(`"${match[1]}"`));
			} catch {
				return match[1];
			}
		},
	);
	return runs.join(" ").replace(/\s+/g, " ").trim();
}

/** `text` cut to `max` characters, marked when cut. */
export function clipText(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * The block appended to the curation prompt. Releases are listed in the order
 * given; once the budget is spent the rest are named without detail, and a
 * release with nothing to add is left out.
 */
export function formatTargetingContext(
	releases: readonly NewsletterReleaseTargeting[],
	budget = TARGETING_PROMPT_BUDGET,
): string {
	const blocks: string[] = [];
	let used = 0;
	for (const release of releases) {
		const lines = [`- [${release.tagName}] (${release.repoFullName})`];
		if (release.workItems.length > 0) {
			lines.push("  Work items:");
			for (const item of release.workItems) {
				lines.push(`  - ${item.identifier}: ${item.title}`);
				if (item.description) {
					lines.push(`    ${item.description}`);
				}
				if (item.acceptanceCriteria) {
					lines.push(`    Acceptance: ${item.acceptanceCriteria}`);
				}
			}
		}
		const pullRequests = release.pullRequests ?? [];
		if (pullRequests.length > 0) {
			lines.push("  Pull requests:");
			for (const pull of pullRequests) {
				lines.push(`  - #${pull.number}: ${pull.title}`);
				if (pull.body) {
					lines.push(`    ${pull.body}`);
				}
			}
		}
		if (release.changedPaths.length > 0) {
			lines.push(
				`  Changed files${release.pathsTruncated ? " (first ones only)" : ""}:`,
				...release.changedPaths.map((path) => `  ${path}`),
			);
		}
		if (lines.length === 1) {
			continue;
		}
		const block = lines.join("\n");
		if (used + block.length > budget) {
			blocks.push(`${lines[0]} (details omitted for length)`);
			continue;
		}
		used += block.length;
		blocks.push(block);
	}
	return blocks.join("\n");
}

/**
 * The tag a release follows: the newest published, stable production release
 * older than it. Null when it is the first one or is not in the listing.
 */
export function previousProductionTag(
	listing: readonly GitHubRelease[],
	tagName: string,
): string | null {
	const ordered = listing
		.filter(
			(release) =>
				!release.draft &&
				!release.prerelease &&
				release.published_at !== null &&
				PRODUCTION_TAG_PATTERN.test(release.tag_name),
		)
		.sort(
			(a, b) =>
				new Date(b.published_at ?? 0).getTime() -
				new Date(a.published_at ?? 0).getTime(),
		);
	const index = ordered.findIndex((release) => release.tag_name === tagName);
	return index >= 0 ? (ordered[index + 1]?.tag_name ?? null) : null;
}

/** Releases per page of the listing, and the pages read at most. */
export const RELEASE_LISTING_PAGE_SIZE = 100;
const RELEASE_LISTING_PAGES_MAX = 5;

/**
 * The release listing, read a page at a time until every tag in `tagNames`
 * has a previous production tag, the listing ends, or the page cap is spent.
 */
export async function readReleaseListing(
	fetchPage: (page: number) => Promise<GitHubRelease[]>,
	tagNames: readonly string[],
): Promise<GitHubRelease[]> {
	const listing: GitHubRelease[] = [];
	for (let page = 1; page <= RELEASE_LISTING_PAGES_MAX; page++) {
		const releases = await fetchPage(page);
		listing.push(...releases);
		if (
			releases.length < RELEASE_LISTING_PAGE_SIZE ||
			tagNames.every(
				(tag) => previousProductionTag(listing, tag) !== null,
			)
		) {
			break;
		}
	}
	return listing;
}
