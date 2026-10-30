/**
 * Shared orchestration core for semantic duplicate detection.
 *
 * Both consumers run the same pipeline — load the active backlog, split it
 * against the shared `StoryDuplicateEmbedding` cache, embed only stale items
 * and stale feature sections, select candidate pairs on their whole-document
 * cosine or — for FEATURE↔FEATURE pairs — their Scope (or acceptance-criteria)
 * weighted score, LLM-verify each candidate with the 3-way verdict
 * (duplicate / overlapping scope / distinct), and persist
 * every completed verdict — and differ only in thin wrapper concerns:
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
 *     dropped by the per-run cap, not reached within the run's time budget,
 *     or whose verifier call failed — those stay stale so the next run
 *     re-selects and retries exactly the unfinished pairs.
 *   - The two are independent on purpose: an auto-detect run warming the
 *     embedding cache for the whole backlog must NOT be able to skip the
 *     verification drain a DETECTION_VERSION bump exists to force (verdict
 *     rows are keyed on version-prefixed hashes, so a bump invalidates them
 *     all regardless of embedding-cache state).
 *   - FOCUS vectors (each feature's Scope / acceptance-criteria sections)
 *     have their own cache, keyed per story and section on the section
 *     text's hash and the embedding model. Every feature's vectors are needed
 *     before candidates are chosen — a feature pair is a candidate when its
 *     Scope-weighted score clears the threshold — so only changed sections
 *     are embedded, and they are persisted as soon as they are: a section
 *     vector depends on nothing but its text, so no failed or capped pair
 *     needs it re-embedded. The whole-document cache stays the single text
 *     every matcher shares.
 *   - A feature's VERDICT hash folds in its section texts, so a pair is
 *     re-verified when either side's Scope or acceptance criteria change,
 *     even past the length the whole-document text is cut at. A feature with
 *     no sections folds in its kind instead, so turning a bug into a feature
 *     (or back) re-verifies its pairs under the other prompt.
 *   - A re-check that would CHANGE a pair's state (raise a flag over a cached
 *     negative verdict, clear a flag, or move it between tiers) is confirmed
 *     by a second verifier call, for every kind of pair. Borderline pairs get
 *     different answers on different calls; without the second opinion a flag
 *     would come and go with every edit. When the second does not back the
 *     change (see confirmedEffect), the pair keeps its state and its hashes
 *     are stamped, so it is not re-billed until one side changes.
 *   - Two scans can overlap (a manual scan and a per-create check). A pair's
 *     row is read again just before it is verified and again just before its
 *     verdict is written; when another run has already verified the same
 *     content, its verdict stands. That leaves only the instant between the
 *     last read and the write for two runs to race in.
 */

