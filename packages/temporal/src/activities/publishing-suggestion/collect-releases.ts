/**
 * Publishing Suggestion — Release Collector Activity
 *
 * Releases live in GitHub/GitLab/Azure DevOps, not local tables — same
 * rationale as `collect-pull-requests.ts`. Composes the already-hardened
 * `collectGitHubReleasesActivity` (plain function call, not a second proxied
 * Temporal activity) rather than re-implementing the multi-provider fetch +
 * tenant guard, and layers the publishing-suggestion shape on top:
 * `PER_SOURCE_CAP` row slicing, `qualifyingCount` (distinct releases),
 * `newestQualifyingIso` (F7 freshness), and byte-bounding (H3).
 *
 * `userId` is REQUIRED by `collect-github-releases.ts`'s tenant guard (no
 * optional/legacy path there, unlike PRs) — a null `userId` can never prove
 * tenant ownership, so this wrapper fails closed BEFORE calling the wrapped
 * activity in that case. Any other tenant mismatch is caught by the wrapped
 * activity's own guard, verbatim (not reimplemented here).
 *
 * NOTE for Task 9 (workflow wiring): `collectGitHubReleasesActivity`'s own
 * internal soft deadline is ~165s (`ACTIVITY_SOFT_DEADLINE_MS`) — this
 * EXCEEDS a 2-minute `startToCloseTimeout`. Give `collectReleases` at least a
 * 3-minute `startToCloseTimeout`, mirroring the daily brief workflow's own
 * timeout for this activity (see `daily-brief-generation-workflow.ts`), NOT
 * the uniform "short" 2-minute group used by the other four collectors.
 */

import { PER_SOURCE_CAP } from "@repo/database";
import { Context } from "@temporalio/activity";
import { collectGitHubReleasesActivity } from "../daily-brief/collect-github-releases";
import { byteBoundItems } from "./lib/byte-bound";

// F6: bound the `failures[]` envelope before returning. `items` is already row-
// and byte-bounded (H3/PER_SOURCE_CAP), but `failures` was returned UNCHANGED —
// one failure entry per repo, with a provider-supplied (unbounded) `reason`
// string, and integrations loaded uncapped. A mass provider outage (e.g. every
// repo's token expired) can still push the activity return past Temporal's
// ~4MB gRPC limit despite the item bound (the #1741/#1750 payload-size failure
// class). Mirrors the item cap: truncate the array, cap each reason string.
export const RELEASE_MAX_FAILURES = 100;
export const RELEASE_MAX_FAILURE_REASON_CHARS = 500;

export interface CollectReleasesInput {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	windowStart: string;
	windowEnd: string;
}

export interface CollectReleasesOutput {
	items: unknown[];
	count: number;
	qualifyingCount: number;
	newestQualifyingIso: string | null;
	capExhausted: boolean;
	failures: { repoFullName: string; reason: string }[];
}

export async function collectReleases(
	input: CollectReleasesInput,
): Promise<CollectReleasesOutput> {
	Context.current().heartbeat();
	const { projectId, organizationId, userId, windowStart, windowEnd } = input;

	// userId is REQUIRED by collect-github-releases.ts's guard — a null userId can
	// never prove tenant ownership, so fail closed here without calling through.
	if (userId == null) {
		return {
			items: [],
			count: 0,
			qualifyingCount: 0,
			newestQualifyingIso: null,
			capExhausted: false,
			failures: [],
		};
	}

	const result = await collectGitHubReleasesActivity({
		projectId,
		organizationId,
		userId,
		timeWindowStart: windowStart,
		timeWindowEnd: windowEnd,
	});

	const capExhaustedByCount = result.items.length > PER_SOURCE_CAP;
	const items = capExhaustedByCount
		? result.items.slice(0, PER_SOURCE_CAP)
		: result.items;

	// qualifyingCount: distinct releases. The underlying collector already emits one
	// item per release; dedupe defensively by (repoFullName, tagName).
	const qualifyingCount = new Set(
		items.map((i) => `${i.repoFullName}#${i.tagName}`),
	).size;

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
	const failuresCapExhausted = result.failures.length > RELEASE_MAX_FAILURES;
	const boundedFailures = result.failures
		.slice(0, RELEASE_MAX_FAILURES)
		.map((f) => ({
			...f,
			reason: (f.reason ?? "").slice(0, RELEASE_MAX_FAILURE_REASON_CHARS),
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
