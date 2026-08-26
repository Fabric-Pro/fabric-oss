import { db } from "../client";
import type { AiOutcomeKind } from "../generated/client";

/**
 * Model- and prompt-level segmentation for the platform-admin AI Adoption
 * dashboard (Fizzy #2230, Phase 3). This is the half of the feature that
 * answers the original question — "did acceptance move when we changed the
 * model or the prompt?" — which needs the Phase 1 invocation tags and the
 * Phase 2 outcome events together.
 *
 * All reads are admin-gated aggregates; keep them to single passes.
 */

const MAX_PERIOD_DAYS = 365;
/** Below this many observations a rate is too noisy to act on. */
export const AI_SEGMENT_MIN_SAMPLE = 30;

export interface AiSegmentationRange {
	from: Date;
	to: Date;
}

function clampRange({ from, to }: AiSegmentationRange): AiSegmentationRange {
	const maxSpanMs = MAX_PERIOD_DAYS * 24 * 60 * 60 * 1000;
	return {
		from:
			to.getTime() - from.getTime() > maxSpanMs
				? new Date(to.getTime() - maxSpanMs)
				: from,
		to,
	};
}

/**
 * Synthetic key for embedding calls. They resolve through
 * `getAIEmbeddingModel`, a different path from the language-model one that
 * carries `featureKey`, so they can never be tagged — and on a busy instance
 * they are the MAJORITY of rows (RAG indexing). Folding them into the null
 * bucket would report three-quarters of traffic as "not tagged yet", which
 * reads as a coverage gap someone should close rather than what it is:
 * infrastructure that is deliberately outside feature adoption.
 */
export const AI_EMBEDDINGS_FEATURE_KEY = "__embeddings__";

export interface AiFeatureUsageRow {
	/**
	 * Null means a language-model call site that is not tagged yet — a real
	 * coverage gap. AI_EMBEDDINGS_FEATURE_KEY means embeddings, which are
	 * untaggable by construction.
	 */
	featureKey: string | null;
	requests: number;
	failedRequests: number;
	totalTokens: number;
	costMicroUsd: number;
}

/**
 * Per-feature LLM volume and cost. The null bucket is preserved on purpose:
 * hiding it would make tagged features look like the whole picture while tag
 * coverage is still growing.
 */
export async function getAiUsageByFeature(
	range: AiSegmentationRange,
): Promise<AiFeatureUsageRow[]> {
	const { from, to } = clampRange(range);

	const groups = await db.aiUsageLog.groupBy({
		by: ["featureKey", "success", "taskType"],
		where: { createdAt: { gte: from, lte: to } },
		_count: { _all: true },
		_sum: { totalTokens: true, costMicroUsd: true },
	});

	const byFeature = new Map<string | null, AiFeatureUsageRow>();
	for (const group of groups) {
		const key =
			group.featureKey ??
			(group.taskType === "EMBEDDING" ? AI_EMBEDDINGS_FEATURE_KEY : null);
		let row = byFeature.get(key);
		if (!row) {
			row = {
				featureKey: key,
				requests: 0,
				failedRequests: 0,
				totalTokens: 0,
				costMicroUsd: 0,
			};
			byFeature.set(key, row);
		}
		row.requests += group._count._all;
		row.totalTokens += group._sum.totalTokens ?? 0;
		row.costMicroUsd += group._sum.costMicroUsd ?? 0;
		if (!group.success) {
			row.failedRequests += group._count._all;
		}
	}

	return Array.from(byFeature.values()).sort(
		(a, b) => b.requests - a.requests,
	);
}

export interface AiOutcomeSegment {
	/** Null when the outcome was recorded without a model snapshot. */
	modelCanonicalName: string | null;
	/** Null when the producing call had no resolved prompt version. */
	promptVersionId: string | null;
	featureKey: string;
	counts: Record<AiOutcomeKind, number>;
	total: number;
	/**
	 * Share of decided outcomes that were positive, 0-100, or null when the
	 * segment has no decided outcomes at all. Callers must show `total`
	 * alongside this and suppress segments under AI_SEGMENT_MIN_SAMPLE.
	 */
	acceptanceRate: number | null;
	/** Outcomes that express a verdict (excludes nothing today; kept explicit). */
	decided: number;
}

const EMPTY_COUNTS: Record<AiOutcomeKind, number> = {
	ACCEPTED_AS_IS: 0,
	ACCEPTED_WITH_EDITS: 0,
	REJECTED: 0,
	RATED_UP: 0,
	RATED_DOWN: 0,
};

