/**
 * Automatic semantic duplicate detection for newly-created stories.
 *
 * This is the AI-write counterpart to the manual roadmap scan
 * (`scan-duplicates.ts` in @repo/api). When the AI backlog-update flow or a
 * channel proposal-approval creates new backlog items, this checks each new
 * item against the rest of the active backlog (one-vs-rest) and flags
 * duplicates and overlapping-scope pairs as PENDING `StoryDuplicateLink`s —
 * exactly the records the roadmap chip + Merge/Dismiss dialog already consume.
 *
 * This is the implementation behind the `detectDuplicateStoriesActivity`
 * Temporal activity, which is run by the fire-and-forget `detectDuplicates`
 * workflow (started via `triggerDuplicateDetection`). Running it as a retried
 * Temporal activity — rather than inline in the create request — is what makes
 * it resilient to transient embedding/LLM rate-limit errors under burst load.
 *
 * The whole pipeline (embedding-cache reuse, candidate selection, 3-way
 * verifier, verdict persistence) lives in the shared
 * [`runDuplicateScanCore`](./duplicate-scan-core.ts); this wrapper adds only
 * the activity's contract:
 *   - `selection: targets` — one-vs-rest on the just-created ids; pairs
 *     between pre-existing items are the manual scan's responsibility, and
 *     re-flagging them on every AI write would be noise;
 *   - COMPLEX verifier tier — in the worker runtime the SIMPLE-tier model
 *     does not reliably satisfy a `generateObject` structured-output schema;
 *   - THROWS on transient/unexpected failure (embedding, model, DB) and on a
 *     wholesale verifier outage, so the Temporal activity FAILS and is
 *     retried with backoff instead of returning a misleading "0 duplicates"
 *     success. A single flaky pair is still skipped (not fatal) inside the
 *     core.
 */

import { runDuplicateScanCore } from "./duplicate-scan-core";

export type DetectDuplicateStoriesParams = {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	/** IDs of the just-created stories to check against the existing backlog. */
	targetStoryIds: string[];
};

export type DetectDuplicateStoriesResult = {
	/** Stories with usable (non-blank) text that participated in the scan. */
	scanned: number;
	/** Candidate pairs (involving a target) that cleared the cosine pre-filter. */
	candidates: number;
	/** Pairs the LLM confirmed and that were upserted as PENDING links. */
	confirmed: number;
	/** Candidate pairs dropped by the per-run cap (never silently swallowed). */
	truncated: number;
};

/**
 * Check `targetStoryIds` against the project's active backlog and flag
 * duplicate/overlap pairs as PENDING links. Returns a summary on success;
 * THROWS on a transient/unexpected failure so the wrapping Temporal activity
 * retries.
 */
export async function detectAndFlagDuplicateStories(
	params: DetectDuplicateStoriesParams,
): Promise<DetectDuplicateStoriesResult> {
	const uniqueTargetIds = new Set(params.targetStoryIds);
	if (uniqueTargetIds.size === 0) {
		return { scanned: 0, candidates: 0, confirmed: 0, truncated: 0 };
	}

	const result = await runDuplicateScanCore({
		projectId: params.projectId,
		userId: params.userId,
		organizationId: params.organizationId,
		selection: { mode: "targets", targetIds: uniqueTargetIds },
		aiTaskType: "COMPLEX",
		logPrefix: "[Auto Dup Detect]",
		throwOnWholesaleVerifierFailure: true,
	});

	return {
		scanned: result.scanned,
		candidates: result.candidates,
		confirmed: result.confirmed,
		truncated: result.truncated,
	};
}
