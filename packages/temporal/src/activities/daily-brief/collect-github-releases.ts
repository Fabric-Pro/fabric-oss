/**
 * Daily Brief — Releases Collector Activity (multi-provider)
 *
 * Fetches PUBLISHED releases (not PRs/commits) for a project's connected
 * repositories — across GitHub, GitLab, and Azure DevOps — and returns
 * `DeploymentItem[]` for the Daily Brief "Deployments" section. Drafts and
 * pre-releases are excluded (only real production releases).
 *
 * Per-repo dispatch (`resolveRepoAuth`): GitHub uses the in-file fetchers;
 * GitLab/ADO fetchers live in `./providers/*` and normalize into the same
 * GitHub-shaped `GitHubRelease` structure so all downstream window-filter, cap,
 * and anchor logic is provider-blind. ADO "releases" are ANNOTATED git tags and
 * the tag scan is FAIL-CLOSED — a truncated scan contributes zero items and zero
 * anchor candidate plus a failure entry, never a partial "latest" (ADO refs are
 * name-sorted, so a partial scan can't prove latest/window completeness). GitLab
 * access tokens (~2h) are refreshed per-repo at fetch time via the resolver's
 * refresh-aware `getToken` (+ `gitlabRequest` 401 retry).
 *
 * Tolerant of partial failures: a failing repo (auth, rate-limit, moved, network)
 * is recorded in `failures[]` rather than throwing; the workflow summarizes these
 * into the rollback-safe optional `deploymentsError` content field.
 *
 * IMPORTANT — GitHub's `/releases` endpoint is ordered by `created_at` desc, NOT
 * `published_at`. A release created as a draft long ago but published recently has
 * an old `created_at` (sorts last) but an in-window `published_at`. So we MUST NOT
 * short-circuit pagination on `published_at`; we page exhaustively up to a cap and
 * filter client-side, flagging truncation as a partial failure.
 *
 * No new deps: direct `fetch` against api.github.com / dev.azure.com, with
 * `gitlabRequest` for GitLab, matching `collect-github-pull-requests.ts`.
 */