import {
	AIProviderNotConfiguredError,
	generateObject,
	getAIModelWithMetadata,
	resolveModelWithProvider,
} from "@repo/ai";
import { UnsupportedEmbeddingModelError } from "@repo/ai/lib/embedding-dimensions";
import {
	baseModelName,
	buildVerifierPrompt,
	type CachedFocusEmbedding,
	type CandidateSelection,
	candidateScore,
	classifyVerdict,
	type DetectionItem,
	detectionTextForStory,
	effectiveCandidateThreshold,
	extractFocusTexts,
	getDuplicateLinkState,
	hashDetectionText,
	hasProviderCredentials,
	listActiveStoriesForDetection,
	listDismissedDuplicatePairKeys,
	listPendingDuplicatePairs,
	listStoryDuplicateEmbeddingMetadata,
	listStoryDuplicateEmbeddings,
	listStoryDuplicateFocusEmbeddings,
	listVerdictValidPairKeys,
	MAX_LLM_VERIFICATIONS,
	normalizeVerifierRelationship,
	PAIR_FOCUS_KINDS,
	type PairFocusKind,
	recordDistinctVerdict,
	refreshPendingDuplicateSimilarities,
	rescoreFlaggedFeaturePairs,
	selectCandidatePairs,
	selectCandidatePairsForTargets,
	stampVerifiedHashes,
	upsertPendingDuplicateLink,
	upsertStoryDuplicateEmbeddings,
	upsertStoryDuplicateFocusEmbeddings,
	withdrawPendingDuplicateLinks,
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
export const VerdictSchema = z.object({
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
 * How long a run may go on before it stops starting verifications. Pairs are
 * verified one at a time, and a verdict that changes a pair's state takes a
 * second call, so a full page of pairs has taken close to ten minutes — the
 * worker activity's start-to-close timeout. Pairs not reached are reported as
 * `truncated`, like those over the per-run cap, so the workflow's next run and
 * the scan dialog's next request verify them. The rest of the activity timeout
 * (and of the web route's 800 s limit) covers the pair in flight and the cache
 * writes.
 */
export const RUN_TIME_BUDGET_MS = 7 * 60_000;

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
	/** Candidate pairs that cleared the cosine pre-filter and that this run
	 * reached. */
	candidates: number;
	/** Pairs the LLM confirmed and that were upserted as PENDING links. */
	confirmed: number;
	/** Candidate pairs left for a later run: dropped by the per-run cap or not
	 * reached within RUN_TIME_BUDGET_MS (never silently swallowed). */
	truncated: number;
	/** Verifier calls that errored (their pairs are retried next run). */
	verifierFailures: number;
}

/** How a focused (feature) pair ended: linked, not flagged by the verifier,
 * left as it was because a second opinion disagreed, already verified by an
 * overlapping run, or failed. */
type FocusedPairOutcome =
	| "linked:DUPLICATE"
	| "linked:OVERLAP"
	| "distinct"
	| "unconfirmed"
	| "already-verified"
	| "failed";

/** What a verdict does to a pair's row: raise or keep a flag at a tier,
 * clear an unreviewed flag, or only cache a negative verdict. */
type VerdictEffect = "link:DUPLICATE" | "link:OVERLAP" | "clear" | "cache";

type DuplicateLinkState = Awaited<ReturnType<typeof getDuplicateLinkState>>;

/** Whether applying `effect` would change what people see for the pair:
 * a flag raised over a cached negative verdict, an unreviewed flag cleared,
 * or a flag moved to the other tier. A first verdict on a new pair and a
 * DISMISSED/RESOLVED row (a person's decision, never overwritten) change
 * nothing that needs a second opinion. */
export function verdictChangesState(
	prior: DuplicateLinkState,
	effect: VerdictEffect,
): boolean {
	if (!prior) {
		return false;
	}
	switch (prior.status) {
		case "PENDING":
			return (
				effect === "clear" ||
				(effect.startsWith("link:") &&
					effect !== `link:${prior.linkType}`)
			);
		case "NOT_DUPLICATE":
			return effect.startsWith("link:");
		case "DISMISSED":
		case "RESOLVED":
			return false;
		default: {
			const unhandled: never = prior.status;
			return unhandled;
		}
	}
}

/** The effect a state change takes once a second verdict is in, or null when
 * the second verdict does not back it. Two verdicts that both flag a pair
 * raise its flag even if they name different tiers — at the softer OVERLAP
 * tier — while moving an existing flag to another tier, or clearing it, needs
 * the second verdict to say exactly the same. */
export function confirmedEffect(
	prior: DuplicateLinkState,
	first: VerdictEffect,
	second: VerdictEffect,
): VerdictEffect | null {
	if (second === first) {
		return first;
	}
	return prior?.status !== "PENDING" &&
		first.startsWith("link:") &&
		second.startsWith("link:")
		? "link:OVERLAP"
		: null;
}

/** Whether a stored row already carries a verdict on exactly this content. */
function verdictIsCurrent(
	state: DuplicateLinkState,
	contentHashA: string,
	contentHashB: string,
): boolean {
	return (
		(state?.status === "PENDING" || state?.status === "NOT_DUPLICATE") &&
		state.verifiedContentHashA === contentHashA &&
		state.verifiedContentHashB === contentHashB
	);
}

/** One focused pair in the per-run tuning log — identifiers and scores. */
type FocusedPairLogEntry = {
	a: string;
	b: string;
	focus: PairFocusKind;
	focusSimilarity: number;
	documentSimilarity: number;
	weighted: number;
	threshold: number;
	/** The whole-document cosine alone clears the threshold. A focused pair is
	 * selected on its weighted score either way; this records whether a
	 * whole-document rule would have selected it too, for tuning. */
	byDocument: boolean;
	outcome: FocusedPairOutcome;
};

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
	const startedAt = Date.now();

	// 1. Full active backlog. In targets mode the just-created items are
	//    already part of it — they are active the moment they are created.
	const stories = await listActiveStoriesForDetection(projectId);
	const withText = stories
		.map((s) => ({
			id: s.id,
			identifier: s.identifier,
			text: detectionTextForStory(s),
			createdAt: s.createdAt,
			kind: s.kind,
			// A feature's Scope / acceptance-criteria sections; null for a bug.
			// Never part of the shared detection text.
			focusTexts: extractFocusTexts(s),
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
	// The hash a pair verdict is cached against. A feature's also covers its
	// section texts, which can sit past the length the detection text is cut
	// at, or — with no sections — its kind, so a bug turned feature is
	// verified again under the feature prompt; a bug's is its detection-text
	// hash.
	const verdictHashById = new Map(
		withText.map((s) => {
			const sections = PAIR_FOCUS_KINDS.flatMap(
				(kind) => s.focusTexts?.[kind] ?? [],
			);
			const parts =
				sections.length > 0
					? sections
					: s.kind === "FEATURE"
						? ["kind:FEATURE"]
						: [];
			return [
				s.id,
				parts.length > 0
					? hashDetectionText([s.text, ...parts].join("\n\n"))
					: (currentHashById.get(s.id) ?? ""),
			];
		}),
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
		// `resolveModelWithProvider` does not throw for a keyless tenant — it
		// RETURNS `{ apiKey: null, _error }` with an empty model string. Left
		// unchecked, that empty string matches no cached row's model, marks the
		// entire corpus stale, and sends every story to the embedder purely to
		// fail there. Refuse here instead, and refuse with the type Temporal
		// matches: the catch below rewraps into `EmbeddingUnavailableError`,
		// which is absent from `AI_NON_RETRYABLE_ERROR_TYPES`, so a
		// configuration refusal would burn the whole retry budget on an answer
		// that cannot change. Mirrors the guard in `semantic-search.ts`.
		if (!hasProviderCredentials(resolved)) {
			throw new AIProviderNotConfiguredError(
				resolved._error ??
					"No embedding provider configured. Add one in Settings → AI Providers.",
			);
		}
		currentModel = baseModelName(resolved.modelString);
	} catch (err) {
		// A configuration refusal is deterministic — pass it through with its
		// own type rather than rewrapping it as a transient embedding failure.
		if (err instanceof AIProviderNotConfiguredError) {
			throw err;
		}
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

	// One embedding call under the scan's error contract, shared by the
	// whole-document and focus-section calls: a configuration refusal passes
	// through with its own type (deterministic — never worth a retry), while
	// anything else is logged and rewrapped as the transient
	// EmbeddingUnavailableError the wrappers map and retry.
	const embedTexts = async (texts: string[], failureMessage: string) => {
		try {
			return await generateEmbeddings(texts, {
				userId,
				organizationId: organizationId ?? undefined,
				projectId,
				featureKey: "duplicate-scan",
			});
		} catch (err) {
			if (
				err instanceof AIProviderNotConfiguredError ||
				err instanceof UnsupportedEmbeddingModelError
			) {
				throw err;
			}
			logger.error(`${logPrefix} ${failureMessage}`, {
				projectId,
				texts: texts.length,
				err: err instanceof Error ? err.message : String(err),
			});
			throw new EmbeddingUnavailableError(err);
		}
	};

	let freshCacheRows: Array<{
		storyId: string;
		contentHash: string;
		model: string;
		embedding: number[];
	}> = [];
	if (staleItems.length > 0) {
		const { embeddings, model } = await embedTexts(
			staleItems.map((s) => s.text),
			"embedding failed",
		);
		staleItems.forEach((s, i) => {
			embeddingByStoryId.set(s.id, embeddings[i]);
		});
		freshCacheRows = staleItems.map((s, i) => ({
			storyId: s.id,
			contentHash: currentHashById.get(s.id) ?? "",
			model,
			embedding: embeddings[i],
		}));
	}

	// 2b. Every feature's section vectors, from their own cache; only sections
	//     whose text or embedding model changed go to the embedder, in ONE
	//     call shared by identical texts.
	const focusSections = withText.flatMap((s) =>
		PAIR_FOCUS_KINDS.flatMap((kind) => {
			const text = s.focusTexts?.[kind];
			return text
				? [
						{
							storyId: s.id,
							kind,
							text,
							contentHash: hashDetectionText(text),
						},
					]
				: [];
		}),
	);
	const focusVectorsById = new Map<
		string,
		Partial<Record<PairFocusKind, number[]>>
	>();
	const setFocusVector = (
		storyId: string,
		kind: PairFocusKind,
		vector: number[],
	) => {
		focusVectorsById.set(storyId, {
			...focusVectorsById.get(storyId),
			[kind]: vector,
		});
	};
	let focusEmbedded = 0;
	if (focusSections.length > 0) {
		const cachedFocus = new Map(
			(await listStoryDuplicateFocusEmbeddings(projectId)).map((row) => [
				`${row.storyId}:${row.kind}`,
				row,
			]),
		);
		const staleSections = focusSections.filter((section) => {
			const cached = cachedFocus.get(
				`${section.storyId}:${section.kind}`,
			);
			if (
				cached &&
				cached.contentHash === section.contentHash &&
				cached.model === currentModel
			) {
				setFocusVector(section.storyId, section.kind, cached.embedding);
				return false;
			}
			return true;
		});
		if (staleSections.length > 0) {
			const texts = Array.from(new Set(staleSections.map((s) => s.text)));
			const { embeddings, model } = await embedTexts(
				texts,
				"focus-section embedding failed",
			);
			const vectorByText = new Map(
				texts.map((text, i) => [text, embeddings[i]]),
			);
			const rows: CachedFocusEmbedding[] = staleSections.flatMap(
				(section) => {
					const embedding = vectorByText.get(section.text);
					if (!embedding) {
						return [];
					}
					setFocusVector(section.storyId, section.kind, embedding);
					return [
						{
							storyId: section.storyId,
							kind: section.kind,
							contentHash: section.contentHash,
							model,
							embedding,
						},
					];
				},
			);
			focusEmbedded = rows.length;
			// Best-effort, like the whole-document cache write: a failed write
			// only means the next run embeds these sections again.
			try {
				await upsertStoryDuplicateFocusEmbeddings(projectId, rows);
			} catch (err) {
				logger.warn(
					`${logPrefix} focus-section cache write failed — continuing; the next run re-embeds these sections`,
					{
						projectId,
						rows: rows.length,
						err: err instanceof Error ? err.message : String(err),
					},
				);
			}
		}
	}

	// 3. Detection set — fresh vectors for stale items, cached for the rest.
	//    The filter is a defensive guard dropping any item left without a
	//    vector (a non-stale item always has a cache row).
	const items: DetectionItem[] = withText
		.map((s): DetectionItem | null => {
			const embedding = embeddingByStoryId.get(s.id);
			return embedding
				? {
						storyId: s.id,
						embedding,
						createdAt: s.createdAt,
						focusVectors: focusVectorsById.get(s.id),
					}
				: null;
		})
		.filter((item): item is DetectionItem => item !== null);

	// 4. Cosine candidate selection, skipping pairs the user already
	//    dismissed and pairs whose stored verdict (positive or negative) is
	//    still valid at the current content hashes — the verdict cache is
	//    what makes repeated scans cheap, NOT embedding staleness.
	const [dismissedPairKeys, verdictValidPairKeys, pendingPairs] =
		await Promise.all([
			listDismissedDuplicatePairKeys(projectId),
			listVerdictValidPairKeys(projectId, verdictHashById),
			listPendingDuplicatePairs(projectId),
		]);
	// An unreviewed feature flag the current rule would not raise is
	// withdrawn, and one it would is stored with the score it is raised on
	// (see rescoreFlaggedFeaturePairs).
	const flagged = rescoreFlaggedFeaturePairs(pendingPairs, items, {
		targetIds: targetIds ?? undefined,
	});
	const withdrawn = await withdrawPendingDuplicateLinks(
		projectId,
		flagged.withdraw,
	);
	const rescored = await refreshPendingDuplicateSimilarities(
		projectId,
		flagged.rescore,
	);
	if (withdrawn > 0 || rescored > 0) {
		logger.info(
			`${logPrefix} brought unreviewed flags in line with the rule`,
			{
				projectId,
				withdrawn,
				rescored,
			},
		);
	}
	const excludeKeys = new Set([
		...dismissedPairKeys,
		...verdictValidPairKeys,
	]);
	const selected: CandidateSelection =
		targetIds !== null
			? selectCandidatePairsForTargets(targetIds, items, { excludeKeys })
			: selectCandidatePairs(items, { excludeKeys });
	const { pairs, truncated, droppedPairs, nearMisses, scopeExcluded } =
		selected;
	const identifierById = new Map(withText.map((s) => [s.id, s.identifier]));
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
		logger.info(`${logPrefix} near-miss pairs below threshold`, {
			projectId,
			nearMisses: nearMisses.map((p) => ({
				a: identifierById.get(p.storyAId) ?? p.storyAId,
				b: identifierById.get(p.storyBId) ?? p.storyBId,
				similarity: Number(p.similarity.toFixed(4)),
				score: Number(candidateScore(p).toFixed(4)),
				proximate: p.proximate,
			})),
		});
	}
	if (scopeExcluded.length > 0) {
		// Feature pairs whose documents read alike but whose Scope (or
		// criteria) do not — the recall the Scope weighting trades away, kept
		// observable so a missed duplicate among them can be found and the
		// weight revisited. Same redaction policy as above.
		logger.info(`${logPrefix} feature pairs kept out by their sections`, {
			projectId,
			scopeExcluded: scopeExcluded.map((p) => ({
				a: identifierById.get(p.storyAId) ?? p.storyAId,
				b: identifierById.get(p.storyBId) ?? p.storyBId,
				focus: p.focus?.kind,
				similarity: Number(p.similarity.toFixed(4)),
				score: Number(candidateScore(p).toFixed(4)),
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
	//    progress over a large candidate set is monotonic. A distinct verdict
	//    on a feature pair also clears its unreviewed PENDING flag: under the
	//    current logic it is a stale false positive (see recordDistinctVerdict).
	const { model, trackUsage } = await getAIModelWithMetadata(
		{ taskType: params.aiTaskType },
		// projectId and featureKey are threaded so the verifier's token spend
		// is attributed to the project and to duplicate detection in
		// ai_usage_log, like the scan's embedding calls.
		{
			userId,
			organizationId: organizationId ?? undefined,
			projectId,
			featureKey: "duplicate-scan",
		},
	);

	const byId = new Map(withText.map((s) => [s.id, s]));
	let confirmed = 0;
	let verifierFailures = 0;
	// Pairs this run tried to verify (not already verified by an overlapping
	// run), and state changes a second opinion did not confirm.
	let attempted = 0;
	let unconfirmed = 0;
	const failedPairItemIds = new Set<string>();
	const focusedPairs: FocusedPairLogEntry[] = [];
	const round = (value: number) => Number(value.toFixed(4));
	// Pairs left when the time budget ran out. The first pair is always
	// verified, so a run that spent its budget embedding still makes progress.
	let unreached: typeof pairs = [];
	for (const [index, pair] of pairs.entries()) {
		if (index > 0 && Date.now() - startedAt >= RUN_TIME_BUDGET_MS) {
			unreached = pairs.slice(index);
			break;
		}
		const a = byId.get(pair.storyAId);
		const b = byId.get(pair.storyBId);
		if (!a || !b) {
			continue;
		}
		// A focused feature pair is verified on the section it was scored on,
		// as the primary signal; any other pair keeps the whole-document
		// prompt.
		const focusKind = pair.focus?.kind;
		const focusTextA = focusKind ? a.focusTexts?.[focusKind] : undefined;
		const focusTextB = focusKind ? b.focusTexts?.[focusKind] : undefined;
		const focus =
			focusKind && focusTextA && focusTextB
				? { kind: focusKind, textA: focusTextA, textB: focusTextB }
				: undefined;
		// The candidate score is the similarity a pair is stored and shown
		// with. It never settles a pair on its own: section cosines near the
		// threshold do not separate duplicates from distinct work, while a
		// verifier call costs a fraction of a cent, so the verifier — reading
		// the same sections as its primary signal — decides every candidate.
		const similarity = candidateScore(pair);
		const threshold = effectiveCandidateThreshold(pair.proximate);
		const contentHashA = verdictHashById.get(pair.storyAId) ?? "";
		const contentHashB = verdictHashById.get(pair.storyBId) ?? "";
		const bothFeatures = a.kind === "FEATURE" && b.kind === "FEATURE";
		const prompt = buildVerifierPrompt(a, b, {
			proximate: pair.proximate,
			focus,
			bothFeatures,
		});
		const verify = async () => {
			const { object: verdict } = await generateObject({
				model,
				schema: VerdictSchema,
				prompt,
			});
			trackUsage();
			const relationship = normalizeVerifierRelationship(verdict);
			const outcome = classifyVerdict(relationship, verdict.confidence);
			// An unsure "same" or "overlapping" verdict is cached, but does not
			// withdraw a flag a confident one raised. Only a feature pair's
			// flag is withdrawn: bug and mixed pairs are scored and verified
			// exactly as before, so a distinct re-check of theirs is a second
			// opinion on the same logic, not a fix for a false positive.
			const effect: VerdictEffect =
				outcome.action === "link"
					? `link:${outcome.linkType}`
					: bothFeatures && relationship === "distinct"
						? "clear"
						: "cache";
			return { verdict, effect };
		};
		const readState = () =>
			getDuplicateLinkState(projectId, pair.storyAId, pair.storyBId);
		let focusOutcome: FocusedPairOutcome = "failed";
		// Counted before the state read, so a failed read still counts
		// towards a wholesale failure; undone when an overlapping run already
		// verified the pair.
		attempted += 1;
		try {
			const prior = await readState();
			if (verdictIsCurrent(prior, contentHashA, contentHashB)) {
				// An overlapping run verified this exact content after this run
				// chose its candidates: the first verdict stands.
				attempted -= 1;
				focusOutcome = "already-verified";
				continue;
			}
			const { verdict, effect: first } = await verify();
			let effect: VerdictEffect | null = first;
			if (verdictChangesState(prior, first)) {
				effect = confirmedEffect(prior, first, (await verify()).effect);
			}
			// The verifier calls take seconds; an overlapping run may have
			// written a verdict on the same content meanwhile. Its verdict
			// stands — this leaves only the instant between this read and the
			// write below for two runs to race in.
			if (
				verdictIsCurrent(await readState(), contentHashA, contentHashB)
			) {
				focusOutcome = "already-verified";
				continue;
			}
			if (effect === null) {
				await stampVerifiedHashes({
					projectId,
					storyAId: pair.storyAId,
					storyBId: pair.storyBId,
					contentHashA,
					contentHashB,
				});
				unconfirmed += 1;
				focusOutcome = "unconfirmed";
				continue;
			}
			if (effect === "link:DUPLICATE" || effect === "link:OVERLAP") {
				const linkType =
					effect === "link:DUPLICATE" ? "DUPLICATE" : "OVERLAP";
				await upsertPendingDuplicateLink({
					projectId,
					storyAId: pair.storyAId,
					storyBId: pair.storyBId,
					similarity,
					confidence: verdict.confidence,
					reasoning: verdict.reasoning,
					linkType,
					contentHashA,
					contentHashB,
				});
				confirmed += 1;
				focusOutcome = `linked:${linkType}`;
			} else {
				await recordDistinctVerdict({
					projectId,
					storyAId: pair.storyAId,
					storyBId: pair.storyBId,
					similarity,
					confidence: verdict.confidence,
					reasoning: verdict.reasoning,
					contentHashA,
					contentHashB,
					clearsPendingFlag: effect === "clear",
				});
				focusOutcome = "distinct";
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
		} finally {
			// Runs on every exit from the try, a failed verification included.
			if (pair.focus) {
				focusedPairs.push({
					a: a.identifier,
					b: b.identifier,
					focus: pair.focus.kind,
					focusSimilarity: round(pair.focus.similarity),
					documentSimilarity: round(pair.similarity),
					weighted: round(pair.focus.weighted),
					threshold: round(threshold),
					byDocument: pair.similarity >= threshold,
					outcome: focusOutcome,
				});
			}
		}
	}

	if (unreached.length > 0) {
		logger.warn(
			`${logPrefix} time budget reached — remaining pairs not verified this run; their items stay stale so the next run retries them`,
			{
				projectId,
				budgetMs: RUN_TIME_BUDGET_MS,
				verified: pairs.length - unreached.length,
				notReached: unreached.length,
			},
		);
	}

	// Every focused (feature) pair's scores and outcome, so
	// FOCUS_SECTION_WEIGHT can be tuned against how people later resolve the
	// same pairs. Identifiers + numbers only — no story content (worker-log
	// redaction policy, as for the near-miss log).
	if (focusedPairs.length > 0) {
		logger.info(
			`${logPrefix} feature pairs scored on Scope / acceptance criteria`,
			{ projectId, pairs: focusedPairs },
		);
	}

	// Every pair that reached the verifier failed — the verifier is wholesale
	// broken (e.g. the resolved model can't produce the structured verdict,
	// or a provider outage). Optionally throw so a Temporal activity FAILS
	// and is retried with backoff, rather than returning a misleading
	// "0 duplicates" success.
	if (
		params.throwOnWholesaleVerifierFailure &&
		attempted > 0 &&
		verifierFailures >= attempted
	) {
		throw new Error(
			`${logPrefix} verifier failed for all ${attempted} candidate pair(s) — failing activity for retry`,
		);
	}

	// 7. Per-item cache persist: retain staleness for items in a failed,
	//    dropped or unreached pair; everything else this run embedded is
	//    complete.
	const retainStaleIds = new Set<string>(failedPairItemIds);
	for (const p of [...droppedPairs, ...unreached]) {
		retainStaleIds.add(p.storyAId);
		retainStaleIds.add(p.storyBId);
	}
	await persistEmbeddingCache(retainStaleIds);
	const reached = pairs.length - unreached.length;
	const leftOver = truncated + unreached.length;

	// Always-on run summary — the band widening's verifier volume is a cost
	// the team wants observable per run, not only when something is flagged.
	logger.info(`${logPrefix} run complete`, {
		projectId,
		scanned: withText.length,
		embedded: staleItems.length,
		reused: items.length - staleItems.length,
		focusEmbedded,
		candidates: reached,
		verified: attempted,
		confirmed,
		unconfirmed,
		verifierFailures,
		truncated: leftOver,
	});

	return {
		scanned: withText.length,
		candidates: reached,
		confirmed,
		truncated: leftOver,
		verifierFailures,
	};
}
