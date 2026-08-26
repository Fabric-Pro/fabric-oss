/**
 * Publishing Suggestion — Pull Request Collector Activity
 *
 * PRs live in GitHub/GitLab/Azure DevOps, not local tables (same H2 finding
 * that motivates the `countNewContextSince` external-repo-integration
 * fallback in Task 4) — this collector genuinely needs a live provider fetch.
 *
 * Rather than re-implementing the daily-brief's multi-provider fetch,
 * pagination, per-repo credential resolution, and tenant XOR guard (~700
 * lines across `collect-github-pull-requests.ts` + `providers/*`), this
 * collector COMPOSES the already-hardened `collectGitHubPullRequestsActivity`
 * — a plain function call, not a second proxied Temporal activity — and
 * layers the publishing-suggestion shape on top: `PER_SOURCE_CAP` row
 * slicing, `qualifyingCount` (distinct `(repoFullName, prNumber)` tuples —
 * the underlying collector emits multiple lifecycle events per PR),
 * `newestQualifyingIso` (F7 freshness), and byte-bounding (H3).
 *
 * The `userId` XOR fail-closed tenant guard is therefore the EXACT code in
 * `collect-github-pull-requests.ts` (not a copy that can drift) — calling
 * through preserves it verbatim. On any tenant mismatch the wrapped call
 * degrades to `{ items: [], failures: [] }`, which this wrapper maps to
 * `{ items: [], failures: [], qualifyingCount: 0, capExhausted: false }`,
 * matching the spec's guard-failure shape.
 *
 * NOTE for Task 9 (workflow wiring): `collectGitHubPullRequestsActivity`'s
 * own internal soft deadline is ~105s (`PR_ACTIVITY_SOFT_DEADLINE_MS`),
 * comfortably inside a 2-minute `startToCloseTimeout` — mirror the daily
 * brief workflow's own "2 minutes" budget for this activity (see
 * `daily-brief-generation-workflow.ts`).
 */

import { PER_SOURCE_CAP } from "@repo/database";
import { Context } from "@temporalio/activity";
import { collectGitHubPullRequestsActivity } from "../daily-brief/collect-github-pull-requests";
import { byteBoundItems } from "./lib/byte-bound";

// F6: bound the `failures[]` envelope before returning. `items` is already row-
// and byte-bounded (H3/PER_SOURCE_CAP), but `failures` was returned UNCHANGED —
// one failure entry per repo, with a provider-supplied (unbounded) `reason`
// string, and integrations loaded uncapped. A mass provider outage (e.g. every
// repo's token expired) can still push the activity return past Temporal's
// ~4MB gRPC limit despite the item bound (the #1741/#1750 payload-size failure
// class). Mirrors the item cap: truncate the array, cap each reason string.
export const PR_MAX_FAILURES = 100;
export const PR_MAX_FAILURE_REASON_CHARS = 500;

export interface CollectPullRequestsInput {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	windowStart: string;
	windowEnd: string;
}

export interface CollectPullRequestsOutput {
	items: unknown[];
	count: number;
	qualifyingCount: number;
	newestQualifyingIso: string | null;
	capExhausted: boolean;
	failures: { repoFullName: string; reason: string }[];
}

export async function collectPullRequests(
	input: CollectPullRequestsInput,
): Promise<CollectPullRequestsOutput> {
	Context.current().heartbeat();
	const { projectId, organizationId, userId, windowStart, windowEnd } = input;

	// userId XOR fail-closed guard — delegated to collectGitHubPullRequestsActivity's
	// own tenant belt-and-suspenders check (verbatim; not reimplemented here). A
	// null userId maps to `undefined`, which that guard already treats as a
	// legacy/fail-closed case depending on org context.
	const result = await collectGitHubPullRequestsActivity({
		projectId,
		organizationId,
		userId: userId ?? undefined,
		timeWindowStart: windowStart,
		timeWindowEnd: windowEnd,
		// Publishing is the ONLY path that needs the PR author's numeric GitHub id
		// (for the PR-author attribution resolver). Opt in here; the Daily Brief
		// proxy call omits this flag, so the id never enters the Daily Brief prompt,
		// persisted brief, or Daily Brief Temporal history.
		captureAuthorGithubId: true,
	});

	const capExhaustedByCount = result.items.length > PER_SOURCE_CAP;
	const items = capExhaustedByCount
		? result.items.slice(0, PER_SOURCE_CAP)
		: result.items;

	// qualifyingCount (P7): distinct (repoFullName, prNumber) tuples — a single PR
	// can emit multiple lifecycle items (e.g. opened AND merged in the same window).
	const qualifyingCount = new Set(
		items.map((i) => `${i.repoFullName}#${i.prNumber}`),
	).size;

	// newestQualifyingIso (F7): every returned item IS a qualifying lifecycle event
	// that occurred in-window (pr_opened/pr_merged/pr_closed/pr_awaiting_review), so
	// the max occurredAt over the (capped) item set is the freshness signal.
	const newestQualifyingIso =
		items.length > 0
			? new Date(
					Math.max(
						...items.map((i) => new Date(i.occurredAt).getTime()),
					),
				).toISOString()
			: null;

	// H3: byte-bound the returned `items` before returning. A byte-trim is source
	// INCOMPLETENESS — OR it into `capExhausted`.
	const { items: bounded, trimmed } = byteBoundItems(items);

	// F6: bound the `failures[]` envelope. A truncated failure list is itself
	// source INCOMPLETENESS (the source didn't fully report) — OR it into
	// `capExhausted` too.
	const failuresCapExhausted = result.failures.length > PR_MAX_FAILURES;
	const boundedFailures = result.failures
		.slice(0, PR_MAX_FAILURES)
		.map((f) => ({
			...f,
			reason: (f.reason ?? "").slice(0, PR_MAX_FAILURE_REASON_CHARS),
		}));

	return {
		items: bounded,
		count: bounded.length,
		qualifyingCount,
		newestQualifyingIso,
		capExhausted: capExhaustedByCount || trimmed || failuresCapExhausted,
		failures: boundedFailures,
	};
}