import {
	type DeploymentItem,
	db,
	getProjectReposForCodeSearch,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import {
	ADO_RELEASE_SCAN_INCOMPLETE,
	fetchAdoAnnotatedTagReleases,
} from "./providers/azure-devops";
import {
	fetchGitLabLatestRelease,
	fetchGitLabReleases,
} from "./providers/gitlab";
import { type RepoAuth, resolveRepoAuth } from "./resolve-repo-auth";

export interface CollectGitHubReleasesActivityInput {
	projectId: string;
	organizationId: string | null;
	/** The brief's triggering user — used to bind personal-context credentials. */
	userId: string;
	timeWindowStart: Date | string;
	timeWindowEnd: Date | string;
}

export interface GitHubRepoFailure {
	repoFullName: string;
	reason: string;
}

export interface CollectGitHubReleasesActivityOutput {
	items: DeploymentItem[];
	failures: GitHubRepoFailure[];
	latestRelease?: DeploymentItem; // global newest (back-compat / rollback / EMPTY-gate)
	latestReleasesByRepo?: DeploymentItem[]; // one per repo, newest-first; omitted if empty
	/** Count of ACTIVE repo integrations scanned (0 on no repos; absent on tenant-mismatch).
	 *  Lets the newsletter distinguish "no active repos" from "no in-window releases". */
	activeRepoCount?: number;
}

const GITHUB_API_URL = "https://api.github.com";
const PER_PAGE = 100;
const MAX_RELEASE_PAGES = 5; // up to 500 releases per repo — a safety net
const RELEASE_BODY_CHAR_CAP = 10_000; // per-release ceiling; aggregate budget below bounds the section
const MAX_DEPLOYMENT_ITEMS = 50; // hard cap on rendered/persisted in-window releases
const RELEASE_NOTES_TOTAL_BUDGET = 100_000; // aggregate body-char budget across items
export const RELEASE_NOTES_OMITTED_NOTICE =
	"_Release notes omitted to keep this brief within size limits — open the release on GitHub._";
const HEARTBEAT_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000; // per HTTP request — a stalled repo fails fast
const SOFT_BUDGET_MS = 120_000; // wall-clock cap → return partial data before the deadline
const LATEST_PHASE_BUDGET_MS = 30_000; // dedicated budget for the cheap latest-anchor pass
// Soft overall-activity deadline (~15s under the 3-min startToCloseTimeout) — the
// per-request timeout is clamped to whatever margin remains so a stalled latest
// request can never push the activity into its hard timeout (losing all partial data).
const ACTIVITY_SOFT_DEADLINE_MS = 165_000;

interface GitHubReleaseAuthor {
	login: string;
}

export interface GitHubRelease {
	tag_name: string;
	name: string | null;
	draft: boolean;
	prerelease: boolean;
	published_at: string | null;
	html_url: string;
	author: GitHubReleaseAuthor | null;
	body: string | null;
}

function truncateBody(body: string | null | undefined): string | undefined {
	if (!body) {
		return undefined;
	}
	const trimmed = body.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	return trimmed.length > RELEASE_BODY_CHAR_CAP
		? `${trimmed.slice(0, RELEASE_BODY_CHAR_CAP)}…`
		: trimmed;
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	try {
		return String(err);
	} catch {
		return "Unknown error";
	}
}

function toDeploymentItem(
	release: GitHubRelease,
	repoFullName: string,
): DeploymentItem | null {
	if (!release.published_at) {
		return null;
	}
	const body = truncateBody(release.body);
	return {
		occurredAt: new Date(release.published_at),
		title:
			release.name && release.name.trim().length > 0
				? release.name
				: release.tag_name,
		repoFullName,
		tagName: release.tag_name,
		...(release.name ? { releaseName: release.name } : {}),
		url: release.html_url,
		...(release.author?.login ? { author: release.author.login } : {}),
		...(body ? { body } : {}),
	};
}

/** GitHub's canonical "Latest" release (non-draft, non-prerelease). 404 → null.
 *  `timeoutMs` is the caller-computed per-request bound (min of the request timeout
 *  and the remaining latest-phase / overall-activity budget) so a single stalled
 *  request cannot push the activity into its hard startToCloseTimeout. */
async function fetchLatestReleaseForRepo(args: {
	accessToken: string;
	owner: string;
	repo: string;
	timeoutMs: number;
}): Promise<GitHubRelease | null> {
	const { accessToken, owner, repo, timeoutMs } = args;
	const response = await fetch(
		`${GITHUB_API_URL}/repos/${owner}/${repo}/releases/latest`,
		{
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/vnd.github.v3+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "Fabric-DailyBrief",
			},
			signal: AbortSignal.timeout(timeoutMs),
		},
	);
	if (response.status === 404) {
		return null; // no published non-prerelease release
	}
	if (!response.ok) {
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			body = null;
		}
		const message =
			(body as { message?: string } | null)?.message ??
			`HTTP ${response.status}`;
		throw new Error(`GitHub API error (latest): ${message}`);
	}
	return (await response.json()) as GitHubRelease;
}

interface FetchReleasesResult {
	releases: GitHubRelease[];
	truncated: boolean;
}

/** Parse the `rel="next"` URL out of a GitHub `Link` header, or null. */
function parseNextLink(linkHeader: string | null): string | null {
	if (!linkHeader) {
		return null;
	}
	for (const part of linkHeader.split(",")) {
		const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
		if (match) {
			return match[1];
		}
	}
	return null;
}

