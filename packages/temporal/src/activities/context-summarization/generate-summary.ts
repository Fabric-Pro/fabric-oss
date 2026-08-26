import {
	type FoldBatchCodeRepo,
	type FoldBatchDecision,
	type FoldBatchRoadmapItem,
	type FoldBatchSource,
	foldContextBatch,
	SYSTEM_GUIDANCE,
} from "@repo/ai/lib/context-summarization/summarize-project-context";
import {
	CODE_REPO_SOURCE_TYPE,
	CONTEXT_SUMMARY_ENGINE_VERSION,
	type ContextSourceReference,
	type ContextSummaryStats,
	checkpointContextSummaryProgress,
	countRawContextRows,
	DECISION_SOURCE_TYPE,
	DEFAULT_SOURCE_SELECTION,
	estimateTokensFromChars,
	fetchProjectContextBatch,
	getContextSummaryCheckpoint,
	getLatestCompletedContextSummary,
	getPromptByKey,
	listAcceptedDecisionsForSummary,
	listCodeReposForSummary,
	listRoadmapItemsForSummary,
	type Prisma,
	parseSourceSelection,
	parseSummaryReferences,
	parseSummaryStats,
	ROADMAP_SOURCE_TYPE,
	SOURCE_SELECTION_KEYS,
	type SourceSelection,
	type SummaryTenancy,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";

/** Prompts-DB key for the admin-editable summarization system guidance. */
const CONTEXT_SUMMARIZATION_PROMPT_KEY = "context_summarization";

/**
 * Resolve the fold's system prompt from the Prompts DB (admin-editable), falling
 * back to the built-in `SYSTEM_GUIDANCE`. Resolution never breaks the run — any
 * error or empty content keeps the built-in default.
 */
async function resolveSummarizationSystemPrompt(
	tenancy: SummaryTenancy,
): Promise<string> {
	try {
		const prompt = await getPromptByKey({
			key: CONTEXT_SUMMARIZATION_PROMPT_KEY,
			userId: tenancy.userId ?? undefined,
			organizationId: tenancy.organizationId ?? undefined,
		});
		const content = prompt?.versions[0]?.content?.trim();
		if (content) {
			return content;
		}
	} catch (error) {
		logger.warn(
			"[Context Summarization] system-prompt resolve failed; using built-in default",
			{ error: error instanceof Error ? error.message : String(error) },
		);
	}
	return SYSTEM_GUIDANCE;
}

/**
 * Raw-context characters fed to a single fold (one LLM call). Bounds per-call
 * cost/tokens; total coverage is unbounded across batches.
 */
const BATCH_CHAR_BUDGET = 120_000;

/**
 * Safety ceiling on batches per run. Far above any real project; if hit, the run
 * completes with an HONEST watermark (last folded source) and records
 * `incompleteCoverage` + a deferred count — never a summary that claims to cover
 * material it did not process. The next run continues from the true watermark.
 */
const MAX_BATCHES = 200;

export interface GenerateSummaryResult {
	content: string;
	tokenCount: number;
	model: string;
	references: ContextSourceReference[];
	/** ISO 8601 — the TRUE watermark (latest folded source, <= snapshot). */
	coveredThrough: string;
	coveredContextCount: number;
	stats: ContextSummaryStats;
	/** Real tokens/cost the run's folds consumed (summed across batches). */
	spentInputTokens: number;
	spentOutputTokens: number;
	spentCostMicroUsd: number;
}

/** Map a reference array into a marker-keyed registry. */
function toRegistry(
	refs: ContextSourceReference[],
): Map<string, ContextSourceReference> {
	return new Map(refs.map((r) => [r.marker, r]));
}

/** The run's working state, seeded once per run by `resolveInitialRunState`. */
export interface RunState {
	runningContent: string;
	registry: Map<string, ContextSourceReference>;
	markerSeq: number;
	cursorCreatedAt: Date | null;
	cursorId: string | null;
	processedCount: number;
	batchCount: number;
	firstProcessedAt: string | null;
	lastProcessedAt: string | null;
	inputChars: number;
	/** The cursor a fresh run starts from — anchors the eligible-source count. */
	baselineCursorCreatedAt: Date | null;
}

/**
 * Whether the prior COMPLETED summary is a trustworthy base for an INCREMENTAL run
 * (extend it) vs. requiring a FULL rebuild. It qualifies only when it is:
 *  - v2 (a trustworthy true watermark),
 *  - actually covered raw context (a context-excluded prior has no real context
 *    watermark, so extending would skip context before its bogus watermark), AND
 *  - used the SAME source selection as this run — otherwise inheriting its digest
 *    (built from a different source set) would mean deselecting a source wouldn't
 *    remove it and re-selecting one wouldn't add it.
 * A legacy null selection means "all sources / covered context".
 */
export function isTrustedIncrementalBase(
	prior: {
		engineVersion: number;
		sourceSelection: Prisma.JsonValue | null;
	} | null,
	selection: SourceSelection,
): boolean {
	if (!prior || prior.engineVersion < CONTEXT_SUMMARY_ENGINE_VERSION) {
		return false;
	}
	const priorSelection = parseSourceSelection(prior.sourceSelection);
	if (priorSelection.context === false) {
		return false;
	}
	return SOURCE_SELECTION_KEYS.every(
		(key) => priorSelection[key] === selection[key],
	);
}

/**
 * Seed the run's working state from one of three modes:
 *  - RESUME — an activity retry: continue from the GENERATING row's checkpoint.
 *  - INCREMENTAL — a fresh run atop a trustworthy (v2) prior summary: extend it
 *    from the prior's true watermark, carrying its digest + registry + counter.
 *  - FULL — first-ever summary, or a legacy/untrusted (v1) prior: rebuild from the
 *    oldest source (the old summary stays COMPLETED until this run supersedes it).
 */
export function resolveInitialRunState(args: {
	resuming: boolean;
	checkpoint: Awaited<ReturnType<typeof getContextSummaryCheckpoint>>;
	prior: Awaited<ReturnType<typeof getLatestCompletedContextSummary>>;
	priorStats: ContextSummaryStats | null;
	priorIsTrusted: boolean;
}): RunState {
	const { resuming, checkpoint, prior, priorStats, priorIsTrusted } = args;

	if (resuming && checkpoint?.stats) {
		return {
			runningContent: checkpoint.content,
			registry: toRegistry(checkpoint.references),
			markerSeq: checkpoint.stats.markerSeq,
			cursorCreatedAt: checkpoint.stats.cursorCreatedAt
				? new Date(checkpoint.stats.cursorCreatedAt)
				: null,
			cursorId: checkpoint.stats.cursorId,
			processedCount: checkpoint.stats.processedSourceCount,
			batchCount: checkpoint.stats.batchCount,
			firstProcessedAt: checkpoint.stats.firstProcessedAt,
			lastProcessedAt: checkpoint.stats.lastProcessedAt,
			inputChars: checkpoint.stats.inputChars,
			// The pre-run baseline cursor is lost on resume; approximate the
			// eligible count from firstProcessedAt (stats only, not correctness).
			baselineCursorCreatedAt: checkpoint.stats.firstProcessedAt
				? new Date(checkpoint.stats.firstProcessedAt)
				: null,
		};
	}

	if (priorIsTrusted && prior) {
		const registry = toRegistry(parseSummaryReferences(prior.references));
		const cursorCreatedAt = priorStats?.cursorCreatedAt
			? new Date(priorStats.cursorCreatedAt)
			: prior.coveredThrough;
		return {
			runningContent: prior.content,
			registry,
			markerSeq: priorStats?.markerSeq ?? registry.size,
			cursorCreatedAt,
			cursorId: priorStats?.cursorId ?? null,
			processedCount: 0,
			batchCount: 0,
			firstProcessedAt: null,
			lastProcessedAt: null,
			inputChars: 0,
			baselineCursorCreatedAt: cursorCreatedAt,
		};
	}

	return {
		runningContent: "",
		registry: new Map(),
		markerSeq: 0,
		cursorCreatedAt: null,
		cursorId: null,
		processedCount: 0,
		batchCount: 0,
		firstProcessedAt: null,
		lastProcessedAt: null,
		inputChars: 0,
		baselineCursorCreatedAt: null,
	};
}

/**
 * The run's one long activity: map-reduce compression over ALL eligible raw
 * context, chronologically, through as many bounded batches as required.
 *
 * Durable + incremental:
 *  - Fresh run with a trustworthy (v2) prior summary → INCREMENTAL: seed the
 *    running digest + reference registry + marker counter from the prior summary
 *    and fold only context created after its true watermark.
 *  - First-ever summary, or a legacy/untrusted (v1) prior → FULL rebuild from the
 *    oldest source (the legacy summary stays COMPLETED until this run supersedes
 *    it, so the reader never goes blank).
 *  - Activity retry → RESUME from the GENERATING row's checkpoint (keyset cursor
 *    + running digest + registry), so completed batches are never re-done.
 *
 * Every source carries a stable citation marker; only markers actually fed to the
 * model can survive into the digest (`foldContextBatch` strips the rest), and the
 * stored `references` are pruned to the markers the final digest cites.
 */
export async function generateSummaryActivity(input: {
	summaryId: string;
	projectId: string;
	projectName: string;
	tenancy: SummaryTenancy;
	snapshotThrough: string;
	/** Which source types to consider; omitted = all (backward compatible). */
	sourceSelection?: SourceSelection;
}): Promise<GenerateSummaryResult> {
	const { summaryId, projectId, projectName, tenancy } = input;
	const snapshotThrough = new Date(input.snapshotThrough);
	const selection = input.sourceSelection ?? DEFAULT_SOURCE_SELECTION;

	const systemPrompt = await resolveSummarizationSystemPrompt(tenancy);

	const prior = await getLatestCompletedContextSummary({
		projectId,
		userId: tenancy.userId,
		organizationId: tenancy.organizationId,
	});
	const priorIsTrusted = isTrustedIncrementalBase(prior, selection);
	const priorStats =
		priorIsTrusted && prior ? parseSummaryStats(prior.stats) : null;

	const checkpoint = await getContextSummaryCheckpoint(summaryId);
	const resuming =
		!!checkpoint?.stats &&
		(checkpoint.stats.batchCount > 0 ||
			checkpoint.stats.processedSourceCount > 0);

	const initial = resolveInitialRunState({
		resuming,
		checkpoint,
		prior,
		priorStats,
		priorIsTrusted,
	});
	// Fixed after seeding; anchors the eligible-source count for observability.
	const { baselineCursorCreatedAt } = initial;
	let {
		runningContent,
		registry,
		markerSeq,
		cursorCreatedAt,
		cursorId,
		processedCount,
		batchCount,
		firstProcessedAt,
		lastProcessedAt,
		inputChars,
	} = initial;

	// Decisions, roadmap items and code repos are project-level, non-time-windowed
	// ENRICHMENT sources — fold only the ones not already cited. Each is gathered
	// best-effort: the core map-reduce over raw context is the critical path, so a
	// failure to gather any one enrichment (e.g. a stale worker Prisma client
	// missing a newer field) is logged and skipped, never failing the whole run.
	const registrySourceIds = new Set(
		[...registry.values()].map((r) => r.sourceId),
	);
	const gatherOrEmpty = async <T>(
		label: string,
		fn: () => Promise<T[]>,
	): Promise<T[]> => {
		try {
			return await fn();
		} catch (error) {
			logger.warn(
				`[Context Summarization] ${label} gather failed (non-fatal; source skipped)`,
				{
					summaryId,
					projectId,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
			return [];
		}
	};
	// Only gather the ENRICHMENT sources the run selected. A deselected source is
	// simply not fetched, so it can't be folded or cited.
	const [allDecisions, allRoadmapItems, allCodeRepos] = await Promise.all([
		selection.decisions
			? gatherOrEmpty("decisions", () =>
					listAcceptedDecisionsForSummary({ projectId, tenancy }),
				)
			: Promise.resolve([]),
		selection.roadmap
			? gatherOrEmpty("roadmap", () =>
					listRoadmapItemsForSummary({ projectId, tenancy }),
				)
			: Promise.resolve([]),
		selection.codeRepo
			? gatherOrEmpty("code-repos", () =>
					listCodeReposForSummary({ projectId }),
				)
			: Promise.resolve([]),
	]);
	const newDecisions = allDecisions.filter(
		(d) => !registrySourceIds.has(d.id),
	);
	const newRoadmapItems = allRoadmapItems.filter(
		(r) => !registrySourceIds.has(r.id),
	);
	const newCodeRepos = allCodeRepos.filter(
		(r) => !registrySourceIds.has(r.id),
	);

	let model = prior?.model ?? "context-summarization";
	// Project-level enrichment (decisions/roadmap/repos) is folded on the run's
	// LAST fold, not the first: the registry is pruned to the newest digest's
	// citations after every fold, so anything folded early is ratcheted away over a
	// many-batch run. Folding it into the final digest keeps its citations alive.
	const hasEnrichment =
		newDecisions.length > 0 ||
		newRoadmapItems.length > 0 ||
		newCodeRepos.length > 0;
	let enrichmentFolded = false;
	let incompleteCoverage = false;
	let hasMore = true;

	// Real per-run spend, summed from each fold's usage report.
	let spentInputTokens = 0;
	let spentOutputTokens = 0;
	let spentCostMicroUsd = 0;

	// Total eligible raw-context rows planned for this run's scope — drives the
	// progress bar (percent ≈ processed / planned). Computed once up front over the
	// same window as the end-of-run eligible count. Zero when context is deselected.
	const plannedSourceCount = selection.context
		? await countRawContextRows({
				projectId,
				tenancy,
				gt: baselineCursorCreatedAt,
				lte: snapshotThrough,
			})
		: 0;

	// Project the live loop state into a ContextSummaryStats; the run-specific
	// eligible/deferred/incomplete fields are supplied per call site.
	const statsSnapshot = (extra: {
		eligibleSourceCount: number;
		deferredSourceCount: number;
		incompleteCoverage: boolean;
	}): ContextSummaryStats => ({
		eligibleSourceCount: extra.eligibleSourceCount,
		processedSourceCount: processedCount,
		deferredSourceCount: extra.deferredSourceCount,
		batchCount,
		inputChars,
		firstProcessedAt,
		lastProcessedAt,
		cursorId,
		cursorCreatedAt: cursorCreatedAt?.toISOString() ?? null,
		markerSeq,
		incompleteCoverage: extra.incompleteCoverage,
		plannedSourceCount,
	});

	while (hasMore) {
		if (batchCount >= MAX_BATCHES) {
			incompleteCoverage = true;
			break;
		}
		heartbeat(`context-summary ${summaryId} batch ${batchCount}`);

		// When raw context is deselected, never fetch it — the run folds only the
		// selected project-level enrichment in a single (last) fold, then ends.
		const batch = selection.context
			? await fetchProjectContextBatch({
					projectId,
					tenancy,
					snapshotThrough,
					afterCreatedAt: cursorCreatedAt,
					afterId: cursorId,
					maxChars: BATCH_CHAR_BUDGET,
				})
			: {
					sources: [],
					hasMore: false,
					lastCreatedAt: null,
					lastId: null,
				};

		// Fold the project-level enrichment on the run's LAST fold — the one after
		// which no more raw context remains (`!batch.hasMore`). A project with
		// context folds it into the final context batch; a project with no (more)
		// context folds it into an otherwise-empty final fold, so a project whose
		// only material is its decisions/roadmap/repos still produces a summary.
		// If the MAX_BATCHES cap is about to stop the run before that natural last
		// fold, fold it into this final allowed batch instead, so enrichment is
		// never silently dropped (the run is flagged incompleteCoverage regardless).
		const atBatchCap = batchCount >= MAX_BATCHES - 1;
		const foldEnrichmentNow =
			hasEnrichment &&
			!enrichmentFolded &&
			(!batch.hasMore || atBatchCap);
		if (batch.sources.length === 0 && !foldEnrichmentNow) {
			hasMore = false;
			break;
		}

		const batchSources: FoldBatchSource[] = [];
		const batchRefs: ContextSourceReference[] = [];
		for (const s of batch.sources) {
			markerSeq += 1;
			const marker = `S${markerSeq}`;
			batchSources.push({
				marker,
				type: s.type,
				timestamp: s.createdAt.toISOString(),
				label: s.label,
				content: s.content,
			});
			batchRefs.push({
				marker,
				sourceType: s.type,
				sourceId: s.id,
				sourceTimestamp: s.createdAt.toISOString(),
				label: s.label ?? undefined,
			});
		}

		const decisionsForFold: FoldBatchDecision[] = [];
		const roadmapForFold: FoldBatchRoadmapItem[] = [];
		const codeReposForFold: FoldBatchCodeRepo[] = [];
		const projectRefs: ContextSourceReference[] = [];
		if (foldEnrichmentNow) {
			for (const d of newDecisions) {
				markerSeq += 1;
				const marker = `S${markerSeq}`;
				decisionsForFold.push({
					marker,
					title: d.title,
					decision: d.decision,
					rationale: d.rationale,
				});
				projectRefs.push({
					marker,
					sourceType: DECISION_SOURCE_TYPE,
					sourceId: d.id,
					sourceTimestamp: d.decisionDate.toISOString(),
					label: d.title,
				});
			}
			for (const repo of newCodeRepos) {
				markerSeq += 1;
				const marker = `S${markerSeq}`;
				codeReposForFold.push({
					marker,
					label: repo.label,
					url: repo.url ?? undefined,
					provider: repo.provider,
					branch: repo.branch ?? undefined,
					language: repo.language ?? undefined,
					analysis: repo.analysis ?? undefined,
				});
				projectRefs.push({
					marker,
					sourceType: CODE_REPO_SOURCE_TYPE,
					sourceId: repo.id,
					sourceTimestamp: repo.updatedAt.toISOString(),
					label: repo.label,
				});
			}
			for (const item of newRoadmapItems) {
				markerSeq += 1;
				const marker = `S${markerSeq}`;
				roadmapForFold.push({
					marker,
					title: item.title,
					kind: item.kind,
					status: item.status,
					priority: item.priority,
				});
				projectRefs.push({
					marker,
					sourceType: ROADMAP_SOURCE_TYPE,
					sourceId: item.id,
					sourceTimestamp: item.activityAt.toISOString(),
					label: `${item.identifier} ${item.title}`,
				});
			}
		}

		const carriedReferences = [...registry.values()];
		const candidateRefs = new Map<string, ContextSourceReference>(registry);
		for (const r of batchRefs) {
			candidateRefs.set(r.marker, r);
		}
		for (const r of projectRefs) {
			candidateRefs.set(r.marker, r);
		}

		const fold = await foldContextBatch({
			projectName,
			projectId,
			tenancy,
			systemPrompt,
			runningSummary: runningContent || null,
			batchSources,
			carriedReferences,
			decisions: decisionsForFold,
			roadmapItems: roadmapForFold,
			codeRepos: codeReposForFold,
			includeProjectSources: foldEnrichmentNow,
		});
		if (foldEnrichmentNow) {
			enrichmentFolded = true;
		}
		spentInputTokens += fold.usage.inputTokens;
		spentOutputTokens += fold.usage.outputTokens;
		spentCostMicroUsd += fold.usage.costMicroUsd;

		// Prune the registry to exactly the markers the new digest cites.
		const nextRegistry = new Map<string, ContextSourceReference>();
		for (const marker of fold.citedMarkers) {
			const ref = candidateRefs.get(marker);
			if (ref) {
				nextRegistry.set(marker, ref);
			}
		}

		model = fold.model;
		// An occasional empty model response must NOT wipe the digest built so far.
		// Each fold overwrites the running digest, and enrichment is the LAST fold —
		// so one empty response on the final fold would otherwise discard the whole
		// summary (the empty-digest guard below would then fail the run rather than
		// let it degrade). Keep the prior content + registry and treat this batch as
		// contributing nothing; its sources stay uncited and a later run re-attempts
		// them. A genuinely empty project folds nothing here and still ends empty.
		if (fold.content.trim().length > 0) {
			runningContent = fold.content;
			registry = nextRegistry;
		} else {
			logger.warn(
				"[Context Summarization] fold produced empty content; keeping prior digest",
				{ summaryId, projectId, batchIndex: batchCount },
			);
		}
		// Only advance the raw-context cursor/counters when this fold actually
		// consumed context rows (the enrichment fold may carry only project sources).
		if (batch.sources.length > 0) {
			cursorCreatedAt = batch.lastCreatedAt;
			cursorId = batch.lastId;
			processedCount += batch.sources.length;
			inputChars += batch.sources.reduce(
				(sum, s) => sum + s.content.length,
				0,
			);
			firstProcessedAt =
				firstProcessedAt ?? batch.sources[0].createdAt.toISOString();
			lastProcessedAt =
				batch.lastCreatedAt?.toISOString() ?? lastProcessedAt;
		}
		batchCount += 1;
		hasMore = batch.hasMore;

		await checkpointContextSummaryProgress({
			id: summaryId,
			content: runningContent,
			references: [...registry.values()],
			coveredContextCount: processedCount,
			stats: statsSnapshot({
				eligibleSourceCount: processedCount,
				deferredSourceCount: 0,
				incompleteCoverage: false,
			}),
		});
	}

	// A run that folded at least one source but produced an EMPTY digest is a failed
	// generation (e.g. the model returned nothing) — NOT a valid summary. Throwing
	// routes to the workflow's failure boundary so the prior COMPLETED summary is
	// left intact rather than being superseded by an empty one. (A genuinely empty
	// project folds nothing — batchCount 0 — and completes with empty content.)
	if (batchCount > 0 && runningContent.trim().length === 0) {
		throw new Error(
			`Summarization produced an empty digest after folding ${batchCount} batch(es); refusing to supersede the prior summary.`,
		);
	}

	// The TRUE watermark: latest folded source. If this run folded nothing, keep
	// the incremental baseline (prior watermark), or the snapshot for a full
	// rebuild of an empty project (all zero eligible sources are covered).
	const coveredThrough = lastProcessedAt
		? new Date(lastProcessedAt)
		: priorIsTrusted && prior
			? prior.coveredThrough
			: snapshotThrough;

	const [coveredContextCount, deferredSourceCount, eligibleSourceCount] =
		await Promise.all([
			countRawContextRows({ projectId, tenancy, lte: coveredThrough }),
			countRawContextRows({ projectId, tenancy, gt: snapshotThrough }),
			countRawContextRows({
				projectId,
				tenancy,
				gt: baselineCursorCreatedAt,
				lte: snapshotThrough,
			}),
		]);

	const references = [...registry.values()];
	const stats = statsSnapshot({
		eligibleSourceCount,
		deferredSourceCount,
		incompleteCoverage,
	});

	logger.info("[Context Summarization] generation complete", {
		summaryId,
		projectId,
		engineVersion: CONTEXT_SUMMARY_ENGINE_VERSION,
		mode: resuming ? "RESUME" : priorIsTrusted ? "INCREMENTAL" : "FULL",
		eligibleSourceCount,
		processedSourceCount: processedCount,
		batchCount,
		inputChars,
		firstProcessedAt,
		lastProcessedAt,
		coveredThrough: coveredThrough.toISOString(),
		coveredContextCount,
		deferredSourceCount,
		referenceCount: references.length,
		incompleteCoverage,
	});

	return {
		content: runningContent,
		tokenCount: estimateTokensFromChars(runningContent.length),
		model,
		references,
		coveredThrough: coveredThrough.toISOString(),
		coveredContextCount,
		stats,
		spentInputTokens,
		spentOutputTokens,
		spentCostMicroUsd,
	};
}