/**
 * Which outcomes count as the human being satisfied. ACCEPTED_WITH_EDITS is
 * deliberately positive: the AI still did the work, the human refined it —
 * treating an edit as a failure would understate a feature that saves effort
 * without producing final copy.
 */
const POSITIVE: AiOutcomeKind[] = [
	"ACCEPTED_AS_IS",
	"ACCEPTED_WITH_EDITS",
	"RATED_UP",
];

/**
 * Acceptance segmented by the model and prompt version that produced the
 * output. This is the comparison the whole feature exists for, so it reads the
 * SNAPSHOT columns on the outcome row rather than resolving today's binding —
 * see the note on AiOutcomeEvent.
 */
export async function getAiOutcomeSegments(
	range: AiSegmentationRange,
): Promise<AiOutcomeSegment[]> {
	const { from, to } = clampRange(range);

	const groups = await db.aiOutcomeEvent.groupBy({
		by: ["modelCanonicalName", "promptVersionId", "featureKey", "outcome"],
		where: { createdAt: { gte: from, lte: to } },
		_count: { _all: true },
	});

	const segments = new Map<string, AiOutcomeSegment>();
	for (const group of groups) {
		const key = `${group.modelCanonicalName ?? ""}|${group.promptVersionId ?? ""}|${group.featureKey}`;
		let segment = segments.get(key);
		if (!segment) {
			segment = {
				modelCanonicalName: group.modelCanonicalName,
				promptVersionId: group.promptVersionId,
				featureKey: group.featureKey,
				counts: { ...EMPTY_COUNTS },
				total: 0,
				acceptanceRate: null,
				decided: 0,
			};
			segments.set(key, segment);
		}
		segment.counts[group.outcome] += group._count._all;
		segment.total += group._count._all;
	}

	for (const segment of segments.values()) {
		const positive = POSITIVE.reduce(
			(sum, kind) => sum + segment.counts[kind],
			0,
		);
		segment.decided = segment.total;
		segment.acceptanceRate =
			segment.decided === 0
				? null
				: Math.round((positive / segment.decided) * 100);
	}

	return Array.from(segments.values()).sort((a, b) => b.total - a.total);
}

export type AiChangeAnnotationKind = "PROMPT_VERSION" | "MODEL_DEFAULT";

export interface AiChangeAnnotation {
	kind: AiChangeAnnotationKind;
	/** UTC day the change landed, YYYY-MM-DD — the axis key on the chart. */
	date: string;
	/** Short human label, e.g. `feature_clean_spec_generator v4`. */
	label: string;
	/** The author's change note, when they left one. */
	detail: string | null;
}

/**
 * Timeline markers for "what changed, and when" so an acceptance-rate movement
 * can be read against the change that plausibly caused it.
 *
 * Two sources, with DIFFERENT fidelity — the UI must not imply otherwise:
 * - PromptVersion.createdAt is a real history: every version ever published
 *   has its own row and date.
 * - AiTaskModelDefault.updatedAt is only the LATEST change to each task
 *   default. There is no history table, so an earlier model swap leaves no
 *   trace once a later one overwrites the row.
 */
export async function getAiChangeAnnotations(
	range: AiSegmentationRange,
): Promise<AiChangeAnnotation[]> {
	const { from, to } = clampRange(range);
	const window = { gte: from, lte: to };

	const [promptVersions, modelDefaults] = await Promise.all([
		db.promptVersion.findMany({
			where: { createdAt: window },
			select: {
				version: true,
				createdAt: true,
				changeNote: true,
				prompt: { select: { key: true } },
			},
			orderBy: { createdAt: "asc" },
			take: 200,
		}),
		db.aiTaskModelDefault.findMany({
			where: { updatedAt: window },
			select: {
				taskType: true,
				complexity: true,
				updatedAt: true,
				model: { select: { canonicalName: true } },
			},
			orderBy: { updatedAt: "asc" },
			take: 200,
		}),
	]);

	const annotations: AiChangeAnnotation[] = [
		...promptVersions.map((row) => ({
			kind: "PROMPT_VERSION" as const,
			date: row.createdAt.toISOString().slice(0, 10),
			label: `${row.prompt.key} v${row.version}`,
			detail: row.changeNote,
		})),
		...modelDefaults.map((row) => ({
			kind: "MODEL_DEFAULT" as const,
			date: row.updatedAt.toISOString().slice(0, 10),
			label: `${row.taskType}/${row.complexity} → ${row.model.canonicalName}`,
			detail: null,
		})),
	];

	return annotations.sort((a, b) => a.date.localeCompare(b.date));
}