/**
 * Follow GitHub's `Link: rel="next"` pagination up to MAX_RELEASE_PAGES. Returns
 * `truncated: true` ONLY when the cap is hit while a `next` page still exists — so
 * an exhausted list (no next link) never reports a false truncation, even when the
 * final page is exactly full.
 *
 * We do NOT short-circuit on published_at: the endpoint is ordered by created_at,
 * so a draft-then-published release (old created_at, in-window published_at) can
 * appear on a later page. We page exhaustively up to the cap and filter client-side.
 */
async function fetchReleasesForRepo(args: {
	accessToken: string;
	owner: string;
	repo: string;
}): Promise<FetchReleasesResult> {
	const { accessToken, owner, repo } = args;
	const collected: GitHubRelease[] = [];
	let lastHeartbeat = Date.now();
	let nextUrl: string | null =
		`${GITHUB_API_URL}/repos/${owner}/${repo}/releases?per_page=${PER_PAGE}`;
	let pages = 0;

	while (nextUrl && pages < MAX_RELEASE_PAGES) {
		if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
			heartbeat(
				`fetchReleasesForRepo: ${owner}/${repo} page=${pages + 1}`,
			);
			lastHeartbeat = Date.now();
		}

		const response = await fetch(nextUrl, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/vnd.github.v3+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "Fabric-DailyBrief",
			},
			// Bound each request so one stalled repo can't consume the whole budget;
			// an abort surfaces as this repo's failure entry (graceful degradation).
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		if (!response.ok) {
			let body: unknown;
			try {
				body = await response.json();
			} catch {
				body = null;
			}
			const message =
				(body as { message?: string } | null)?.message ??
				`HTTP ${response.status}`;
			throw new Error(`GitHub API error: ${message}`);
		}

		const pageReleases = (await response.json()) as GitHubRelease[];
		collected.push(...pageReleases);
		nextUrl = parseNextLink(response.headers.get("link"));
		pages++;
	}

	// Stopped because of the cap but a `next` link still exists → more remain.
	return { releases: collected, truncated: nextUrl !== null };
}

function isWithinWindow(at: Date, start: Date, end: Date): boolean {
	const t = at.getTime();
	return t >= start.getTime() && t <= end.getTime();
}

