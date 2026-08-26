/**
 * Shared orchestration core for semantic duplicate detection.
 *
 * Both consumers run the same pipeline — load the active backlog, split it
 * against the shared `StoryDuplicateEmbedding` cache, embed only stale items,
 * cosine-select candidate pairs, LLM-verify each with the 3-way verdict
 * (duplicate / overlapping scope / distinct), and persist every completed
 * verdict — and differ only in thin wrapper concerns:
 *
 *   - the manual roadmap scan (`scan-duplicates.ts` in @repo/api):
 *     `selection: all-pairs`, SIMPLE tier, wraps embedding failures in an
 *     actionable ORPCError, adds scan-time + flagged-count bookkeeping;
 *   - the automatic per-create check (`detect-duplicate-stories.ts` here):
 *     `selection: targets` (one-vs-rest on the just-created ids), COMPLEX
 *     tier, throws on wholesale verifier failure so the Temporal activity
 *     retries.
 *
 * Lives in @repo/temporal because @repo/api already depends on @repo/temporal
 * (the approve-pending-proposal procedures import from here), while the
 * reverse would cycle.
 *
 * Incremental-cost model (deliberate, after the #2018 rework's review):
 *   - VERIFICATION is driven by the pair-verdict cache: a pair is verified
 *     when no stored verdict (positive or negative) matches both sides'
 *     current content hashes. Every completed verification persists a row —
 *     including low-confidence non-flags — so drain progress over a large
 *     candidate set is monotonic and each pair is paid for at most once per
 *     content change.
 *   - EMBEDDING staleness is a separate, per-item optimization: fresh vectors
 *     are persisted per item, EXCEPT items appearing in a pair that was
 *     dropped by the per-run cap or whose verifier call failed — those stay
 *     stale so the next run re-selects and retries exactly the unfinished
 *     pairs.
 *   - The two are independent on purpose: an auto-detect run warming the
 *     embedding cache for the whole backlog must NOT be able to skip the
 *     verification drain a DETECTION_VERSION bump exists to force (verdict
 *     rows are keyed on version-prefixed hashes, so a bump invalidates them
 *     all regardless of embedding-cache state).
 */

import {
	generateObject,
	getAIModelWithMetadata,
	resolveModelWithProvider,
} from "@repo/ai";
import {
	baseModelName,
	buildVerifierPrompt,
	type CandidateSelection,
	classifyVerdict,
	type DetectionItem,
	detectionTextForStory,
	hashDetectionText,
	listActiveStoriesForDetection,
	listDismissedDuplicatePairKeys,
	listStoryDuplicateEmbeddingMetadata,
	listStoryDuplicateEmbeddings,
	listVerdictValidPairKeys,
	MAX_LLM_VERIFICATIONS,
	normalizeVerifierRelationship,
	recordDistinctVerdict,
	selectCandidatePairs,
	selectCandidatePairsForTargets,
	upsertPendingDuplicateLink,
	upsertStoryDuplicateEmbeddings,
} from "@repo/database";
import { logger } from "@repo/logs";
import { generateEmbeddings } from "@repo/rag";
import { z } from "zod";

/** LLM verdict for a candidate pair. `relationship` is a plain string — never
 * an enum — so a slightly-off value can't fail the whole call;
 * `normalizeVerifierRelationship` maps it onto the 3-way verdict in code.
 * `reasoning` is purely informational (shown in the dup dialog) and is
 * therefore optional with a generous cap: a valid verdict must never be
 * discarded just because the model was verbose. (A tight `.max(400)` here
 * previously meant an over-long reasoning would fail the *whole*
 * `generateObject` schema with `NoObjectGeneratedError`.) */
const VerdictSchema = z.object({
	// Declared FIRST on purpose. Structured output is generated in field order,
	// so making the model write each item's own problem before it reaches
	// `relationship` forces it to ground the verdict in both items. Without
	// this it can assert a shared root cause it never derived from item A —
	// the exact failure behind an observed false positive (a tool-timeout bug
	// matched to an unrelated sync bug at 0.95 confidence, with reasoning that
	// only described the second item).
	problemA: z.string().max(500).optional(),
	problemB: z.string().max(500).optional(),
	relationship: z.string(),
	confidence: z.number().min(0).max(1),
	reasoning: z.string().max(2000).optional(),
});

/**
 * Embedding infrastructure was unavailable (model resolution or the embedding
 * call itself failed). Typed so the api wrapper can map exactly this class to
 * its actionable "configure an embedding model" ORPCError while letting other
 * errors (DB, logic) surface raw; the temporal wrapper lets it propagate so
 * the activity retries. The message mirrors the cause's so existing
 * retry-contract expectations keep matching on the original error text.
 */
