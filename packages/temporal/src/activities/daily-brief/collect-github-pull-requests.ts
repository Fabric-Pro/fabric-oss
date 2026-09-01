/**
 * Daily Brief — Pull Request Collector Activity (multi-provider)
 *
 * Fetches live PR / merge-request activity for a project's connected
 * repositories — GitHub, GitLab, and Azure DevOps — and returns classified
 * `GithubItem[]` conforming to the shared daily-brief schema. Each provider's
 * fetcher normalizes its raw data into the GitHub-shaped `GitHubPullRequest`
 * structure, so classification, the cache, budgets, and the stale-PR loop are
 * provider-blind.
 *
 * This activity is explicitly tolerant of partial failures: a failing repo
 * (auth expired, secondary rate limit, moved repo, network blip) is recorded
 * in `failures[]` rather than throwing. The caller/workflow surfaces these as
 * `partialFailures` entries in the brief.
 *
 * Design notes:
 *   - No new dependencies: reuses the monorepo's pattern of direct `fetch`
 *     against `api.github.com` (see `packages/integrations/src/github/index.ts`)
 *     for GitHub, `gitlabRequest` for GitLab, and direct `fetch` for ADO.
 *     Octokit is not a dependency anywhere in the repo and we do not add one
 *     just for this activity.
 *   - Credential resolution is delegated to `resolveRepoAuth` (per-repo,
 *     provider-specific, async). Unsupported provider/auth combinations become
 *     a per-repo failure entry in the resolve pre-pass. That pre-pass DOES
 *     refresh: GitHub resolves through the canonical refresh-aware helper and
 *     GitLab through its refresh-aware `getToken`, so a near-expiry token is
 *     renewed here rather than left to the background health check.
 *   - A 30-minute in-memory cache keyed by `integrationId` reduces duplicate
 *     API calls when multiple projects point at the same repo within the TTL
 *     window. Cached items are always re-filtered against the caller's
 *     `timeWindowStart/End` because the cached set may be wider. GitHub and
 *     GitLab both fetch "everything updated since the window start, unbounded
 *     above", which honors the cache's superset-coverage contract.
 *   - **Azure DevOps bypasses the cache entirely.** Its closed/created buckets
 *     are bounded above by `maxTime`, so a cached fetch for one window provably
 *     does NOT cover a later window, and the active bucket is a point-in-time
 *     snapshot. Its four bucket queries are cheap at daily volumes, so every
 *     ADO collection fetches fresh.
 *
 * Classification:
 *   - pr_merged            — PR.merged_at ∈ window
 *   - pr_closed            — PR.closed_at ∈ window AND not merged
 *   - pr_opened            — PR.created_at ∈ window
 *   - pr_awaiting_review   — PR is open AND updated_at ∈ window AND
 *                            requested_reviewers present (reviewers invited
 *                            but haven't dismissed/approved yet). Draft PRs
 *                            are excluded from this category — they don't
 *                            need review attention yet.
 *
 * A single PR can yield multiple items (e.g. opened AND merged in window).
 * The UI groups by `kind`.
 */

