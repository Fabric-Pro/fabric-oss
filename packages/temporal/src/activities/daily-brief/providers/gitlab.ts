/**
 * Daily Brief — GitLab fetchers (gitlab.com only — matches the OAuth connect
 * flow). All results are normalized to the collectors' GitHub-shaped internal
 * structures so downstream classification/budget logic is provider-blind.
 *
 * Token freshness: callers pass a refresh-aware `getToken` (resolve-repo-auth);
 * it is also wired as gitlabRequest's onRefreshToken for 401 retry.
 */
import { GitLabApiError, gitlabRequest } from "@repo/integrations/gitlab";
import type { GitHubPullRequest } from "../collect-github-pull-requests";
import type { GitHubRelease } from "../collect-github-releases";

const PER_PAGE = 100;
const MAX_RELEASE_PAGES = 5;
const MR_PER_PAGE = 50;
const MAX_MRS_PER_REPO = 100; // mirrors MAX_PRS_PER_REPO
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_FETCH_MS = 500;

interface GitLabReleaseJson {
	tag_name: string;
	name: string | null;
	description: string | null;
	released_at: string | null;
	upcoming_release?: boolean;
	author?: { username?: string } | null;
	_links?: { self?: string } | null;
}

function toNormalizedRelease(
	r: GitLabReleaseJson,
	repositoryUrl: string,
): GitHubRelease {
	return {
		tag_name: r.tag_name,
		name: r.name,
		draft: false,
		prerelease: r.upcoming_release === true,
		published_at: r.released_at,
		html_url:
			r._links?.self ??
			`${repositoryUrl}/-/releases/${encodeURIComponent(r.tag_name)}`,
		author: r.author?.username ? { login: r.author.username } : null,
		body: r.description,
	};
}

/**
 * FR-6: failure reasons must carry the provider name — PROVIDER-TOTAL: not just
 * GitLabApiError but also generic refresh/network/abort/decrypt errors get the
 * prefix, because the collectors persist `err.message` straight into failures[].
 */
function wrapGitLabError(err: unknown): Error {
	if (err instanceof GitLabApiError) {
		return new Error(
			`GitLab API error: HTTP ${err.status}: ${err.message}`,
		);
	}
	const message = err instanceof Error ? err.message : String(err);
	return new Error(`GitLab: ${message}`);
}

/** Race getToken against the remaining budget — a stalled OAuth refresh must
 *  degrade into this repo's failure, never the activity's hard timeout. The
 *  losing refresh promise resolves later harmlessly (single-flight map). */
async function getTokenBounded(
	getToken: () => Promise<string>,
	timeoutMs: number,
): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			getToken(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("token acquisition timed out")),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

export async function fetchGitLabReleases(args: {
	getToken: () => Promise<string>;
	owner: string;
	repo: string;
	repositoryUrl: string;
	remainingMs: () => number;
}): Promise<{ releases: GitHubRelease[]; truncated: boolean }> {
	try {
		// Budget the token acquisition itself — a stalled OAuth refresh must not
		// run unbounded ahead of the first budget check (FR-8/FR-10).
		const remaining = args.remainingMs();
		if (remaining < MIN_FETCH_MS) {
			return { releases: [], truncated: true };
		}
		const token = await getTokenBounded(
			args.getToken,
			Math.min(REQUEST_TIMEOUT_MS, remaining),
		);
		const projectPath = encodeURIComponent(`${args.owner}/${args.repo}`);
		const releases: GitHubRelease[] = [];
		let truncated = false;
		for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
			// NEVER start a request after the budget is gone (FR-8/FR-10).
			const remaining = args.remainingMs();
			if (remaining < MIN_FETCH_MS) {
				truncated = true;
				break;
			}
			const { body, headers } = await gitlabRequest<GitLabReleaseJson[]>({
				path: `/projects/${projectPath}/releases`,
				token,
				query: { per_page: PER_PAGE, page },
				// The 401-refresh await inside gitlabRequest is NOT cancelled by the
				// fetch AbortSignal — bound it too. Math.max floor: a 401 can arrive
				// after the budget ticked below MIN_FETCH_MS mid-page; the refresh
				// still gets a small positive bound, never a zero/negative timer.
				onRefreshToken: () =>
					getTokenBounded(
						args.getToken,
						Math.min(
							REQUEST_TIMEOUT_MS,
							Math.max(MIN_FETCH_MS, args.remainingMs()),
						),
					),
				signal: AbortSignal.timeout(
					Math.min(REQUEST_TIMEOUT_MS, remaining),
				),
			});
			releases.push(
				...(body ?? []).map((r) =>
					toNormalizedRelease(r, args.repositoryUrl),
				),
			);
			const hasNext = Boolean(headers.get("x-next-page"));
			if (!hasNext) {
				break;
			}
			if (page === MAX_RELEASE_PAGES) {
				truncated = true;
			}
		}
		return { releases, truncated };
	} catch (err) {
		throw wrapGitLabError(err);
	}
}