export class EmbeddingUnavailableError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "EmbeddingUnavailableError";
		this.cause = cause;
	}
}

export type DuplicateScanSelection =
	| { mode: "all-pairs" }
	| { mode: "targets"; targetIds: Set<string> };

export interface DuplicateScanCoreParams {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	selection: DuplicateScanSelection;
	/** Verifier model tier. SIMPLE for the interactive Vercel-runtime scan;
	 * COMPLEX for the worker runtime, where SIMPLE-tier structured output is
	 * unreliable (returns NoObjectGeneratedError for every pair). */
	aiTaskType: "SIMPLE" | "COMPLEX";
	/** Log prefix, e.g. "[Duplicate Scan]" / "[Auto Dup Detect]". */
	logPrefix: string;
	/** Throw when EVERY candidate pair failed verification (a wholesale
	 * verifier outage) instead of returning a misleading "0 confirmed"
	 * success. The temporal activity sets this so Temporal retries. */
	throwOnWholesaleVerifierFailure: boolean;
}

export interface DuplicateScanCoreResult {
	/** Stories with usable (non-blank) text that participated in the scan. */
	scanned: number;
	/** Candidate pairs that cleared the cosine pre-filter this run. */
	candidates: number;
	/** Pairs the LLM confirmed and that were upserted as PENDING links. */
	confirmed: number;
	/** Candidate pairs dropped by the per-run cap (never silently swallowed). */
	truncated: number;
	/** Verifier calls that errored (their pairs are retried next run). */
	verifierFailures: number;
}

const EMPTY_RESULT: DuplicateScanCoreResult = {
	scanned: 0,
	candidates: 0,
	confirmed: 0,
	truncated: 0,
	verifierFailures: 0,
};