import {
	db,
	type GithubItem,
	getProjectReposForCodeSearch,
	type PriorityAction,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { isPrReviewStale } from "./detect-priority-actions";
import {
	ADO_PR_SCAN_TRUNCATED,
	fetchAdoPullRequests,
} from "./providers/azure-devops";
import { fetchGitLabMergeRequests } from "./providers/gitlab";
import { type RepoAuth, resolveRepoAuth } from "./resolve-repo-auth";

// =============================================================================
// Types
// =============================================================================

export interface CollectGitHubPullRequestsActivityInput {
	projectId: string;
	organizationId: string | null;
	/** Optional only for wire-compat with legacy in-flight payloads — see tenant guard. */
	userId?: string;
	timeWindowStart: Date | string;
	timeWindowEnd: Date | string;
	/**
	 * When `true`, each emitted item carries the PR author's numeric GitHub id
	 * (`authorGithubId`). Default OFF. ONLY the publishing-suggestion collector
	 * (`collect-pull-requests.ts`) sets this — it needs the id for PR-author
	 * attribution. The Daily Brief proxies this activity WITHOUT the flag, so the
	 * id is never emitted on the Daily Brief path and therefore never enters the
	 * Daily Brief LLM prompt, the persisted brief, or Daily Brief Temporal
	 * history (an activity-result boundary no post-hoc strip could reach).
	 */
	captureAuthorGithubId?: boolean;
}

export interface GitHubRepoFailure {
	repoFullName: string;
	reason: string;
}

export interface CollectGitHubPullRequestsActivityOutput {
	items: GithubItem[];
	failures: GitHubRepoFailure[];
	stalePrActions: PriorityAction[];
}

// =============================================================================
// Cache
// =============================================================================

interface CacheEntry {
	/**
	 * Raw PRs from the GitHub API, un-classified. We re-classify on each read
	 * using the caller's window — classifications like `pr_awaiting_review` are
	 * window-dependent and can't be cached safely across different windows.
	 */
	rawPrs: GitHubPullRequest[];
	/** The `updatedSince` lower bound used when the PRs were fetched. */
	fetchedFromUpdatedSince: Date;
	/** `Date.now() + TTL_MS` at the time of cache write. */
	expiresAt: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_PRS_PER_REPO = 100;
/**
 * Aggregate cap across ALL repos (Fizzy #1997).
 *
 * `MAX_PRS_PER_REPO` bounds one repo; nothing bounded the total, so a project
 * with many connected repos multiplied straight through — 20 repos near the
 * per-repo ceiling is ~1.6 MB of the `sections` aggregate that travels to the
 * summarizer in ONE gRPC message capped at 4 MiB. Mirrors the aggregate cap
 * the releases collector already applies (MAX_DEPLOYMENT_ITEMS).
 */
const MAX_PRS_TOTAL = 300;
const GITHUB_API_URL = "https://api.github.com";
const HEARTBEAT_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000; // per HTTP request — a stalled repo fails fast
// The workflow schedules this activity under a generic 2-minute collectTimeout;
// these soft bounds make the activity return PARTIAL data with per-repo failure
// entries instead of dying wholesale at the hard timeout (FR-10).
const PR_SOFT_BUDGET_MS = 90_000;
const PR_ACTIVITY_SOFT_DEADLINE_MS = 105_000; // ~15s under the 2-min hard timeout
const MIN_FETCH_MS = 500; // below this remaining margin, don't start a request
const PR_SCAN_INCOMPLETE =
	"PR fetch incomplete — too many pull requests or time budget exhausted; some activity may be missing";

/**
 * Module-level cache keyed by **integration id** (not repoFullName). Scoping
 * to the integration prevents a privacy leak: two projects that point at the
 * same repo have separate authorization, and a cached hit from project A
 * must never be served to project B whose token may be revoked or changed.
 *
 * Lost on worker restart — this is best-effort cost optimization, not a
 * correctness feature.
 */
const repoCache = new Map<string, CacheEntry>();

function readCache(
	integrationId: string,
	requestedWindowStart: Date,
): CacheEntry | null {
	const entry = repoCache.get(integrationId);
	if (!entry) {
		return null;
	}
	if (entry.expiresAt <= Date.now()) {
		repoCache.delete(integrationId);
		return null;
	}
	// Cache hit is only useful when the cached fetch window covers the current
	// request. If the caller now wants older PRs than we fetched, refetch.
	if (
		entry.fetchedFromUpdatedSince.getTime() > requestedWindowStart.getTime()
	) {
		return null;
	}
	return entry;
}

function writeCache(
	integrationId: string,
	rawPrs: GitHubPullRequest[],
	fetchedFromUpdatedSince: Date,
): void {
	repoCache.set(integrationId, {
		rawPrs,
		fetchedFromUpdatedSince,
		expiresAt: Date.now() + CACHE_TTL_MS,
	});
}

// =============================================================================
// GitHub API types (minimal — only fields we use)
// =============================================================================

interface GitHubUser {
	login: string;
	/**
	 * The numeric GitHub user id, present only when this `GitHubUser` came from
	 * the real GitHub API. The ADO and GitLab provider normalizers populate
	 * `login` from their own (non-GitHub) identity fields and never set `id` —
	 * fabricating one would wrongly imply a link to a GitHub account.
	 */
	id?: number;
}

export interface GitHubPullRequest {
	number: number;
	title: string;
	body: string | null;
	state: "open" | "closed";
	draft: boolean;
	html_url: string;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	merged_at: string | null;
	user: GitHubUser | null;
	requested_reviewers: GitHubUser[] | null;
	head: { ref: string } | null;
	base: { ref: string } | null;
}

/** Cap PR body length so persisted briefs don't bloat. */
const PR_BODY_CHAR_CAP = 500;

function truncateBody(body: string | null | undefined): string | undefined {
	if (!body) {
		return undefined;
	}
	const trimmed = body.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	return trimmed.length > PR_BODY_CHAR_CAP
		? `${trimmed.slice(0, PR_BODY_CHAR_CAP)}…`
		: trimmed;
}

// =============================================================================
// Activity
// =============================================================================

export async function collectGitHubPullRequestsActivity(
	input: CollectGitHubPullRequestsActivityInput,
): Promise<CollectGitHubPullRequestsActivityOutput> {
	const activityStartedAt = Date.now(); // BEFORE the first await — activity-deadline clock
	const { projectId, organizationId, captureAuthorGithubId } = input;
	const timeWindowStart = new Date(input.timeWindowStart);
	const timeWindowEnd = new Date(input.timeWindowEnd);

	heartbeat("collectGitHubPullRequestsActivity: starting");

	logger.info("[DailyBrief/collectGitHubPullRequests] Starting", {
		projectId,
		organizationId,
		timeWindowStart: timeWindowStart.toISOString(),
		timeWindowEnd: timeWindowEnd.toISOString(),
	});

	// Tenant belt-and-suspenders (FR-9) — same guard as collect-github-releases.ts:
	// this activity decrypts repo credentials outside request RLS, so re-assert the
	// project's XOR tenant tuple BEFORE any repo lookup. `userId` is optional only
	// for legacy in-flight payloads recorded before this field existed:
	//   - userId present  → full XOR check (org tuple; personal additionally binds user)
	//   - userId absent + org context      → org-only check (org binding still proven)
	//   - userId absent + personal context → FAIL CLOSED (org-only proves nothing personal)
	const { userId } = input;
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true, userId: true },
	});
	const inputOrg = organizationId ?? null;
	let tenantMatches: boolean;
	if (userId != null) {
		tenantMatches =
			project != null &&
			(project.organizationId ?? null) === inputOrg &&
			(inputOrg !== null || project.userId === userId);
	} else if (inputOrg !== null) {
		tenantMatches =
			project != null && (project.organizationId ?? null) === inputOrg;
		if (tenantMatches) {
			logger.warn(
				"[DailyBrief/collectGitHubPullRequests] Legacy payload without userId — org-only tenant check",
				{ projectId, organizationId },
			);
		}
	} else {
		tenantMatches = false;
		logger.warn(
			"[DailyBrief/collectGitHubPullRequests] Personal-context payload without userId — failing closed",
			{ projectId },
		);
	}
	if (!tenantMatches) {
		logger.warn(
			"[DailyBrief/collectGitHubPullRequests] Project/tenant mismatch — skipping",
			{
				projectId,
				organizationId,
				userId: userId ?? null,
				projectOrganizationId: project?.organizationId ?? null,
				projectUserId: project?.userId ?? null,
			},
		);
		return { items: [], failures: [], stalePrActions: [] };
	}

	const items: GithubItem[] = [];
	const failures: GitHubRepoFailure[] = [];
	const rawOpenPrs: Array<{ pr: GitHubPullRequest; repoFullName: string }> =
		[];

	// -------------------------------------------------------------------------
	// Load connected repos and resolve per-repo credentials. The resolve
	// pre-pass (sync) dispatches on provider/auth; unsupported combinations
	// become a per-repo failure here, so every remaining target is fetch-ready.
	// GitLab token NETWORK resolution stays inside the budgeted fetch step (the
	// resolver returns a refresh-aware `getToken` closure).
	// -------------------------------------------------------------------------
	const allRepos = await getProjectReposForCodeSearch(projectId);

	interface ResolvedPrTarget {
		integrationId: string;
		repoFullName: string;
		owner: string;
		repo: string;
		repositoryUrl: string;
		auth: Exclude<RepoAuth, { kind: "unsupported" }>;
	}
	const targets: ResolvedPrTarget[] = [];
	// Resolved concurrently: each repo's credential resolution may now hit the
	// network (GitHub refresh) and they are independent of one another — the
	// per-integration advisory lock inside the refresh keeps them safe.
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
			integrationId: repo.integrationId,
			repoFullName,
			owner: repo.owner,
			repo: repo.repo,
			repositoryUrl: repo.repositoryUrl,
			auth,
		});
	}

	if (targets.length === 0) {
		logger.info(
			"[DailyBrief/collectGitHubPullRequests] No active repo integrations",
			{ projectId },
		);
		return { items, failures, stalePrActions: [] };
	}

	// Post-setup budget clock: measured from after tenant guard + repo load so
	// setup time is also charged against the activity deadline (activityStartedAt),
	// but the soft per-repo-scan budget starts fresh here.
	const startedAt = Date.now();
	const remainingMs = () =>
		Math.min(
			PR_SOFT_BUDGET_MS - (Date.now() - startedAt),
			PR_ACTIVITY_SOFT_DEADLINE_MS - (Date.now() - activityStartedAt),
		);

	for (let i = 0; i < targets.length; i++) {
		const target = targets[i];
		if (remainingMs() <= 0) {
			for (let j = i; j < targets.length; j++) {
				failures.push({
					repoFullName: targets[j].repoFullName,
					reason: "Skipped — pull request fetch time budget exceeded for this brief",
				});
			}
			break;
		}
		const repoFullName = target.repoFullName;

		// Heartbeat before each repo's work so Temporal sees liveness between
		// per-repo network operations.
		heartbeat(`collectGitHubPullRequestsActivity: repo=${repoFullName}`);

		try {
			let rawPrs: GitHubPullRequest[];
			if (target.auth.kind === "ado") {
				// NO cache for ADO: its closed/created buckets are bounded above by
				// maxTime, so a cached fetch for one window provably does not cover a
				// later window, and the active bucket is a point-in-time snapshot.
				const { prs, truncated } = await fetchAdoPullRequests({
					auth: target.auth,
					repo: target.repo,
					repositoryUrl: target.repositoryUrl,
					windowStart: timeWindowStart,
					windowEnd: timeWindowEnd,
					remainingMs,
				});
				if (truncated) {
					failures.push({
						repoFullName,
						reason: ADO_PR_SCAN_TRUNCATED,
					});
				}
				rawPrs = prs;
			} else {
				// GitHub + GitLab: integration-keyed cache. Both fetch "everything
				// updated since the window start, unbounded above", honoring the
				// cache's superset-coverage contract.
				const cached = readCache(target.integrationId, timeWindowStart);
				if (cached) {
					rawPrs = cached.rawPrs;
					logger.debug(
						"[DailyBrief/collectGitHubPullRequests] Cache hit",
						{
							repoFullName,
							integrationId: target.integrationId,
							cachedRawCount: cached.rawPrs.length,
						},
					);
				} else {
					let truncated: boolean;
					if (target.auth.kind === "github") {
						({ prs: rawPrs, truncated } =
							await fetchPullRequestsForRepo({
								accessToken: target.auth.token,
								owner: target.owner,
								repo: target.repo,
								updatedSince: timeWindowStart,
								remainingMs,
							}));
					} else {
						const result = await fetchGitLabMergeRequests({
							getToken: target.auth.getToken,
							owner: target.owner,
							repo: target.repo,
							updatedSince: timeWindowStart,
							remainingMs,
						});
						rawPrs = result.mrs;
						truncated = result.truncated;
					}
					if (truncated) {
						// FR-10: observable partial data (budget OR cap cut) + NO
						// cache write — a truncated set cannot honor the cache's
						// superset-coverage contract.
						failures.push({
							repoFullName,
							reason: PR_SCAN_INCOMPLETE,
						});
					} else {
						writeCache(
							target.integrationId,
							rawPrs,
							timeWindowStart,
						);
					}
				}
			}

			const classified = classifyPullRequests({
				prs: rawPrs,
				repoFullName,
				timeWindowStart,
				timeWindowEnd,
				captureAuthorGithubId,
			});

			items.push(...classified);

			// Collect open PRs for stale detection (done after all repos processed).
			for (const pr of rawPrs) {
				if (pr.state === "open") {
					rawOpenPrs.push({ pr, repoFullName });
				}
			}
		} catch (err) {
			const reason = errorMessage(err);
			logger.warn(
				"[DailyBrief/collectGitHubPullRequests] Repo fetch failed",
				{ repoFullName, reason },
			);
			failures.push({ repoFullName, reason });
		}
	}

	// -------------------------------------------------------------------------
	// Stale-PR detection — walk all open PRs collected across all repos and
	// emit one PriorityAction per PR that hasn't been updated within the
	// review threshold. Runs after per-repo work so a single final loop
	// suffices (Strategy A). Never throws — if rawOpenPrs is empty we just
	// emit an empty array.
	// -------------------------------------------------------------------------
	const now = new Date();
	const stalePrActions: PriorityAction[] = [];
	for (const { pr, repoFullName } of rawOpenPrs) {
		if (
			!isPrReviewStale({
				state: "open",
				updatedAt: new Date(pr.updated_at),
				now,
			})
		) {
			continue;
		}
		stalePrActions.push({
			kind: "pr_review_stale",
			title: pr.title,
			whyItMatters: "",
			targetCuid: `github-pr-${repoFullName}-${pr.number}`,
			targetIdentifier: `PR #${pr.number}`,
			targetType: "document",
			fabricLink: pr.html_url,
		});
	}

	// Keep the most recent activity across every repo, then bound the total.
	// Sorting first means the cap drops the oldest PRs rather than whichever
	// repo happened to be processed last.
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
	const cappedItems =
		items.length > MAX_PRS_TOTAL ? items.slice(0, MAX_PRS_TOTAL) : items;

	logger.info("[DailyBrief/collectGitHubPullRequests] Complete", {
		projectId,
		repoCount: targets.length,
		itemCount: cappedItems.length,
		droppedOverAggregateCap: items.length - cappedItems.length,
		failureCount: failures.length,
		stalePrCount: stalePrActions.length,
	});

	return { items: cappedItems, failures, stalePrActions };
}