export async function fetchGitLabLatestRelease(args: {
	getToken: () => Promise<string>;
	owner: string;
	repo: string;
	repositoryUrl: string;
	timeoutMs: number;
}): Promise<GitHubRelease | null> {
	// getToken INSIDE the try — a refresh failure must also get the provider prefix.
	try {
		// Bound the token acquisition by the caller's timeout (caller guarantees
		// timeoutMs ≥ MIN_FETCH_MS) so a stalled refresh can't blow the activity budget.
		const token = await getTokenBounded(args.getToken, args.timeoutMs);
		const projectPath = encodeURIComponent(`${args.owner}/${args.repo}`);
		const { body } = await gitlabRequest<GitLabReleaseJson>({
			path: `/projects/${projectPath}/releases/permalink/latest`,
			token,
			// Bound the 401-refresh path too — it is awaited inside gitlabRequest
			// and is not cancelled by the fetch AbortSignal.
			onRefreshToken: () =>
				getTokenBounded(args.getToken, args.timeoutMs),
			signal: AbortSignal.timeout(args.timeoutMs),
		});
		return body ? toNormalizedRelease(body, args.repositoryUrl) : null;
	} catch (err) {
		if (err instanceof GitLabApiError && err.status === 404) {
			return null;
		}
		throw wrapGitLabError(err);
	}
}

interface GitLabMergeRequestJson {
	iid: number;
	title: string;
	description: string | null;
	state: "opened" | "closed" | "locked" | "merged";
	draft?: boolean;
	web_url: string;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	merged_at: string | null;
	author?: { username?: string } | null;
	reviewers?: Array<{ username?: string }> | null;
	source_branch?: string | null;
	target_branch?: string | null;
}

function toNormalizedMr(mr: GitLabMergeRequestJson): GitHubPullRequest {
	return {
		number: mr.iid,
		title: mr.title,
		body: mr.description,
		state:
			mr.state === "opened" || mr.state === "locked" ? "open" : "closed",
		draft: mr.draft === true,
		html_url: mr.web_url,
		created_at: mr.created_at,
		updated_at: mr.updated_at,
		closed_at: mr.closed_at ?? mr.merged_at,
		merged_at: mr.merged_at,
		user: mr.author?.username ? { login: mr.author.username } : null,
		requested_reviewers: (mr.reviewers ?? [])
			.filter((r) => r.username)
			.map((r) => ({ login: r.username as string })),
		head: mr.source_branch ? { ref: mr.source_branch } : null,
		base: mr.target_branch ? { ref: mr.target_branch } : null,
	};
}

/** Sorted updated_at desc server-side → same short-circuit invariant as GitHub. */
export async function fetchGitLabMergeRequests(args: {
	getToken: () => Promise<string>;
	owner: string;
	repo: string;
	updatedSince: Date;
	remainingMs: () => number;
}): Promise<{ mrs: GitHubPullRequest[]; truncated: boolean }> {
	try {
		// Budget the token acquisition itself — a stalled OAuth refresh must not
		// run unbounded ahead of the first budget check (FR-8/FR-10).
		const remaining = args.remainingMs();
		if (remaining < MIN_FETCH_MS) {
			return { mrs: [], truncated: true };
		}
		const token = await getTokenBounded(
			args.getToken,
			Math.min(REQUEST_TIMEOUT_MS, remaining),
		);
		const projectPath = encodeURIComponent(`${args.owner}/${args.repo}`);
		const collected: GitLabMergeRequestJson[] = [];
		// `truncated` = ANY incomplete pagination (budget cut OR cap cut) —
		// only the three proven-complete exits clear it (FR-10; cache writes
		// require proven window coverage).
		let complete = false;
		const MAX_PAGES = Math.ceil(MAX_MRS_PER_REPO / MR_PER_PAGE);
		for (let page = 1; page <= MAX_PAGES; page++) {
			// Never start a request past the budget.
			const remaining = args.remainingMs();
			if (remaining < MIN_FETCH_MS) {
				break; // complete stays false
			}
			const { body } = await gitlabRequest<GitLabMergeRequestJson[]>({
				path: `/projects/${projectPath}/merge_requests`,
				token,
				query: {
					state: "all",
					order_by: "updated_at",
					sort: "desc",
					per_page: MR_PER_PAGE,
					page,
				},
				// Bound the 401-refresh path too (not cancelled by the AbortSignal);
				// Math.max floor: see fetchGitLabReleases.
				onRefreshToken: () =>
					getTokenBounded(
						args.getToken,
						Math.min(
							REQUEST_TIMEOUT_MS,
							Math.max(MIN_FETCH_MS, args.remainingMs()),
						),
					),
				signal: AbortSignal.timeout(
					Math.min(REQUEST_TIMEOUT_MS, remaining),
				),
			});
			const pageMrs = body ?? [];
			if (pageMrs.length === 0) {
				complete = true;
				break;
			}
			collected.push(...pageMrs);
			const last = pageMrs[pageMrs.length - 1];
			if (
				last &&
				new Date(last.updated_at).getTime() <
					args.updatedSince.getTime()
			) {
				complete = true; // window provably exhausted (updated-desc ordering)
				break;
			}
			if (pageMrs.length < MR_PER_PAGE) {
				complete = true;
				break;
			}
			if (collected.length >= MAX_MRS_PER_REPO) {
				break; // cap WITHOUT window proof
			}
		}
		return {
			mrs: collected.slice(0, MAX_MRS_PER_REPO).map(toNormalizedMr),
			truncated: !complete,
		};
	} catch (err) {
		throw wrapGitLabError(err);
	}
}
