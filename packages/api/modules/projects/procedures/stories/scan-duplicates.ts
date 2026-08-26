import { ORPCError } from "@orpc/client";
import {
	countItemsWithPendingDuplicateLinks,
	hasProjectAccess,
	setProjectLastDuplicateScanAt,
} from "@repo/database";
import {
	EmbeddingUnavailableError,
	runDuplicateScanCore,
} from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Manual roadmap duplicate scan. The whole detection pipeline — embedding
 * cache, cosine candidate selection, 3-way LLM verifier (duplicate /
 * overlapping scope / distinct), verdict persistence — lives in the shared
 * [`runDuplicateScanCore`](../../../../../temporal/src/lib/duplicate-scan-core.ts);
 * this procedure adds only the interactive contract:
 *   - tenant auth (STORY_UPDATE + project access);
 *   - `selection: all-pairs` — the manual scan is the surface responsible for
 *     pairs between pre-existing items. Verification is driven by the pair
 *     VERDICT cache (pairs lacking a stored verdict at the current content
 *     hashes are verified), not by embedding staleness — so a
 *     DETECTION_VERSION bump reliably re-examines the whole backlog even if a
 *     background auto-detect run already re-warmed the embedding cache;
 *   - SIMPLE verifier tier (reliable in the Vercel runtime, user-initiated);
 *   - embedding failures surface as an actionable settings hint;
 *   - `verifierFailures` is passed through so the completion modal can tell a
 *     genuinely clean scan apart from one that couldn't verify (a transient AI
 *     outage): the core returns "0 confirmed" for BOTH, and this path does not
 *     throw on a wholesale verifier failure (unlike the Temporal path), so
 *     without this count a failed scan is indistinguishable from a clean one;
 *   - scan-time stamping + the flagged-items count for the completion modal.
 */
export const scanDuplicatesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/scan-duplicates",
		tags: ["Projects", "Stories"],
		summary: "Scan for duplicate stories",
		description:
			"Run semantic duplicate detection over the project's active features/stories (embedding similarity + 3-way LLM verification) and upsert confirmed pairs as pending duplicate/overlap links. Incremental: stories are re-embedded only when their detection text or embedding model changed, and each candidate pair is LLM-verified at most once per content change (verdicts are cached).",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId ?? undefined,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		let result: Awaited<ReturnType<typeof runDuplicateScanCore>>;
		try {
			result = await runDuplicateScanCore({
				projectId: input.projectId,
				userId: user.id,
				organizationId,
				selection: { mode: "all-pairs" },
				aiTaskType: "SIMPLE",
				logPrefix: "[Duplicate Scan]",
				throwOnWholesaleVerifierFailure: false,
			});
		} catch (err) {
			if (err instanceof EmbeddingUnavailableError) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message:
						"Could not generate embeddings. Ensure an embedding model is configured in Settings → AI Models.",
				});
			}
			throw err;
		}

		// Stamp the scan time and report the CURRENT flagged state — the count
		// of distinct active stories in a PENDING link (the roadmap "Possible
		// duplicates" filter's set) — so the completion modal matches the
		// filter even on a re-scan that confirms nothing new.
		await setProjectLastDuplicateScanAt(input.projectId, new Date());
		const flaggedItems = await countItemsWithPendingDuplicateLinks(
			input.projectId,
		);

		return {
			scanned: result.scanned,
			candidates: result.candidates,
			confirmed: result.confirmed,
			truncated: result.truncated,
			// Verifier calls that errored this run (their pairs stay unverified
			// and are retried on the next scan). > 0 lets the modal warn that the
			// result is incomplete; == candidates means nothing could be checked.
			verifierFailures: result.verifierFailures,
			flaggedItems,
		};
	});
