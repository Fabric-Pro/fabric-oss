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

// The collector's item cap: it kept the NEWEST releases and dropped older ones.
// Retrying cannot clear it — the skip keeps `lastSentAt`, so the next window
// only grows — so treating it as incomplete stops the newsletter for good once a
// backlog exceeds the cap. With `capTruncationSends`, the newest set is sent.
const CAP_TRUNCATION = /^Deployments list truncated to \d+ most recent/;

const occurredMs = (d: Date | string): number =>
	d instanceof Date ? d.getTime() : new Date(d).getTime();

export interface NewsletterScanFailure {
	repoFullName: string;
	reason: string;
}

export interface SelectNewsletterReleasesInput {
	items: DeploymentItem[];
	failures: NewsletterScanFailure[];
}

/**
 * Filters collector output to newsletter-eligible production releases.
 *  - production-tag predicate (v*, no prerelease),
 *  - START-EXCLUSIVE window (published_at > windowStart), and
 *  - `incomplete` = true iff a COMPLETENESS-AFFECTING failure occurred (any
 *    failure except the benign latest-phase / body-omission ones). The caller
 *    SKIPS the send on incomplete — it must not email a partial set.
 *    `incompleteFailures` lists exactly those failures, so the skip can record
 *    why (`formatIncompleteScanReason`).
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
	options: { capTruncationSends?: boolean } = {},
): {
	releases: DeploymentItem[];
	incomplete: boolean;
	incompleteFailures: NewsletterScanFailure[];
} {
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
	const incompleteFailures = input.failures.filter(
		(f) =>
			!BENIGN_FAILURE.test(f.reason) &&
			!(options.capTruncationSends && CAP_TRUNCATION.test(f.reason)),
	);
	return {
		releases,
		incomplete: incompleteFailures.length > 0,
		incompleteFailures,
	};
}

const MAX_LISTED_REPOS = 5;
const MAX_LINE_CHARS = 200;

function truncateLine(line: string): string {
	return line.length > MAX_LINE_CHARS
		? `${line.slice(0, MAX_LINE_CHARS - 1)}…`
		: line;
}

/**
 * The reason an incomplete-scan send records: one line per repository, e.g.
 * `example-org/example-repo: GitHub API error: Not Found`. Section-level notes
 * (`repoFullName === "*"`) carry no repository prefix. At most
 * MAX_LISTED_REPOS lines of MAX_LINE_CHARS each, then an "and N more" line, so
 * the stored text stays short however many repositories failed. Null when
 * there is nothing to report.
 *
 * The reasons are the collector's own failure strings — the same text the
 * daily brief already shows as `deploymentsError`.
 */
export function formatIncompleteScanReason(
	failures: NewsletterScanFailure[],
): string | null {
	const reasonsByRepo = new Map<string, string[]>();
	for (const { repoFullName, reason } of failures) {
		const reasons = reasonsByRepo.get(repoFullName);
		if (!reasons) {
			reasonsByRepo.set(repoFullName, [reason]);
		} else if (!reasons.includes(reason)) {
			reasons.push(reason);
		}
	}
	if (reasonsByRepo.size === 0) {
		return null;
	}
	const lines = [...reasonsByRepo].map(([repoFullName, reasons]) =>
		truncateLine(
			repoFullName === "*"
				? reasons.join("; ")
				: `${repoFullName}: ${reasons.join("; ")}`,
		),
	);
	const listed = lines.slice(0, MAX_LISTED_REPOS);
	const more = lines.length - listed.length;
	if (more > 0) {
		listed.push(
			`and ${more} more ${more === 1 ? "repository" : "repositories"}`,
		);
	}
	return listed.join("\n");
}
