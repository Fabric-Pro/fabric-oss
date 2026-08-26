/**
 * Daily Brief — Azure DevOps fetchers.
 *
 * "Releases" for ADO = ANNOTATED git tags: tag name → release name,
 * tag message → notes, taggedDate → published date. Lightweight tags are not
 * releases. The tag scan is ALL-OR-NOTHING (fail closed): ADO refs are
 * name-sorted, so a partial scan can never prove "latest" or window
 * completeness — when caps/budget truncate the scan, the repo reports a
 * failure entry instead of plausible-but-wrong results.
 *
 * Pull requests use the documented searchCriteria time-window parameters with
 * $skip pagination until each bucket is exhausted — never the undocumented
 * default ordering. Boundary semantics: ±60s epsilon on the server-side window;
 * the collector's inclusive client-side filter is the source of truth.
 */

import type { GitHubPullRequest } from "../collect-github-pull-requests";
import type { GitHubRelease } from "../collect-github-releases";

const ADO_API_VERSION = "7.1";
const ADO_TAG_REFS_CAP = 1000;
const ADO_TAG_DETAIL_CAP = 50;
export const ADO_WINDOW_EPSILON_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_FETCH_MS = 500;
const PR_PAGE_SIZE = 100;
const MAX_PRS_PER_BUCKET = 100; // mirrors MAX_PRS_PER_REPO

export const ADO_RELEASE_SCAN_INCOMPLETE =
	"release scan incomplete (more than 50 annotated tags or budget exhausted) — releases omitted";
export const ADO_PR_SCAN_TRUNCATED =
	"PR scan truncated — some pull request activity may be missing";

export interface AdoAuth {
	basicAuth: string;
	organization: string;
	project: string;
}

/** Decode exactly once, tolerating an already-decoded value (malformed escapes
 *  pass through unchanged). */
function decodeOnce(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function adoBase(auth: AdoAuth, repo: string): string {
	// Repo and project names are stored RAW from the connect URL — a browser-copied
	// "My%20Repo" is already percent-encoded, and encoding it again double-encodes
	// to "My%2520Repo" (ADO 404). Decode-once first (a plain name is unchanged),
	// then encode exactly once — mirrors verifyAzureDevOpsBranch (repository-branch.ts).
	// Organization names cannot contain spaces, so they pass through as-is.
	return `https://dev.azure.com/${encodeURIComponent(auth.organization)}/${encodeURIComponent(
		decodeOnce(auth.project),
	)}/_apis/git/repositories/${encodeURIComponent(decodeOnce(repo))}`;
}

async function adoFetch<T>(args: {
	url: string;
	basicAuth: string;
	timeoutMs: number;
}): Promise<{ body: T; headers: Headers }> {
	const response = await fetch(args.url, {
		headers: {
			Authorization: args.basicAuth,
			Accept: "application/json",
			"User-Agent": "Fabric-DailyBrief",
		},
		signal: AbortSignal.timeout(args.timeoutMs),
	});
	if (!response.ok) {
		throw new Error(`Azure DevOps API error: HTTP ${response.status}`);
	}
	return { body: (await response.json()) as T, headers: response.headers };
}

interface AdoRef {
	name: string; // "refs/tags/v1.2.3"
	objectId: string; // annotated → tag OBJECT id; lightweight → commit id
	peeledObjectId?: string; // present (with peelTags=true) ONLY for annotated tags
}

interface AdoAnnotatedTag {
	name: string;
	message?: string | null;
	taggedBy?: { name?: string | null; date?: string | null } | null;
}

export async function fetchAdoAnnotatedTagReleases(args: {
	auth: AdoAuth;
	repo: string;
	repositoryUrl: string;
	remainingMs: () => number;
}): Promise<{ releases: GitHubRelease[]; failClosed: boolean }> {
	const failClosed = { releases: [], failClosed: true as const };

	// 1. Paginate ALL tag refs (cheap), bounded by ADO_TAG_REFS_CAP.
	const refs: AdoRef[] = [];
	let continuationToken: string | undefined;
	do {
		// Pre-check, then bound the request by the SAME remaining value — never
		// start (or stretch) a request after the budget is gone.
		const remaining = args.remainingMs();
		if (remaining < MIN_FETCH_MS) {
			return failClosed;
		}
		const url = new URL(`${adoBase(args.auth, args.repo)}/refs`);
		url.searchParams.set("filter", "tags/");
		url.searchParams.set("peelTags", "true");
		url.searchParams.set("api-version", ADO_API_VERSION);
		if (continuationToken) {
			url.searchParams.set("continuationToken", continuationToken);
		}
		const { body, headers } = await adoFetch<{ value: AdoRef[] }>({
			url: url.toString(),
			basicAuth: args.auth.basicAuth,
			timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining),
		});
		refs.push(...(body.value ?? []));
		continuationToken = headers.get("x-ms-continuationtoken") ?? undefined;
		if (continuationToken && refs.length >= ADO_TAG_REFS_CAP) {
			return failClosed;
		}
	} while (continuationToken);

	// 2. Annotated candidates only; over the detail cap → fail closed.
	const annotated = refs.filter((r) => r.peeledObjectId);
	if (annotated.length > ADO_TAG_DETAIL_CAP) {
		return failClosed;
	}

	// 3. Detail-fetch EVERY candidate (all-or-nothing).
	const releases: GitHubRelease[] = [];
	for (const tagRef of annotated) {
		const remaining = args.remainingMs();
		if (remaining < MIN_FETCH_MS) {
			return failClosed;
		}
		const detailUrl = `${adoBase(args.auth, args.repo)}/annotatedtags/${tagRef.objectId}?api-version=${ADO_API_VERSION}`;
		const { body } = await adoFetch<AdoAnnotatedTag>({
			url: detailUrl,
			basicAuth: args.auth.basicAuth,
			timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining),
		});
		const tagName = tagRef.name.replace(/^refs\/tags\//, "");
		releases.push({
			tag_name: tagName,
			name: tagName,
			draft: false,
			prerelease: false,
			published_at: body.taggedBy?.date ?? null,
			html_url: `${args.repositoryUrl}?version=GT${encodeURIComponent(tagName)}`,
			author: body.taggedBy?.name ? { login: body.taggedBy.name } : null,
			body: body.message ?? null,
		});
	}

	releases.sort(
		(a, b) =>
			new Date(b.published_at ?? 0).getTime() -
			new Date(a.published_at ?? 0).getTime(),
	);
	return { releases, failClosed: false };
}

