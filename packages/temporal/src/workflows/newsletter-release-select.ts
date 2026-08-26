import type { DeploymentItem } from "@repo/database";

/**
 * Workflow-safe (type-only import) production-release selection. Mirrors the role
 * splitReleasePrs played for the PR path.
 *
 * Production-tag predicate: a leading `v` + dotted version, NO prerelease (`-`)
 * or build (`+`) suffix. Excludes manual/staging/internal tags across ALL
 * providers — critically ADO annotated tags, which have no draft/prerelease flag
 * for the collector to filter, so this regex is the only prerelease
 * gate for non-GitHub providers.
 *
 * IMPORTANT: do NOT import RELEASE_NOTES_OMITTED_NOTICE (or anything else) from
 * collect-github-releases.ts here — that module imports @repo/database at RUNTIME
 * and would break the workflow sandbox bundle. Omitted-notice stripping lives in
 * the curate ACTIVITY.
 */
export const PRODUCTION_TAG_PATTERN = /^v\d+(?:\.\d+)*$/;

// Collector failures that do NOT imply a dropped in-window LIST item. These must
// NOT mark the scan incomplete (else a benign sibling-repo/latest-phase failure
// would pin lastSentAt forever and re-email the same releases). Couples to the
// collector's failure-reason strings (collect-github-releases.ts) — pinned by test.
const BENIGN_FAILURE =
	/^latest:|latest-release lookups|release-note (?:body|bodies) omitted/i;

const occurredMs = (d: Date | string): number =>
	d instanceof Date ? d.getTime() : new Date(d).getTime();

export interface SelectNewsletterReleasesInput {
	items: DeploymentItem[];
	failures: { repoFullName: string; reason: string }[];
}

/**
 * Filters collector output to newsletter-eligible production releases.
 *  - production-tag predicate (v*, no prerelease),
 *  - START-EXCLUSIVE window (published_at > windowStart), and
 *  - `incomplete` = true iff a COMPLETENESS-AFFECTING failure occurred (any
 *    failure except the benign latest-phase / body-omission ones). The caller
 *    SKIPS the send on incomplete — it must not email a partial set.
 *
 * NOTE on the window: when lookbackDays is set,
 * resolveWindow's start = (now - N days), which is LATER than lastSentAt, so the
 * start-exclusive filter is redundant-but-safe there (the cursor moving forward
 * is the real boundary protection). On the null-lookback (incremental) path,
 * start = lastSentAt exactly, and start-exclusive prevents the boundary
 * double-announce. It never includes LESS than the window — only excludes the
 * exact-start instant — so it is safe on both paths.
 */
export function selectNewsletterReleases(
	input: SelectNewsletterReleasesInput,
	windowStartIso: string,
): { releases: DeploymentItem[]; incomplete: boolean } {
	const startMs = new Date(windowStartIso).getTime();
	const releases = input.items.filter((r) => {
		const ms = occurredMs(r.occurredAt);
		return (
			PRODUCTION_TAG_PATTERN.test(r.tagName) &&
			Number.isFinite(ms) &&
			ms > startMs
		);
	});
	// Any non-benign failure marks the scan incomplete → the caller SKIPS (no
	// email, no cursor advance). This INTENTIONALLY includes permanent config
	// failures (e.g. an `unsupported` repo-auth on a multi-repo project, or ADO
	// fail-closed): we fail loud (skip) rather than email a partial
	// set, so a misconfigured source surfaces as a persistent SKIPPED_EMPTY until
	// fixed instead of silently dropping that repo's releases. (Follow-up: have
	// the collector emit structured failure kinds so config-vs-completeness can be
	// distinguished without prose matching.)
	const incomplete = input.failures.some(
		(f) => !BENIGN_FAILURE.test(f.reason),
	);
	return { releases, incomplete };
}