// =============================================================================
// GitHub API — paginated PR fetch
// =============================================================================

interface FetchPullRequestsArgs {
	accessToken: string;
	owner: string;
	repo: string;
	updatedSince: Date;
	remainingMs: () => number;
}

/**
 * Fetch up to `MAX_PRS_PER_REPO` most-recently-updated PRs for a repo.
 *
 * We use `pulls.list` with `state=all` and `sort=updated` (desc). GitHub does
 * not support server-side `since` on this endpoint, so we page in descending
 * `updated_at` order and stop when we cross `updatedSince` — that bounds the
 * number of API calls on active repos while still respecting the cap.
 *
 * Returns `{ prs, truncated }` where `truncated: true` means the scan is
 * incomplete and the result MUST NOT be cached (FR-10). `truncated` is only
 * false when one of the three PROVEN-complete exits fires:
 *   1. Empty page (no more PRs)
 *   2. Window short-circuit (last PR older than updatedSince)
 *   3. Short page (< PER_PAGE items, list exhausted)
 * Budget break or cap-without-window-proof are NOT proven complete → truncated.
 *
 * Heartbeats are emitted at most once per `HEARTBEAT_INTERVAL_MS` during
 * pagination.
 */
async function fetchPullRequestsForRepo(
	args: FetchPullRequestsArgs,
): Promise<{ prs: GitHubPullRequest[]; truncated: boolean }> {
	const { accessToken, owner, repo, updatedSince, remainingMs } = args;
	const PER_PAGE = 50;
	const MAX_PAGES = Math.ceil(MAX_PRS_PER_REPO / PER_PAGE);

	const collected: GitHubPullRequest[] = [];
	let lastHeartbeat = Date.now();
	// Only the three proven-complete exits set this to true.
	let complete = false;

	for (let page = 1; page <= MAX_PAGES; page++) {
		if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
			heartbeat(
				`fetchPullRequestsForRepo: ${owner}/${repo} page=${page}`,
			);
			lastHeartbeat = Date.now();
		}

		// NEVER start a request after the budget is exhausted (FR-10).
		const remaining = remainingMs();
		if (remaining < MIN_FETCH_MS) {
			break; // complete stays false → truncated
		}
		const perCall = Math.min(REQUEST_TIMEOUT_MS, remaining);

		const url = new URL(`${GITHUB_API_URL}/repos/${owner}/${repo}/pulls`);
		url.searchParams.set("state", "all");
		url.searchParams.set("sort", "updated");
		url.searchParams.set("direction", "desc");
		url.searchParams.set("per_page", String(PER_PAGE));
		url.searchParams.set("page", String(page));

		const response = await fetch(url.toString(), {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/vnd.github.v3+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "Fabric-DailyBrief",
			},
			signal: AbortSignal.timeout(perCall),
		});

		if (!response.ok) {
			// Surface status + body so the caller's `failures[]` entry is
			// actionable (e.g. "401 Bad credentials", "404 Not Found").
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

		const page_prs = (await response.json()) as GitHubPullRequest[];
		if (page_prs.length === 0) {
			complete = true; // proven: no more PRs
			break;
		}

		collected.push(...page_prs);

		// Short-circuit: because results are sorted by updated_at desc, if the
		// last PR on the page is older than our window start, no subsequent
		// page can contain in-window PRs.
		const last = page_prs[page_prs.length - 1];
		if (
			last &&
			new Date(last.updated_at).getTime() < updatedSince.getTime()
		) {
			complete = true; // proven: window provably exhausted
			break;
		}

		if (page_prs.length < PER_PAGE) {
			complete = true; // proven: list exhausted (short page)
			break;
		}

		if (collected.length >= MAX_PRS_PER_REPO) {
			break; // cap WITHOUT window proof → complete stays false → truncated
		}
	}

	return { prs: collected.slice(0, MAX_PRS_PER_REPO), truncated: !complete };
}