interface AdoPullRequestJson {
	pullRequestId: number;
	title: string;
	description?: string | null;
	status: "active" | "completed" | "abandoned" | string;
	isDraft?: boolean;
	creationDate: string;
	closedDate?: string | null;
	createdBy?: { displayName?: string | null } | null;
	reviewers?: Array<{ displayName?: string | null; vote?: number }> | null;
	sourceRefName?: string | null;
	targetRefName?: string | null;
}

function stripRefsHeads(ref: string | null | undefined): string | null {
	return ref ? ref.replace(/^refs\/heads\//, "") : null;
}

function toNormalizedAdoPr(repositoryUrl: string) {
	return (pr: AdoPullRequestJson): GitHubPullRequest => ({
		number: pr.pullRequestId,
		title: pr.title,
		body: pr.description ?? null,
		state: pr.status === "active" ? "open" : "closed",
		draft: pr.isDraft === true,
		html_url: `${repositoryUrl}/pullrequest/${pr.pullRequestId}`,
		created_at: pr.creationDate,
		// ADO's list API exposes no update timestamp — creationDate is the
		// documented stand-in: awaiting-review windows on creation;
		// stale detection is conservatively creation-based.
		updated_at: pr.creationDate,
		closed_at: pr.status === "active" ? null : (pr.closedDate ?? null),
		merged_at: pr.status === "completed" ? (pr.closedDate ?? null) : null,
		user: pr.createdBy?.displayName
			? { login: pr.createdBy.displayName }
			: null,
		requested_reviewers: (pr.reviewers ?? [])
			.filter((r) => r.vote === 0 && r.displayName)
			.map((r) => ({ login: r.displayName as string })),
		head: stripRefsHeads(pr.sourceRefName)
			? { ref: stripRefsHeads(pr.sourceRefName) as string }
			: null,
		base: stripRefsHeads(pr.targetRefName)
			? { ref: stripRefsHeads(pr.targetRefName) as string }
			: null,
	});
}

export async function fetchAdoPullRequests(args: {
	auth: AdoAuth;
	repo: string;
	repositoryUrl: string;
	windowStart: Date;
	windowEnd: Date;
	remainingMs: () => number;
}): Promise<{ prs: GitHubPullRequest[]; truncated: boolean }> {
	const minTime = new Date(
		args.windowStart.getTime() - ADO_WINDOW_EPSILON_MS,
	).toISOString();
	const maxTime = new Date(
		args.windowEnd.getTime() + ADO_WINDOW_EPSILON_MS,
	).toISOString();
	const buckets: Array<Record<string, string>> = [
		{
			"searchCriteria.status": "completed",
			"searchCriteria.queryTimeRangeType": "closed",
			"searchCriteria.minTime": minTime,
			"searchCriteria.maxTime": maxTime,
		},
		{
			"searchCriteria.status": "abandoned",
			"searchCriteria.queryTimeRangeType": "closed",
			"searchCriteria.minTime": minTime,
			"searchCriteria.maxTime": maxTime,
		},
		{
			"searchCriteria.status": "all",
			"searchCriteria.queryTimeRangeType": "created",
			"searchCriteria.minTime": minTime,
			"searchCriteria.maxTime": maxTime,
		},
		{ "searchCriteria.status": "active" },
	];

	const byId = new Map<number, AdoPullRequestJson>();
	let truncated = false;
	for (const criteria of buckets) {
		let skip = 0;
		for (;;) {
			const remaining = args.remainingMs();
			if (remaining < MIN_FETCH_MS) {
				truncated = true;
				break;
			}
			const url = new URL(
				`${adoBase(args.auth, args.repo)}/pullrequests`,
			);
			for (const [k, v] of Object.entries(criteria)) {
				url.searchParams.set(k, v);
			}
			url.searchParams.set("$top", String(PR_PAGE_SIZE));
			url.searchParams.set("$skip", String(skip));
			url.searchParams.set("api-version", ADO_API_VERSION);
			const { body } = await adoFetch<{ value: AdoPullRequestJson[] }>({
				url: url.toString(),
				basicAuth: args.auth.basicAuth,
				timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining),
			});
			const page = body.value ?? [];
			for (const pr of page) {
				byId.set(pr.pullRequestId, pr);
			}
			if (page.length < PR_PAGE_SIZE) {
				break; // bucket exhausted — proven complete
			}
			skip += PR_PAGE_SIZE;
			if (skip >= MAX_PRS_PER_BUCKET) {
				truncated = true; // cap hit with more pages possible
				break;
			}
		}
	}

	return {
		prs: [...byId.values()].map(toNormalizedAdoPr(args.repositoryUrl)),
		truncated,
	};
}