export async function runDuplicateScanCore(
	params: DuplicateScanCoreParams,
): Promise<DuplicateScanCoreResult> {
	const { projectId, userId, organizationId, selection, logPrefix } = params;

	// 1. Full active backlog. In targets mode the just-created items are
	//    already part of it — they are active the moment they are created.
	const stories = await listActiveStoriesForDetection(projectId);
	const withText = stories
		.map((s) => ({
			id: s.id,
			identifier: s.identifier,
			text: detectionTextForStory(s),
			createdAt: s.createdAt,
		}))
		.filter((s) => s.text.length > 0);

	// Restrict targets to those that actually carry usable text and exist in
	// the active set (a blank-title item carries no duplicate signal).
	const presentIds = new Set(withText.map((s) => s.id));
	const targetIds =
		selection.mode === "targets"
			? new Set(
					Array.from(selection.targetIds).filter((id) =>
						presentIds.has(id),
					),
				)
			: null;
	if (withText.length < 2 || (targetIds !== null && targetIds.size === 0)) {
		return { ...EMPTY_RESULT, scanned: withText.length };
	}

	// 2. Embed — but only what the shared embedding cache doesn't already
	//    cover. Auto-detect used to re-embed the ENTIRE active backlog on
	//    every create batch (~350+ texts on the main prod project), which is
	//    what made it fragile against gateway timeouts (observed 2026-07-10: a
	//    5-minute "Gateway request failed" on the full-backlog batch).
	const currentHashById = new Map(
		withText.map((s) => [s.id, hashDetectionText(s.text)]),
	);
	const cacheMeta = await listStoryDuplicateEmbeddingMetadata(projectId);
	const cacheMetaByStoryId = new Map(cacheMeta.map((r) => [r.storyId, r]));

	// Resolve the embedding model up front — a cheap provider/model lookup —
	// so staleness can include a model change in one pass (never cosine
	// across vectors from different embedding models). `baseModelName`
	// mirrors how `generateEmbeddings` records the model on a cached row.
	let currentModel: string;
	try {
		const resolved = await resolveModelWithProvider("EMBEDDING", {
			userId,
			organizationId: organizationId ?? undefined,
		});
		currentModel = baseModelName(resolved.modelString);
	} catch (err) {
		logger.error(`${logPrefix} embedding model resolution failed`, {
			projectId,
			err: err instanceof Error ? err.message : String(err),
		});
		throw new EmbeddingUnavailableError(err);
	}

	// An item is STALE (must be re-embedded) when it has no cache row, its
	// detection text changed (hash mismatch — which a DETECTION_VERSION bump
	// forces for every item), or it was embedded with a different model.
	const staleItems = withText.filter((s) => {
		const cached = cacheMetaByStoryId.get(s.id);
		return (
			!cached ||
			cached.contentHash !== currentHashById.get(s.id) ||
			cached.model !== currentModel
		);
	});
	const staleIdSet = new Set(staleItems.map((s) => s.id));

	const embeddingByStoryId = new Map<string, number[]>();
	if (staleIdSet.size < withText.length) {
		const cacheRows = await listStoryDuplicateEmbeddings(projectId);
		for (const row of cacheRows) {
			if (!staleIdSet.has(row.storyId)) {
				embeddingByStoryId.set(row.storyId, row.embedding);
			}
		}
	}

	let embeddedModel = currentModel;
	let freshCacheRows: Array<{
		storyId: string;
		contentHash: string;
		model: string;
		embedding: number[];
	}> = [];
	if (staleItems.length > 0) {
		try {
			const { embeddings, model } = await generateEmbeddings(
				staleItems.map((s) => s.text),
				{
					userId,
					organizationId: organizationId ?? undefined,
					projectId,
				},
			);
			embeddedModel = model;
			staleItems.forEach((s, i) => {
				embeddingByStoryId.set(s.id, embeddings[i]);
			});
			freshCacheRows = staleItems.map((s, i) => ({
				storyId: s.id,
				contentHash: currentHashById.get(s.id) ?? "",
				model: embeddedModel,
				embedding: embeddings[i],
			}));
		} catch (err) {
			logger.error(`${logPrefix} embedding failed`, {
				projectId,
				texts: staleItems.length,
				err: err instanceof Error ? err.message : String(err),
			});
			throw new EmbeddingUnavailableError(err);
		}
	}

	// 3. Detection set — fresh vectors for stale items, cached for the rest.
	//    The filter is a defensive guard dropping any item left without a
	//    vector (a non-stale item always has a cache row).
	const items: DetectionItem[] = withText
		.map((s): DetectionItem | null => {
			const embedding = embeddingByStoryId.get(s.id);
			return embedding
				? { storyId: s.id, embedding, createdAt: s.createdAt }
				: null;
		})
		.filter((item): item is DetectionItem => item !== null);

	// 4. Cosine candidate selection, skipping pairs the user already
	//    dismissed and pairs whose stored verdict (positive or negative) is
	//    still valid at the current content hashes — the verdict cache is
	//    what makes repeated scans cheap, NOT embedding staleness.
	const [dismissedPairKeys, verdictValidPairKeys] = await Promise.all([
		listDismissedDuplicatePairKeys(projectId),
		listVerdictValidPairKeys(projectId, currentHashById),
	]);
	const excludeKeys = new Set([
		...dismissedPairKeys,
		...verdictValidPairKeys,
	]);
	const selected: CandidateSelection =
		targetIds !== null
			? selectCandidatePairsForTargets(targetIds, items, { excludeKeys })
			: selectCandidatePairs(items, { excludeKeys });
	const { pairs, truncated, droppedPairs, nearMisses } = selected;
	if (truncated > 0) {
		logger.warn(
			`${logPrefix} candidate cap reached — extra pairs not verified this run; their items stay stale so the next run retries them`,
			{ projectId, cap: MAX_LLM_VERIFICATIONS, dropped: truncated },
		);
	}
	if (nearMisses.length > 0) {
		// Answers "why wasn't X flagged?" from logs without a redeploy.
		// Identifiers + scores only — no story content (worker-log redaction
		// policy).
		const identifierById = new Map(
			withText.map((s) => [s.id, s.identifier]),
		);
		logger.info(`${logPrefix} near-miss pairs below threshold`, {
			projectId,
			nearMisses: nearMisses.map((p) => ({
				a: identifierById.get(p.storyAId) ?? p.storyAId,
				b: identifierById.get(p.storyBId) ?? p.storyBId,
				similarity: Number(p.similarity.toFixed(4)),
				proximate: p.proximate,
			})),
		});
	}

	// Per-item cache persist: an item is stamped fresh once every candidate
	// pair involving it was actually verified this run. Items in a dropped
	// (capped) or failed pair stay stale, so the next run re-embeds only them
	// and retries exactly the unfinished pairs. Best-effort: a write failure
	// (e.g. a story hard-deleted mid-scan breaking the FK) must not fail a
	// run whose detection work already completed.
	const persistEmbeddingCache = async (retainStaleIds: Set<string>) => {
		const rows = freshCacheRows.filter(
			(row) => !retainStaleIds.has(row.storyId),
		);
		if (rows.length === 0) {
			return;
		}
		try {
			await upsertStoryDuplicateEmbeddings(projectId, rows);
		} catch (err) {
			logger.warn(
				`${logPrefix} embedding cache write failed — continuing; the next run re-embeds these items`,
				{
					projectId,
					rows: rows.length,
					err: err instanceof Error ? err.message : String(err),
				},
			);
		}
	};

	if (pairs.length === 0) {
		// Nothing to verify ⇒ every embedded item's work is complete, except
		// items only involved in dropped pairs (structurally impossible here —
		// truncation implies a full page of pairs — but kept for symmetry).
		await persistEmbeddingCache(
			new Set(droppedPairs.flatMap((p) => [p.storyAId, p.storyBId])),
		);
		return {
			scanned: withText.length,
			candidates: 0,
			confirmed: 0,
			truncated,
			verifierFailures: 0,
		};
	}

	// 5. LLM-verify each candidate. EVERY completed verification persists —
	//    a PENDING link (DUPLICATE or OVERLAP) or a cached negative verdict —
	//    so a pair is paid for at most once per content change and drain
	//    progress over a large candidate set is monotonic.
	const byId = new Map(withText.map((s) => [s.id, s]));
	const { model, trackUsage } = await getAIModelWithMetadata(
		{ taskType: params.aiTaskType },
		// projectId is threaded so the verifier's token spend is attributed to
		// the project in ai_usage_log — without it a scan's LLM cost is
		// unattributable, which is exactly what made the wider band's cost hard
		// to measure.
		{ userId, organizationId: organizationId ?? undefined, projectId },
	);

	let confirmed = 0;
	let verifierFailures = 0;
	const failedPairItemIds = new Set<string>();
	for (const pair of pairs) {
		const a = byId.get(pair.storyAId);
		const b = byId.get(pair.storyBId);
		if (!a || !b) {
			continue;
		}
		try {
			const { object: verdict } = await generateObject({
				model,
				schema: VerdictSchema,
				prompt: buildVerifierPrompt(a, b, {
					proximate: pair.proximate,
				}),
			});
			trackUsage();
			const relationship = normalizeVerifierRelationship(verdict);
			const contentHashA = currentHashById.get(pair.storyAId) ?? "";
			const contentHashB = currentHashById.get(pair.storyBId) ?? "";
			const outcome = classifyVerdict(relationship, verdict.confidence);
			if (outcome.action === "link") {
				await upsertPendingDuplicateLink({
					projectId,
					storyAId: pair.storyAId,
					storyBId: pair.storyBId,
					similarity: pair.similarity,
					confidence: verdict.confidence,
					reasoning: verdict.reasoning,
					linkType: outcome.linkType,
					contentHashA,
					contentHashB,
				});
				confirmed += 1;
			} else {
				await recordDistinctVerdict({
					projectId,
					storyAId: pair.storyAId,
					storyBId: pair.storyBId,
					similarity: pair.similarity,
					confidence: verdict.confidence,
					reasoning: verdict.reasoning,
					contentHashA,
					contentHashB,
				});
			}
		} catch (err) {
			// One flaky verdict is skipped, not fatal — a single bad pair
			// can't abort detection for the whole batch. Its items stay stale
			// so the pair is re-selected and retried next run.
			verifierFailures += 1;
			failedPairItemIds.add(pair.storyAId);
			failedPairItemIds.add(pair.storyBId);
			logger.warn(`${logPrefix} verifier failed for a pair — skipping`, {
				projectId,
				err: err instanceof Error ? err.message : String(err),
				// Raw model output when the SDK rejects it against the schema
				// (NoObjectGeneratedError) — invaluable for diagnosing a
				// structured-output regression without another deploy.
				modelText: (err as { text?: string })?.text?.slice(0, 300),
			});
		}
	}

	// Every candidate pair failed to verify — the verifier is wholesale
	// broken (e.g. the resolved model can't produce the structured verdict,
	// or a provider outage). Optionally throw so a Temporal activity FAILS
	// and is retried with backoff, rather than returning a misleading
	// "0 duplicates" success. Nothing is persisted to the embedding cache on
	// this path — every pair's items are in failedPairItemIds anyway.
	if (
		params.throwOnWholesaleVerifierFailure &&
		pairs.length > 0 &&
		verifierFailures === pairs.length
	) {
		throw new Error(
			`${logPrefix} verifier failed for all ${pairs.length} candidate pair(s) — failing activity for retry`,
		);
	}

	// 6. Per-item cache persist: retain staleness for items in a failed or
	//    dropped pair; everything else this run embedded is complete.
	const retainStaleIds = new Set<string>(failedPairItemIds);
	for (const p of droppedPairs) {
		retainStaleIds.add(p.storyAId);
		retainStaleIds.add(p.storyBId);
	}
	await persistEmbeddingCache(retainStaleIds);

	// Always-on run summary — the band widening's verifier volume is a cost
	// the team wants observable per run, not only when something is flagged.
	logger.info(`${logPrefix} run complete`, {
		projectId,
		scanned: withText.length,
		embedded: staleItems.length,
		reused: items.length - staleItems.length,
		candidates: pairs.length,
		confirmed,
		verifierFailures,
		truncated,
	});

	return {
		scanned: withText.length,
		candidates: pairs.length,
		confirmed,
		truncated,
		verifierFailures,
	};
}