// =============================================================================
// Classification
// =============================================================================

interface ClassifyArgs {
	prs: GitHubPullRequest[];
	repoFullName: string;
	timeWindowStart: Date;
	timeWindowEnd: Date;
	/**
	 * When `true`, capture the PR author's numeric GitHub id onto each item as
	 * `authorGithubId`. Default OFF — the Daily Brief path never sets it, so the
	 * id is never emitted there. Only the publishing collector opts in.
	 */
	captureAuthorGithubId?: boolean;
}

export function classifyPullRequests(args: ClassifyArgs): GithubItem[] {
	const {
		prs,
		repoFullName,
		timeWindowStart,
		timeWindowEnd,
		captureAuthorGithubId,
	} = args;

	const items: GithubItem[] = [];

	for (const pr of prs) {
		const createdAt = new Date(pr.created_at);
		const updatedAt = new Date(pr.updated_at);
		const closedAt = pr.closed_at ? new Date(pr.closed_at) : null;
		const mergedAt = pr.merged_at ? new Date(pr.merged_at) : null;

		const state: "open" | "closed" | "merged" = mergedAt
			? "merged"
			: pr.state;

		const truncatedBody = truncateBody(pr.body);
		const base = {
			title: pr.title,
			prNumber: pr.number,
			repoFullName,
			url: pr.html_url,
			author: pr.user?.login,
			// authorGithubId is captured ONLY when the caller opts in (publishing
			// path). Default OFF keeps a real person's numeric id off the Daily
			// Brief pipeline entirely (prompt, persisted brief, Temporal history).
			...(captureAuthorGithubId && pr.user?.id != null
				? { authorGithubId: String(pr.user.id) }
				: {}),
			state,
			baseRef: pr.base?.ref,
			...(truncatedBody ? { body: truncatedBody } : {}),
		} as const;

		// pr_merged — highest-signal event, emit even if PR was also
		// opened-in-window (the UI groups by kind).
		if (
			mergedAt &&
			isWithinWindow(mergedAt, timeWindowStart, timeWindowEnd)
		) {
			items.push({
				...base,
				kind: "pr_merged",
				occurredAt: mergedAt,
			});
		}

		// pr_closed — only for closes-without-merge. If merged_at is set,
		// GitHub also sets closed_at to the same timestamp, and we don't
		// want to double-emit.
		if (
			!mergedAt &&
			closedAt &&
			isWithinWindow(closedAt, timeWindowStart, timeWindowEnd)
		) {
			items.push({
				...base,
				kind: "pr_closed",
				occurredAt: closedAt,
			});
		}

		// pr_opened
		if (isWithinWindow(createdAt, timeWindowStart, timeWindowEnd)) {
			items.push({
				...base,
				kind: "pr_opened",
				occurredAt: createdAt,
			});
		}

		// pr_awaiting_review — open, updated-in-window, non-draft, reviewers
		// requested (and still pending).
		const isAwaitingReview =
			pr.state === "open" &&
			!pr.draft &&
			isWithinWindow(updatedAt, timeWindowStart, timeWindowEnd) &&
			Array.isArray(pr.requested_reviewers) &&
			pr.requested_reviewers.length > 0;

		if (isAwaitingReview) {
			items.push({
				...base,
				kind: "pr_awaiting_review",
				occurredAt: updatedAt,
			});
		}
	}

	return items;
}

// =============================================================================
// Helpers
// =============================================================================

function isWithinWindow(at: Date, start: Date, end: Date): boolean {
	const t = at.getTime();
	return t >= start.getTime() && t <= end.getTime();
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