export async function collectGitHubReleasesActivity(
	input: CollectGitHubReleasesActivityInput,
): Promise<CollectGitHubReleasesActivityOutput> {
	const activityStartedAt = Date.now(); // BEFORE the first await — activity-deadline clock
	const { projectId, organizationId, userId } = input;
	const timeWindowStart = new Date(input.timeWindowStart);
	const timeWindowEnd = new Date(input.timeWindowEnd);

	heartbeat("collectGitHubReleasesActivity: starting");
	logger.info("[DailyBrief/collectGitHubReleases] Starting", {
		projectId,
		organizationId,
		timeWindowStart: timeWindowStart.toISOString(),
		timeWindowEnd: timeWindowEnd.toISOString(),
	});

	// Tenant belt-and-suspenders: this activity runs in the worker DB context
	// (outside request RLS) and decrypts repo credentials, so re-assert the
	// project belongs to the expected tenant BEFORE any repo lookup or token use.
	// Fabric's tenant key is the XOR tuple {organizationId, userId}: org context is
	// keyed by org (projects shared by members → org match suffices); personal
	// context has org === null for everyone, so it MUST also bind the user. The
	// brief's projectId is validated upstream by the tenantProtectedProcedure that
	// starts the workflow; this fail-fast guards a stale/mismatched input.
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true, userId: true },
	});
	const inputOrg = organizationId ?? null;
	const tenantMatches =
		project != null &&
		(project.organizationId ?? null) === inputOrg &&
		(inputOrg !== null || project.userId === userId);
	if (!tenantMatches) {
		logger.warn(
			"[DailyBrief/collectGitHubReleases] Project/tenant mismatch — skipping",
			{
				projectId,
				organizationId,
				userId,
				projectOrganizationId: project?.organizationId ?? null,
				projectUserId: project?.userId ?? null,
			},
		);
		return { items: [], failures: [] };
	}

	const allRepos = await getProjectReposForCodeSearch(projectId);

	if (allRepos.length === 0) {
		logger.info(
			"[DailyBrief/collectGitHubReleases] No active repo integrations",
			{
				projectId,
			},
		);
		return { items: [], failures: [], activeRepoCount: 0 };
	}

	const items: DeploymentItem[] = [];
	const failures: GitHubRepoFailure[] = [];

	// Resolve pre-pass (sync; GitLab token NETWORK resolution stays inside the
	// budgeted fetch step so a slow refresh counts against that repo's time, not
	// the setup phase). Unsupported combos become failures here, so every
	// remaining target is latest-eligible.
	interface ResolvedTarget {
		repoFullName: string;
		owner: string;
		repo: string;
		repositoryUrl: string;
		auth: Exclude<RepoAuth, { kind: "unsupported" }>;
	}
	const targets: ResolvedTarget[] = [];
	// Concurrent: credential resolution may hit the network per repo and the
	// repos are independent (the refresh is advisory-locked per integration).
	const resolved = await Promise.all(
		allRepos.map(async (repo) => ({
			repo,
			auth: await resolveRepoAuth(repo, { userId, organizationId }),
		})),
	);
	for (const { repo, auth } of resolved) {
		const repoFullName = `${repo.owner}/${repo.repo}`;
		if (auth.kind === "unsupported") {
			failures.push({ repoFullName, reason: auth.reason });
			continue;
		}
		targets.push({
			repoFullName,
			owner: repo.owner,
			repo: repo.repo,
			repositoryUrl: repo.repositoryUrl,
			auth,
		});
	}

	// Per-activity cache of ADO tag scans: Phase 1 runs the (multi-call, fail-closed)
	// scan ONCE and Phase 2 reuses its result for the latest anchor — no second
	// network round-trip for ADO.
	const adoScans = new Map<
		string,
		{ releases: GitHubRelease[]; failClosed: boolean }
	>();

	// Phase 1 (list) — iterate targets; keep the existing window-filter /
	// truncation logic, but guard each iteration with BOTH the soft budget AND the
	// activity deadline so a setup stall can't let the list run into the hard timeout:
	const startedAt = Date.now(); // list-phase budget clock (post-setup, as today)
	// Shared remaining-budget closure for the budgeted multi-call providers
	// (GitLab pagination, ADO refs + per-tag detail). Min of the soft budget and
	// the overall-activity deadline margin (from the REAL activity start).
	const phaseRemaining = () =>
		Math.min(
			SOFT_BUDGET_MS - (Date.now() - startedAt),
			ACTIVITY_SOFT_DEADLINE_MS - (Date.now() - activityStartedAt),
		);
	for (let i = 0; i < targets.length; i++) {
		const target = targets[i];
		if (
			Date.now() - startedAt > SOFT_BUDGET_MS ||
			Date.now() - activityStartedAt > ACTIVITY_SOFT_DEADLINE_MS
		) {
			for (let j = i; j < targets.length; j++) {
				failures.push({
					repoFullName: targets[j].repoFullName,
					reason: "Skipped — release fetch time budget exceeded for this brief",
				});
			}
			break;
		}

		heartbeat(`collectGitHubReleasesActivity: repo=${target.repoFullName}`);
		try {
			let releases: GitHubRelease[];
			let truncated = false;
			if (target.auth.kind === "github") {
				({ releases, truncated } = await fetchReleasesForRepo({
					accessToken: target.auth.token,
					owner: target.owner,
					repo: target.repo,
				}));
			} else if (target.auth.kind === "gitlab") {
				({ releases, truncated } = await fetchGitLabReleases({
					getToken: target.auth.getToken,
					owner: target.owner,
					repo: target.repo,
					repositoryUrl: target.repositoryUrl,
					remainingMs: phaseRemaining,
				}));
			} else {
				const scan = await fetchAdoAnnotatedTagReleases({
					auth: target.auth,
					repo: target.repo,
					repositoryUrl: target.repositoryUrl,
					remainingMs: phaseRemaining,
				});
				adoScans.set(target.repoFullName, scan);
				if (scan.failClosed) {
					failures.push({
						repoFullName: target.repoFullName,
						reason: ADO_RELEASE_SCAN_INCOMPLETE,
					});
					continue;
				}
				releases = scan.releases;
			}

			for (const release of releases) {
				if (release.draft || release.prerelease) {
					continue;
				}
				if (!release.published_at) {
					continue;
				}
				const publishedAt = new Date(release.published_at);
				if (
					!isWithinWindow(publishedAt, timeWindowStart, timeWindowEnd)
				) {
					continue;
				}
				const item = toDeploymentItem(release, target.repoFullName);
				if (item) {
					items.push(item);
				}
			}

			if (truncated) {
				failures.push({
					repoFullName: target.repoFullName,
					reason: `Release list truncated at ${MAX_RELEASE_PAGES * PER_PAGE}; some older in-window releases may be missing`,
				});
			}
		} catch (err) {
			const reason = errorMessage(err);
			logger.warn(
				"[DailyBrief/collectGitHubReleases] Repo fetch failed",
				{
					repoFullName: target.repoFullName,
					reason,
				},
			);
			failures.push({ repoFullName: target.repoFullName, reason });
		}
	}

	// ---- Phase 2: GitHub-canonical latest release per repo (window-independent) ----
	// Separate pass from the list scan: (a) a list FAILURE never suppresses the anchor,
	// and (b) the anchor is NOT starved by a slow list phase — Phase 2 has its OWN budget
	// measured from when this pass starts (NOT the shared soft budget the list consumed),
	// so a degraded/slow list still yields the resilient prod-release fallback. The
	// dedicated budget keeps the cheap (1 request/repo) pass bounded for pathological
	// multi-repo projects.
	let latestRelease: DeploymentItem | undefined;
	const latestByRepo = new Map<string, DeploymentItem>();
	const occurredMs = (d: Date | string) =>
		d instanceof Date ? d.getTime() : new Date(d).getTime();
	const latestPhaseStart = Date.now();
	const MIN_FETCH_MS = 500; // below this remaining margin, don't even start a request
	for (const target of targets) {
		// Per-call timeout = the smallest of: the request timeout, the remaining
		// dedicated latest budget, and the remaining overall-activity margin (from the
		// REAL activity start, so setup-time is counted). A request started near a budget
		// edge is clamped so it can't run a full REQUEST_TIMEOUT_MS past the deadline.
		const latestRemaining =
			LATEST_PHASE_BUDGET_MS - (Date.now() - latestPhaseStart);
		const activityRemaining =
			ACTIVITY_SOFT_DEADLINE_MS - (Date.now() - activityStartedAt);
		const perCall = Math.min(
			REQUEST_TIMEOUT_MS,
			latestRemaining,
			activityRemaining,
		);
		if (perCall < MIN_FETCH_MS) {
			failures.push({
				repoFullName: "*",
				reason: "Skipped some latest-release lookups — time budget exhausted",
			});
			break;
		}
		heartbeat(
			`collectGitHubReleasesActivity: latest ${target.repoFullName}`,
		);
		try {
			let latest: GitHubRelease | null = null;
			if (target.auth.kind === "github") {
				latest = await fetchLatestReleaseForRepo({
					accessToken: target.auth.token,
					owner: target.owner,
					repo: target.repo,
					timeoutMs: perCall,
				});
			} else if (target.auth.kind === "gitlab") {
				latest = await fetchGitLabLatestRelease({
					getToken: target.auth.getToken,
					owner: target.owner,
					repo: target.repo,
					repositoryUrl: target.repositoryUrl,
					timeoutMs: perCall,
				});
			} else {
				// ADO: reuse the earlier scan — no duplicate calls.
				// Missing/fail-closed scan → no candidate (failure already recorded).
				const scan = adoScans.get(target.repoFullName);
				latest =
					scan && !scan.failClosed
						? (scan.releases[0] ?? null)
						: null;
			}
			const candidate = latest
				? toDeploymentItem(latest, target.repoFullName)
				: null;
			if (candidate) {
				if (
					!latestRelease ||
					occurredMs(candidate.occurredAt) >
						occurredMs(latestRelease.occurredAt)
				) {
					latestRelease = candidate; // KEEP: global newest (rollback / EMPTY-gate)
				}
				const prev = latestByRepo.get(candidate.repoFullName);
				if (
					!prev ||
					occurredMs(candidate.occurredAt) >
						occurredMs(prev.occurredAt)
				) {
					latestByRepo.set(candidate.repoFullName, candidate); // dedupe by repo
				}
			}
		} catch (err) {
			failures.push({
				repoFullName: target.repoFullName,
				reason: `latest: ${errorMessage(err)}`,
			});
		}
	}

	// Per-repo latest releases: newest-first, repoFullName tiebreak for determinism,
	// MAX_DEPLOYMENT_ITEMS backstop (real arrays are tiny — one per active repo).
	const latestReleasesByRepo = [...latestByRepo.values()]
		.sort(
			(a, b) =>
				occurredMs(b.occurredAt) - occurredMs(a.occurredAt) ||
				a.repoFullName.localeCompare(b.repoFullName),
		)
		.slice(0, MAX_DEPLOYMENT_ITEMS);

	// Newest-first by published_at.
	items.sort((a, b) => {
		const at =
			a.occurredAt instanceof Date
				? a.occurredAt.getTime()
				: new Date(a.occurredAt).getTime();
		const bt =
			b.occurredAt instanceof Date
				? b.occurredAt.getTime()
				: new Date(b.occurredAt).getTime();
		return bt - at;
	});

	// Layer 1 — hard item-count cap (bounds item metadata). Record truncation.
	let bounded = items;
	if (items.length > MAX_DEPLOYMENT_ITEMS) {
		const dropped = items.length - MAX_DEPLOYMENT_ITEMS;
		bounded = items.slice(0, MAX_DEPLOYMENT_ITEMS);
		failures.push({
			repoFullName: "*",
			reason: `Deployments list truncated to ${MAX_DEPLOYMENT_ITEMS} most recent; ${dropped} older in-window release(s) omitted`,
		});
	}

	// Layer 2 — aggregate body budget (bounds note payload). Newest keep full
	// bodies; once the budget is exceeded, replace older bodies with an explicit
	// notice (NOT absent → distinguishable from "no notes"). Record one note.
	let used = 0;
	let omittedCount = 0;
	for (const item of bounded) {
		if (!item.body) {
			continue;
		}
		if (used + item.body.length <= RELEASE_NOTES_TOTAL_BUDGET) {
			used += item.body.length;
		} else {
			item.body = RELEASE_NOTES_OMITTED_NOTICE;
			omittedCount++;
		}
	}
	if (omittedCount > 0) {
		failures.push({
			repoFullName: "*",
			reason: `${omittedCount} release-note ${omittedCount === 1 ? "body" : "bodies"} omitted to stay within the brief size budget; open releases on GitHub for full notes`,
		});
	}

	logger.info("[DailyBrief/collectGitHubReleases] Complete", {
		projectId,
		repoCount: targets.length,
		itemCount: bounded.length,
		failureCount: failures.length,
	});

	return {
		items: bounded,
		failures,
		activeRepoCount: allRepos.length,
		...(latestRelease ? { latestRelease } : {}),
		...(latestReleasesByRepo.length > 0 ? { latestReleasesByRepo } : {}),
	};
}
