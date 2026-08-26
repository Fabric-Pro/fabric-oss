/**
 * Queries for ProjectContextSummary — compressed project-history summaries.
 *
 * Callers: the summarization workflow/activities (Temporal), the auto-trigger
 * cron watchdog, the manual-trigger API, and the RAG read path. Every caller
 * passes tenancy explicitly; the table is USER_OWNED (mirrors project_context),
 * so writes copy the project's XOR tenancy verbatim and reads scope by it.
 *
 * The engine is map-reduce (v2): a run processes ALL eligible raw context
 * chronologically through bounded batches (see `fetchProjectContextBatch`),
 * folding each into a running digest and accumulating source-level references.
 * `coveredThrough` is the TRUE watermark — the timestamp of the latest source
 * actually folded — never the run's wall-clock start. Legacy (v1) summaries
 * carry an untrustworthy run-start watermark and no references; the RAG path
 * treats them as additive-only and the cron rebuilds them.
 */

import {
	type ContextSummaryTrigger,
	db,
	type Prisma,
	type ProjectContextSummary,
} from "../client";

/** Project XOR tenancy, copied verbatim from the parent Project. */
export type SummaryTenancy = {
	userId: string | null;
	organizationId: string | null;
};

/**
 * The current summarization engine version. Bumped whenever the coverage
 * contract changes in a way that makes older summaries' watermarks/references
 * untrustworthy. v1 = legacy single-shot (run-start watermark, no references);
 * v2 = map-reduce (whole-history coverage, true watermark, references).
 */
export const CONTEXT_SUMMARY_ENGINE_VERSION = 2;

/** Synthetic source type for an ACCEPTED architecture decision reference. */
export const DECISION_SOURCE_TYPE = "DECISION";
/** Synthetic source type for a roadmap item (Feature/Epic/Bug) reference. */
export const ROADMAP_SOURCE_TYPE = "ROADMAP";
/** Synthetic source type for a connected code repository reference. */
export const CODE_REPO_SOURCE_TYPE = "CODE_REPO";

/**
 * A source cited by a summary, resolvable back to its original raw context or
 * decision. Only references WE assign (marker → real DB id) are ever stored, so
 * a hallucinated id is structurally impossible; the resolver additionally
 * re-checks project + tenant ownership at read time.
 */
export type ContextSourceReference = {
	/** Stable citation marker, unique within one summary, e.g. "S12". */
	marker: string;
	/** ProjectContextType value (e.g. "TEXT", "LINK", "FILE") or "DECISION". */
	sourceType: string;
	/** The real ProjectContext.id / ArchitectureDecision.id. */
	sourceId: string;
	/** ISO 8601 — the source's createdAt / decisionDate. */
	sourceTimestamp: string;
	/** Human label (sourceTitle / filename / decision title / first line). */
	label?: string;
};

/** Per-run observability metrics + resume checkpoint persisted on the row. */
export type ContextSummaryStats = {
	eligibleSourceCount: number;
	processedSourceCount: number;
	deferredSourceCount: number;
	batchCount: number;
	inputChars: number;
	firstProcessedAt: string | null;
	lastProcessedAt: string | null;
	/** Keyset cursor of the last processed source (for idempotent resume). */
	cursorId: string | null;
	cursorCreatedAt: string | null;
	/** Monotonic marker counter so markers never collide across batches. */
	markerSeq: number;
	/** True when a safety cap stopped a run before all eligible sources. */
	incompleteCoverage: boolean;
	/**
	 * Total eligible raw-context rows planned at run start (for this run's mode
	 * scope). Drives the progress bar: percent ≈ processedSourceCount /
	 * plannedSourceCount. Null on legacy rows / until the first checkpoint.
	 */
	plannedSourceCount?: number | null;
};

/**
 * Which source types a run considered. Each key defaults to `true` (all sources
 * on). A null `sourceSelection` column means "all sources" (legacy rows). At
 * least one must be enabled — enforced at the API boundary.
 */
export type SourceSelection = {
	context: boolean;
	decisions: boolean;
	roadmap: boolean;
	codeRepo: boolean;
};

/** The source-selection keys, in display order. */
export const SOURCE_SELECTION_KEYS = [
	"context",
	"decisions",
	"roadmap",
	"codeRepo",
] as const;

/** Default selection: every source considered. */
export const DEFAULT_SOURCE_SELECTION: SourceSelection = {
	context: true,
	decisions: true,
	roadmap: true,
	codeRepo: true,
};

/**
 * Parse the `sourceSelection` JSON column. A null/absent value (legacy rows, or a
 * run that predates the control) means "all sources on".
 */
export function parseSourceSelection(
	value: Prisma.JsonValue | null | undefined,
): SourceSelection {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { ...DEFAULT_SOURCE_SELECTION };
	}
	const s = value as Record<string, unknown>;
	// A missing key defaults to on, so an older payload lacking a newer source key
	// still includes it.
	const on = (v: unknown) => v !== false;
	return {
		context: on(s.context),
		decisions: on(s.decisions),
		roadmap: on(s.roadmap),
		codeRepo: on(s.codeRepo),
	};
}

/**
 * Heuristic token estimate (~4 chars/token). ProjectContext has no persisted
 * token field, so summarization thresholds estimate from character volume at
 * check time rather than adding a column to every context row.
 */
export function estimateTokensFromChars(chars: number): number {
	return Math.ceil(chars / 4);
}

/** Parse the `references` JSON column into a typed array (empty when absent). */
export function parseSummaryReferences(
	value: Prisma.JsonValue | null | undefined,
): ContextSourceReference[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const refs: ContextSourceReference[] = [];
	for (const entry of value) {
		if (
			entry &&
			typeof entry === "object" &&
			!Array.isArray(entry) &&
			typeof (entry as Record<string, unknown>).marker === "string" &&
			typeof (entry as Record<string, unknown>).sourceId === "string"
		) {
			const e = entry as Record<string, unknown>;
			refs.push({
				marker: e.marker as string,
				sourceType: String(e.sourceType ?? ""),
				sourceId: e.sourceId as string,
				sourceTimestamp: String(e.sourceTimestamp ?? ""),
				label: typeof e.label === "string" ? e.label : undefined,
			});
		}
	}
	return refs;
}

/** Parse the `stats` JSON column, or null when absent/malformed. */
export function parseSummaryStats(
	value: Prisma.JsonValue | null | undefined,
): ContextSummaryStats | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const s = value as Record<string, unknown>;
	const num = (v: unknown, d = 0) => (typeof v === "number" ? v : d);
	return {
		eligibleSourceCount: num(s.eligibleSourceCount),
		processedSourceCount: num(s.processedSourceCount),
		deferredSourceCount: num(s.deferredSourceCount),
		batchCount: num(s.batchCount),
		inputChars: num(s.inputChars),
		firstProcessedAt:
			typeof s.firstProcessedAt === "string" ? s.firstProcessedAt : null,
		lastProcessedAt:
			typeof s.lastProcessedAt === "string" ? s.lastProcessedAt : null,
		cursorId: typeof s.cursorId === "string" ? s.cursorId : null,
		cursorCreatedAt:
			typeof s.cursorCreatedAt === "string" ? s.cursorCreatedAt : null,
		markerSeq: num(s.markerSeq),
		incompleteCoverage: s.incompleteCoverage === true,
	};
}

/** USER_OWNED read filter for a summary: org sees org rows, personal sees own. */
function summaryTenantWhere(tenancy: {
	userId?: string | null;
	organizationId?: string | null;
}): { organizationId: string } | { userId: string; organizationId: null } {
	return tenancy.organizationId
		? { organizationId: tenancy.organizationId }
		: { userId: tenancy.userId ?? "", organizationId: null };
}

/** XOR tenant filter for the raw project_context / decision rows themselves. */
function sourceTenantWhere(tenancy: SummaryTenancy) {
	return tenancy.organizationId
		? { organizationId: tenancy.organizationId }
		: { userId: tenancy.userId, organizationId: null };
}

// ─────────────────────────────── Writes ────────────────────────────────────

/** Create the PENDING row that a summarization run fills in. */
export async function createPendingContextSummary(input: {
	projectId: string;
	tenancy: SummaryTenancy;
	trigger: ContextSummaryTrigger;
	triggeredByUserId?: string | null;
	/** The stable high-water snapshot captured at run start. */
	snapshotThrough: Date;
	/** Which sources to consider; omitted = all (remembered for history). */
	sourceSelection?: SourceSelection;
}): Promise<ProjectContextSummary> {
	const selection = input.sourceSelection ?? DEFAULT_SOURCE_SELECTION;
	return db.projectContextSummary.create({
		data: {
			projectId: input.projectId,
			organizationId: input.tenancy.organizationId ?? null,
			userId: input.tenancy.organizationId ? null : input.tenancy.userId,
			trigger: input.trigger,
			triggeredByUserId: input.triggeredByUserId ?? null,
			status: "PENDING",
			content: "",
			// coveredThrough is required (non-null); seed it with the snapshot as a
			// placeholder — it is overwritten with the TRUE watermark at completion,
			// and PENDING/GENERATING rows are never read by RAG.
			coveredThrough: input.snapshotThrough,
			snapshotThrough: input.snapshotThrough,
			engineVersion: CONTEXT_SUMMARY_ENGINE_VERSION,
			sourceSelection: selection as unknown as Prisma.InputJsonValue,
		},
	});
}

export async function markContextSummaryGenerating(id: string): Promise<void> {
	await db.projectContextSummary.update({
		where: { id },
		data: { status: "GENERATING" },
	});
}

/**
 * Persist an in-flight run's progress on the GENERATING row so a retry can resume
 * from the keyset cursor instead of restarting, and so observability reflects
 * partial coverage. Idempotent: safe to call once per completed batch.
 */
export async function checkpointContextSummaryProgress(input: {
	id: string;
	content: string;
	references: ContextSourceReference[];
	coveredContextCount: number;
	stats: ContextSummaryStats;
}): Promise<void> {
	await db.projectContextSummary.update({
		where: { id: input.id },
		data: {
			content: input.content,
			references: input.references as unknown as Prisma.InputJsonValue,
			coveredContextCount: input.coveredContextCount,
			stats: input.stats as unknown as Prisma.InputJsonValue,
		},
	});
}

/** The running-progress checkpoint for a summary row (for idempotent resume). */
export async function getContextSummaryCheckpoint(id: string): Promise<{
	content: string;
	references: ContextSourceReference[];
	stats: ContextSummaryStats | null;
	coveredContextCount: number;
} | null> {
	const row = await db.projectContextSummary.findUnique({
		where: { id },
		select: {
			content: true,
			references: true,
			stats: true,
			coveredContextCount: true,
		},
	});
	if (!row) {
		return null;
	}
	return {
		content: row.content,
		references: parseSummaryReferences(row.references),
		stats: parseSummaryStats(row.stats),
		coveredContextCount: row.coveredContextCount,
	};
}

/**
 * Persist a successful summary and supersede the project's prior COMPLETED
 * summary (soft pointer; the old row is retained, not deleted). Runs in a
 * transaction so retrieval never sees two "current" summaries. Writes the TRUE
 * `coveredThrough` watermark (the latest folded source), the reference registry,
 * the engine version, and the observability stats.
 */
export async function completeContextSummary(input: {
	id: string;
	content: string;
	tokenCount: number;
	coveredContextCount: number;
	coveredThrough: Date;
	model: string;
	references: ContextSourceReference[];
	stats: ContextSummaryStats;
	/** Real tokens consumed by the run's fold calls (not the digest size). */
	spentInputTokens?: number | null;
	spentOutputTokens?: number | null;
	spentCostMicroUsd?: bigint | null;
}): Promise<void> {
	const row = await db.projectContextSummary.findUnique({
		where: { id: input.id },
		select: { projectId: true, userId: true, organizationId: true },
	});
	if (!row) {
		return;
	}
	await db.$transaction(async (tx) => {
		const prior = await tx.projectContextSummary.findFirst({
			where: {
				projectId: row.projectId,
				status: "COMPLETED",
				supersededById: null,
				id: { not: input.id },
				...summaryTenantWhere(row),
			},
			orderBy: { createdAt: "desc" },
			select: { id: true },
		});
		await tx.projectContextSummary.update({
			where: { id: input.id },
			data: {
				status: "COMPLETED",
				content: input.content,
				tokenCount: input.tokenCount,
				coveredContextCount: input.coveredContextCount,
				coveredThrough: input.coveredThrough,
				model: input.model,
				references:
					input.references as unknown as Prisma.InputJsonValue,
				stats: input.stats as unknown as Prisma.InputJsonValue,
				engineVersion: CONTEXT_SUMMARY_ENGINE_VERSION,
				spentInputTokens: input.spentInputTokens ?? null,
				spentOutputTokens: input.spentOutputTokens ?? null,
				spentCostMicroUsd: input.spentCostMicroUsd ?? null,
				error: null,
			},
		});
		if (prior) {
			await tx.projectContextSummary.update({
				where: { id: prior.id },
				data: { supersededById: input.id },
			});
		}
	});
}

export async function failContextSummary(input: {
	id: string;
	error: string;
}): Promise<void> {
	await db.projectContextSummary.update({
		where: { id: input.id },
		data: { status: "FAILED", error: input.error.slice(0, 2000) },
	});
}

/**
 * Mark a still-running summary CANCELLED (user-requested). Only PENDING/GENERATING
 * rows flip — a run that already reached a terminal state is left untouched, so a
 * cancel that races completion never clobbers a good summary. A cancelled run never
 * supersedes the prior COMPLETED summary. Returns whether a row was cancelled.
 */
export async function cancelContextSummary(id: string): Promise<boolean> {
	const res = await db.projectContextSummary.updateMany({
		where: { id, status: { in: ["PENDING", "GENERATING"] } },
		data: { status: "CANCELLED", error: "Cancelled by user." },
	});
	return res.count > 0;
}

export async function setContextSummaryEmbedding(input: {
	id: string;
	qdrantId: string;
}): Promise<void> {
	await db.projectContextSummary.update({
		where: { id: input.id },
		data: { qdrantId: input.qdrantId, embeddedAt: new Date() },
	});
}

// ─────────────────────────────── Reads ─────────────────────────────────────

/** The project's current (non-superseded) COMPLETED summary, or null. */
export async function getLatestCompletedContextSummary(input: {
	projectId: string;
	userId?: string | null;
	organizationId?: string | null;
}): Promise<ProjectContextSummary | null> {
	return db.projectContextSummary.findFirst({
		where: {
			projectId: input.projectId,
			status: "COMPLETED",
			supersededById: null,
			...summaryTenantWhere(input),
		},
		orderBy: { createdAt: "desc" },
	});
}

/** A PENDING or GENERATING summary for the project, if a run is already active. */
export async function getInProgressContextSummary(input: {
	projectId: string;
	userId?: string | null;
	organizationId?: string | null;
}): Promise<ProjectContextSummary | null> {
	return db.projectContextSummary.findFirst({
		where: {
			projectId: input.projectId,
			status: { in: ["PENDING", "GENERATING"] },
			...summaryTenantWhere(input),
		},
		orderBy: { createdAt: "desc" },
	});
}

export async function getContextSummaryById(input: {
	id: string;
	userId?: string | null;
	organizationId?: string | null;
}): Promise<ProjectContextSummary | null> {
	return db.projectContextSummary.findFirst({
		where: { id: input.id, ...summaryTenantWhere(input) },
	});
}

/** Summary history for a project (newest first) — powers the admin UI. */
export async function listContextSummaries(input: {
	projectId: string;
	userId?: string | null;
	organizationId?: string | null;
	take?: number;
}): Promise<ProjectContextSummary[]> {
	return db.projectContextSummary.findMany({
		where: { projectId: input.projectId, ...summaryTenantWhere(input) },
		orderBy: { createdAt: "desc" },
		take: input.take ?? 20,
	});
}

/**
 * Insert a new COMPLETED, user-authored summary that becomes the current head of
 * the superseded chain (a new history entry with no LLM spend). Shared by manual
 * edit and version restore. Provenance (watermark, snapshot, covered count, source
 * selection, model) is inherited from `base` so RAG's drop-window is unchanged;
 * content + references are the caller's. Runs in a transaction so retrieval never
 * sees two current summaries.
 */
async function insertManualSummary(input: {
	projectId: string;
	tenancy: SummaryTenancy;
	editedByUserId: string | null;
	content: string;
	references: ContextSourceReference[];
	base: {
		coveredThrough: Date;
		snapshotThrough: Date | null;
		coveredContextCount: number;
		sourceSelection: Prisma.JsonValue | null;
		model: string | null;
		trigger: ContextSummaryTrigger;
	};
}): Promise<ProjectContextSummary> {
	const { tenancy, base } = input;
	return db.$transaction(async (tx) => {
		const created = await tx.projectContextSummary.create({
			data: {
				projectId: input.projectId,
				organizationId: tenancy.organizationId ?? null,
				userId: tenancy.organizationId ? null : tenancy.userId,
				status: "COMPLETED",
				trigger: base.trigger,
				manualEdit: true,
				editedByUserId: input.editedByUserId,
				content: input.content,
				references:
					input.references as unknown as Prisma.InputJsonValue,
				tokenCount: estimateTokensFromChars(input.content.length),
				coveredThrough: base.coveredThrough,
				snapshotThrough: base.snapshotThrough,
				coveredContextCount: base.coveredContextCount,
				sourceSelection:
					base.sourceSelection == null
						? undefined
						: (base.sourceSelection as Prisma.InputJsonValue),
				model: base.model,
				engineVersion: CONTEXT_SUMMARY_ENGINE_VERSION,
			},
		});
		const prior = await tx.projectContextSummary.findFirst({
			where: {
				projectId: input.projectId,
				status: "COMPLETED",
				supersededById: null,
				id: { not: created.id },
				...summaryTenantWhere(tenancy),
			},
			orderBy: { createdAt: "desc" },
			select: { id: true },
		});
		if (prior) {
			await tx.projectContextSummary.update({
				where: { id: prior.id },
				data: { supersededById: created.id },
			});
		}
		return created;
	});
}

/**
 * Persist a manual edit: a new current summary whose content + references were
 * authored by the user. `baseSummaryId` must be the current non-superseded
 * COMPLETED row for the project+tenant (provenance is inherited from it). Returns
 * null when the base can't be found under the caller's tenancy.
 */
export async function createManualEditSummary(input: {
	projectId: string;
	tenancy: SummaryTenancy;
	editedByUserId: string | null;
	baseSummaryId: string;
	content: string;
	references: ContextSourceReference[];
}): Promise<ProjectContextSummary | null> {
	const base = await db.projectContextSummary.findFirst({
		where: {
			id: input.baseSummaryId,
			projectId: input.projectId,
			status: "COMPLETED",
			supersededById: null,
			...summaryTenantWhere(input.tenancy),
		},
		select: {
			coveredThrough: true,
			snapshotThrough: true,
			coveredContextCount: true,
			sourceSelection: true,
			model: true,
			trigger: true,
		},
	});
	if (!base) {
		return null;
	}
	return insertManualSummary({
		projectId: input.projectId,
		tenancy: input.tenancy,
		editedByUserId: input.editedByUserId,
		content: input.content,
		references: input.references,
		base,
	});
}

/**
 * Restore a historical version: create a new current summary copying that version's
 * content + references (and provenance), superseding the current head. Non-
 * destructive — the restored-from row stays in history. Returns null when the
 * version isn't found under the caller's tenancy.
 */
export async function restoreContextSummary(input: {
	projectId: string;
	tenancy: SummaryTenancy;
	restoredByUserId: string | null;
	versionId: string;
}): Promise<ProjectContextSummary | null> {
	const version = await db.projectContextSummary.findFirst({
		where: {
			id: input.versionId,
			projectId: input.projectId,
			...summaryTenantWhere(input.tenancy),
		},
		select: {
			content: true,
			references: true,
			coveredThrough: true,
			snapshotThrough: true,
			coveredContextCount: true,
			sourceSelection: true,
			model: true,
			trigger: true,
		},
	});
	if (!version) {
		return null;
	}
	return insertManualSummary({
		projectId: input.projectId,
		tenancy: input.tenancy,
		editedByUserId: input.restoredByUserId,
		content: version.content,
		references: parseSummaryReferences(version.references),
		base: version,
	});
}

/**
 * Total character volume of a project's raw context, optionally only rows
 * created after a watermark (the uncovered volume since the last summary).
 */
export async function countRawContextChars(input: {
	projectId: string;
	after?: Date | null;
}): Promise<number> {
	const rows = await db.projectContext.findMany({
		where: {
			projectId: input.projectId,
			...(input.after ? { createdAt: { gt: input.after } } : {}),
		},
		select: { content: true },
	});
	return rows.reduce((sum, r) => sum + (r.content?.length ?? 0), 0);
}

/**
 * Count of non-empty raw-context rows for a project within a tenancy, optionally
 * bounded by a created-at window. Used for eligible/deferred source counts.
 */
export async function countRawContextRows(input: {
	projectId: string;
	tenancy: SummaryTenancy;
	lte?: Date | null;
	gt?: Date | null;
}): Promise<number> {
	return db.projectContext.count({
		where: {
			projectId: input.projectId,
			content: { not: "" },
			...sourceTenantWhere(input.tenancy),
			...(input.lte || input.gt
				? {
						createdAt: {
							...(input.lte ? { lte: input.lte } : {}),
							...(input.gt ? { gt: input.gt } : {}),
						},
					}
				: {}),
		},
	});
}

/** A raw project-context source fed to one summarization batch. */
export type RawContextSource = {
	id: string;
	type: string;
	content: string;
	createdAt: Date;
	label: string | null;
};

const BATCH_MAX_ROWS = 1000;

/** Best available human label for a raw context row. */
function deriveSourceLabel(row: {
	sourceTitle: string | null;
	originalFilename: string | null;
	content: string;
}): string | null {
	const explicit = row.sourceTitle?.trim() || row.originalFilename?.trim();
	if (explicit) {
		return explicit.slice(0, 120);
	}
	const firstLine = row.content.split("\n", 1)[0]?.trim();
	return firstLine ? firstLine.slice(0, 120) : null;
}

/**
 * Fetch the next chronological batch of a project's raw context, keyset-paginated
 * and bounded by `maxChars`, for map-reduce summarization. Deterministic given a
 * fixed `snapshotThrough`: only rows created at or before the snapshot are
 * eligible (context created mid-run is deferred to the next run). Always returns
 * at least one row when any remain, so a single oversized row can never stall the
 * loop (the fold's model-input budget clips it).
 */
export async function fetchProjectContextBatch(input: {
	projectId: string;
	tenancy: SummaryTenancy;
	snapshotThrough: Date;
	afterCreatedAt: Date | null;
	afterId: string | null;
	maxChars: number;
	maxRows?: number;
}): Promise<{
	sources: RawContextSource[];
	hasMore: boolean;
	lastCreatedAt: Date | null;
	lastId: string | null;
}> {
	const rowLimit = input.maxRows ?? BATCH_MAX_ROWS;
	// Keyset cursor: strictly after (afterCreatedAt, afterId) in (createdAt, id)
	// order. When a cursor id isn't available (e.g. an incremental start seeded
	// only from a prior watermark) fall back to a strict `createdAt >` bound so
	// the batch never silently restarts from the oldest row.
	const cursorClause = input.afterCreatedAt
		? input.afterId
			? [
					{
						OR: [
							{ createdAt: { gt: input.afterCreatedAt } },
							{
								createdAt: input.afterCreatedAt,
								id: { gt: input.afterId },
							},
						],
					},
				]
			: [{ createdAt: { gt: input.afterCreatedAt } }]
		: [];
	const rows = await db.projectContext.findMany({
		where: {
			projectId: input.projectId,
			content: { not: "" },
			...sourceTenantWhere(input.tenancy),
			AND: [
				{ createdAt: { lte: input.snapshotThrough } },
				...cursorClause,
			],
		},
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		take: rowLimit,
		select: {
			id: true,
			type: true,
			content: true,
			createdAt: true,
			sourceTitle: true,
			originalFilename: true,
		},
	});

	const sources: RawContextSource[] = [];
	let chars = 0;
	for (const row of rows) {
		if (sources.length > 0 && chars + row.content.length > input.maxChars) {
			break;
		}
		sources.push({
			id: row.id,
			type: row.type,
			content: row.content,
			createdAt: row.createdAt,
			label: deriveSourceLabel(row),
		});
		chars += row.content.length;
	}

	const hasMore = rows.length === rowLimit || sources.length < rows.length;
	const last = sources.at(-1) ?? null;
	return {
		sources,
		hasMore,
		lastCreatedAt: last?.createdAt ?? null,
		lastId: last?.id ?? null,
	};
}

/** An ACCEPTED architecture decision surfaced as a citable summary source. */
export type ReferenceDecision = {
	id: string;
	title: string;
	decision: string;
	rationale: string;
	decisionDate: Date;
};

/**
 * The project's ACCEPTED, non-deleted architecture decisions (oldest first),
 * with ids + dates so they can be cited as summary references and resolved back.
 */
export async function listAcceptedDecisionsForSummary(input: {
	projectId: string;
	tenancy: SummaryTenancy;
}): Promise<ReferenceDecision[]> {
	return db.architectureDecision.findMany({
		where: {
			projectId: input.projectId,
			status: "ACCEPTED",
			deletedAt: null,
			...sourceTenantWhere(input.tenancy),
		},
		orderBy: { decisionDate: "asc" },
		select: {
			id: true,
			title: true,
			decision: true,
			rationale: true,
			decisionDate: true,
		},
	});
}

/** A roadmap item (Feature/Bug) surfaced as a citable, high-level summary source. */
export type ReferenceRoadmapItem = {
	id: string;
	identifier: string;
	title: string;
	/** StoryKind — FEATURE | BUG. */
	kind: string;
	/** StoryPriority — P0_CRITICAL … P3_LOW. */
	priority: string;
	/** Human status column name (ProjectStoryStatus.name). */
	status: string;
	activityAt: Date;
};

/**
 * The project's ACTIVE roadmap items (highest priority first), EXCLUDING hidden
 * and rejected ones — `draftingStage` DECLINED (rejected) and CLOSED (hidden /
 * merged-duplicate / PM-auto-hidden) are dropped, matching the roadmap UI's
 * visibility rule. High-level fields only (no bodies); the fold caps how many it
 * actually renders.
 *
 * Uses raw SQL on purpose: the Temporal worker's Docker build can ship a STALE
 * generated Prisma client (its `RUN prisma generate` is followed by `|| true`),
 * which may lack newer columns like `draftingStage` and reject a typed query. The
 * database itself always has the column, so a raw query is resilient to that.
 *
 * Scoped by `projectId` only — `user_story` is project-scoped (no organizationId
 * column), and the summary's project is already tenant-verified upstream, so the
 * project boundary IS the tenant boundary. (`tenancy` is accepted for a uniform
 * signature but not needed here.)
 */
export async function listRoadmapItemsForSummary(input: {
	projectId: string;
	tenancy: SummaryTenancy;
	take?: number;
}): Promise<ReferenceRoadmapItem[]> {
	const take = input.take ?? 300;
	const rows = await db.$queryRaw<
		Array<{
			id: string;
			identifier: string;
			title: string;
			kind: string;
			priority: string;
			activityAt: Date;
			status: string | null;
		}>
	>`
		SELECT us."id", us."identifier", us."title",
		       us."kind"::text AS kind, us."priority"::text AS priority,
		       COALESCE(us."lastEditedAt", us."createdAt") AS "activityAt",
		       pss."name" AS status
		FROM "user_story" us
		LEFT JOIN "project_story_status" pss ON pss."id" = us."statusId"
		WHERE us."projectId" = ${input.projectId}
		  AND us."draftingStage"::text NOT IN ('DECLINED', 'CLOSED')
		ORDER BY us."priority" ASC, us."roadmapOrder" ASC
		LIMIT ${take}
	`;
	return rows.map((r) => ({
		id: r.id,
		identifier: r.identifier,
		title: r.title,
		kind: r.kind,
		priority: r.priority,
		status: r.status ?? "",
		activityAt: r.activityAt,
	}));
}

/** A connected code repository (+ optional high-level analysis) as a summary source. */
export type ReferenceCodeRepo = {
	id: string;
	label: string;
	url: string | null;
	provider: string;
	branch: string | null;
	language: string | null;
	analysis: string | null;
	updatedAt: Date;
};

/** Compact "top frameworks/libraries" line from an AtlasAnalysis.techStack JSON. */
function deriveTechStackLine(
	value: Prisma.JsonValue | null | undefined,
): string | null {
	if (!Array.isArray(value)) {
		return null;
	}
	const names = value
		.map((t) =>
			t && typeof t === "object" && !Array.isArray(t)
				? (t as Record<string, unknown>).name
				: null,
		)
		.filter((n): n is string => typeof n === "string")
		.slice(0, 12);
	return names.length ? names.join(", ") : null;
}

/** High-level narrative intro from an AtlasAnalysis.businessTour JSON. */
function deriveBusinessTourIntro(
	value: Prisma.JsonValue | null | undefined,
): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const intro = (value as Record<string, unknown>).intro;
	return typeof intro === "string" && intro.trim() ? intro.trim() : null;
}

/**
 * The project's connected code repositories (not disconnected), each enriched with
 * a HIGH-LEVEL codebase signal — tech stack + a narrative intro from the latest
 * READY Atlas analysis. NOT raw code and NOT the detailed code-analysis text
 * (that already flows in as a ProjectContext row). Repo integrations are
 * project-scoped (no per-user/org columns), so the project boundary is the tenant
 * boundary here.
 */
type AtlasAnalysisSignal = {
	repositoryIntegrationId: string | null;
	techStack: Prisma.JsonValue;
	businessTour: Prisma.JsonValue;
};

export async function listCodeReposForSummary(input: {
	projectId: string;
}): Promise<ReferenceCodeRepo[]> {
	// Raw SQL, same rationale as `listRoadmapItemsForSummary`: resilient to a stale
	// worker Prisma client. `project_repository_integration` is project-scoped, so
	// the project boundary (already tenant-verified upstream) is the isolation.
	const repos = await db.$queryRaw<
		Array<{
			id: string;
			provider: string;
			repositoryOwner: string;
			repositoryName: string;
			repositoryUrl: string | null;
			defaultBranch: string | null;
			updatedAt: Date;
		}>
	>`
		SELECT "id", "provider"::text AS provider, "repositoryOwner",
		       "repositoryName", "repositoryUrl", "defaultBranch", "updatedAt"
		FROM "project_repository_integration"
		WHERE "projectId" = ${input.projectId}
		  AND "status"::text <> 'DISCONNECTED'
		ORDER BY "createdAt" ASC
	`;
	if (repos.length === 0) {
		return [];
	}

	// The high-level Atlas signal (tech stack + narrative) is a bonus — if it can't
	// be read, repos still fold in with their identity.
	const byIntegration = new Map<string, AtlasAnalysisSignal>();
	let fallback: AtlasAnalysisSignal | null = null;
	try {
		const analyses = await db.$queryRaw<AtlasAnalysisSignal[]>`
			SELECT "repositoryIntegrationId", "techStack", "businessTour"
			FROM "atlas_analysis"
			WHERE "projectId" = ${input.projectId} AND "status"::text = 'READY'
			ORDER BY "updatedAt" DESC
		`;
		for (const a of analyses) {
			fallback ??= a;
			if (
				a.repositoryIntegrationId &&
				!byIntegration.has(a.repositoryIntegrationId)
			) {
				byIntegration.set(a.repositoryIntegrationId, a);
			}
		}
	} catch {
		// Atlas analysis is optional enrichment — skip it if unavailable.
	}

	return repos.map((r) => {
		const analysis = byIntegration.get(r.id) ?? fallback;
		return {
			id: r.id,
			label: `${r.repositoryOwner}/${r.repositoryName}`,
			url: r.repositoryUrl,
			provider: r.provider,
			branch: r.defaultBranch,
			language: deriveTechStackLine(analysis?.techStack),
			analysis: deriveBusinessTourIntro(analysis?.businessTour),
			updatedAt: r.updatedAt,
		};
	});
}

// ─────────────────────── Reference resolution (drill-down) ──────────────────

/** A resolved original source behind a summary reference. */
export type ResolvedContextReference = {
	sourceType: string;
	sourceId: string;
	sourceTimestamp: string;
	label: string | null;
	content: string;
	sourceUrl: string | null;
};

/**
 * Canonical, authorized resolver for a summary reference → its original source.
 *
 * Tenant + project isolation is enforced on BOTH ends: the summary is loaded by
 * id under the caller's tenancy, the resolved source must belong to that
 * summary's own project + tenancy, and only a `sourceId` the summary actually
 * cites can be resolved. A reference can therefore never resolve across tenants
 * or projects, and a hallucinated / non-cited id returns null.
 */
export async function resolveContextSummaryReference(input: {
	summaryId: string;
	sourceId: string;
	/** Bind resolution to the requested project (defense in depth). */
	projectId?: string;
	userId?: string | null;
	organizationId?: string | null;
}): Promise<ResolvedContextReference | null> {
	const summary = await getContextSummaryById({
		id: input.summaryId,
		userId: input.userId,
		organizationId: input.organizationId,
	});
	if (!summary) {
		return null;
	}
	if (input.projectId && summary.projectId !== input.projectId) {
		return null;
	}

	const references = parseSummaryReferences(summary.references);
	const ref = references.find((r) => r.sourceId === input.sourceId);
	if (!ref) {
		// Not a source this summary cites — refuse (defends against a client
		// probing arbitrary ids through the resolver).
		return null;
	}

	const tenancy: SummaryTenancy = {
		userId: summary.userId,
		organizationId: summary.organizationId,
	};

	if (ref.sourceType === DECISION_SOURCE_TYPE) {
		const decision = await db.architectureDecision.findFirst({
			where: {
				id: ref.sourceId,
				projectId: summary.projectId,
				deletedAt: null,
				...sourceTenantWhere(tenancy),
			},
			select: {
				title: true,
				decision: true,
				rationale: true,
				decisionDate: true,
			},
		});
		if (!decision) {
			return null;
		}
		const body = [
			decision.decision?.trim() ?? "",
			decision.rationale?.trim()
				? `\n\n**Rationale:** ${decision.rationale.trim()}`
				: "",
		]
			.filter(Boolean)
			.join("");
		return {
			sourceType: DECISION_SOURCE_TYPE,
			sourceId: ref.sourceId,
			sourceTimestamp: decision.decisionDate.toISOString(),
			label: decision.title,
			content: body,
			sourceUrl: null,
		};
	}

	if (ref.sourceType === ROADMAP_SOURCE_TYPE) {
		// user_story is project-scoped (no organizationId column); the project —
		// already tenant-verified via the summary — is the isolation boundary.
		const story = await db.userStory.findFirst({
			where: {
				id: ref.sourceId,
				projectId: summary.projectId,
			},
			select: {
				identifier: true,
				title: true,
				kind: true,
				priority: true,
				description: true,
				createdAt: true,
				lastEditedAt: true,
				status: { select: { name: true } },
			},
		});
		if (!story) {
			return null;
		}
		const body = [
			`${story.kind} · ${story.priority} · status: ${story.status?.name ?? "—"}`,
			story.description?.trim() ? `\n\n${story.description.trim()}` : "",
		]
			.filter(Boolean)
			.join("");
		return {
			sourceType: ROADMAP_SOURCE_TYPE,
			sourceId: ref.sourceId,
			sourceTimestamp: (
				story.lastEditedAt ?? story.createdAt
			).toISOString(),
			label: `${story.identifier} · ${story.title}`,
			content: body,
			sourceUrl: null,
		};
	}

	if (ref.sourceType === CODE_REPO_SOURCE_TYPE) {
		// Repo integrations are project-scoped (no per-user/org columns); the
		// project boundary — already tenant-verified via the summary — is the
		// isolation here.
		const repo = await db.projectRepositoryIntegration.findFirst({
			where: { id: ref.sourceId, projectId: summary.projectId },
			select: {
				provider: true,
				repositoryOwner: true,
				repositoryName: true,
				repositoryUrl: true,
				defaultBranch: true,
				status: true,
				updatedAt: true,
			},
		});
		if (!repo) {
			return null;
		}
		const body = [
			`Provider: ${repo.provider}`,
			`Default branch: ${repo.defaultBranch}`,
			`Status: ${repo.status}`,
		].join("\n");
		return {
			sourceType: CODE_REPO_SOURCE_TYPE,
			sourceId: ref.sourceId,
			sourceTimestamp: repo.updatedAt.toISOString(),
			label: `${repo.repositoryOwner}/${repo.repositoryName}`,
			content: body,
			sourceUrl: repo.repositoryUrl,
		};
	}

	const context = await db.projectContext.findFirst({
		where: {
			id: ref.sourceId,
			projectId: summary.projectId,
			...sourceTenantWhere(tenancy),
		},
		select: {
			type: true,
			content: true,
			createdAt: true,
			sourceTitle: true,
			originalFilename: true,
			sourceUrl: true,
		},
	});
	if (!context) {
		return null;
	}
	return {
		sourceType: context.type,
		sourceId: ref.sourceId,
		sourceTimestamp: context.createdAt.toISOString(),
		label: deriveSourceLabel(context),
		content: context.content,
		sourceUrl: context.sourceUrl,
	};
}

/**
 * Partition a set of candidate references into those whose `sourceId` really
 * exists in the project + tenant for its `sourceType`, and those that don't. Used
 * to sanitize a manual edit — a user can hand-insert a reference marker, so every
 * kept reference is re-verified against the DB (a hallucinated / cross-tenant /
 * cross-project id lands in `invalid` and is dropped by the caller). Batched by
 * type; existence-only (no bodies).
 */
export async function validateContextSources(input: {
	projectId: string;
	tenancy: SummaryTenancy;
	references: ContextSourceReference[];
}): Promise<{
	valid: ContextSourceReference[];
	invalid: ContextSourceReference[];
}> {
	const { projectId, tenancy } = input;
	const byType = new Map<string, string[]>();
	for (const ref of input.references) {
		const bucket =
			ref.sourceType === DECISION_SOURCE_TYPE ||
			ref.sourceType === ROADMAP_SOURCE_TYPE ||
			ref.sourceType === CODE_REPO_SOURCE_TYPE
				? ref.sourceType
				: "CONTEXT";
		const list = byType.get(bucket) ?? [];
		list.push(ref.sourceId);
		byType.set(bucket, list);
	}

	const existing = new Set<string>();
	const collect = (rows: Array<{ id: string }>) => {
		for (const r of rows) {
			existing.add(r.id);
		}
	};

	const decisionIds = byType.get(DECISION_SOURCE_TYPE);
	const roadmapIds = byType.get(ROADMAP_SOURCE_TYPE);
	const repoIds = byType.get(CODE_REPO_SOURCE_TYPE);
	const contextIds = byType.get("CONTEXT");

	await Promise.all([
		decisionIds?.length
			? db.architectureDecision
					.findMany({
						where: {
							id: { in: decisionIds },
							projectId,
							deletedAt: null,
							...sourceTenantWhere(tenancy),
						},
						select: { id: true },
					})
					.then(collect)
			: Promise.resolve(),
		roadmapIds?.length
			? db.userStory
					.findMany({
						where: { id: { in: roadmapIds }, projectId },
						select: { id: true },
					})
					.then(collect)
			: Promise.resolve(),
		repoIds?.length
			? db.projectRepositoryIntegration
					.findMany({
						where: { id: { in: repoIds }, projectId },
						select: { id: true },
					})
					.then(collect)
			: Promise.resolve(),
		contextIds?.length
			? db.projectContext
					.findMany({
						where: {
							id: { in: contextIds },
							projectId,
							...sourceTenantWhere(tenancy),
						},
						select: { id: true },
					})
					.then(collect)
			: Promise.resolve(),
	]);

	const valid: ContextSourceReference[] = [];
	const invalid: ContextSourceReference[] = [];
	for (const ref of input.references) {
		(existing.has(ref.sourceId) ? valid : invalid).push(ref);
	}
	return { valid, invalid };
}

/** A citable source offered by the manual-edit "insert reference" picker. */
export type ContextSourceCandidate = {
	sourceType: string;
	sourceId: string;
	label: string;
	timestamp: string;
};

/**
 * Candidate sources a user can cite from the manual-edit reference picker: recent
 * raw context items, ACCEPTED decisions, active roadmap items, and (only when the
 * code-repo feature is enabled) connected repositories. Flat list grouped by
 * `sourceType` in the UI; context items are capped to the most recent
 * `contextTake` (default 200).
 */
export async function listContextSummarySources(input: {
	projectId: string;
	tenancy: SummaryTenancy;
	includeCodeRepo: boolean;
	contextTake?: number;
}): Promise<ContextSourceCandidate[]> {
	const { projectId, tenancy } = input;
	const [contextRows, decisions, roadmap, repos] = await Promise.all([
		db.projectContext.findMany({
			where: {
				projectId,
				content: { not: "" },
				...sourceTenantWhere(tenancy),
			},
			orderBy: { createdAt: "desc" },
			take: input.contextTake ?? 200,
			select: {
				id: true,
				type: true,
				content: true,
				createdAt: true,
				sourceTitle: true,
				originalFilename: true,
			},
		}),
		listAcceptedDecisionsForSummary({ projectId, tenancy }),
		listRoadmapItemsForSummary({ projectId, tenancy }),
		input.includeCodeRepo
			? listCodeReposForSummary({ projectId })
			: Promise.resolve([] as ReferenceCodeRepo[]),
	]);

	const candidates: ContextSourceCandidate[] = [];
	for (const row of contextRows) {
		candidates.push({
			sourceType: row.type,
			sourceId: row.id,
			label: deriveSourceLabel(row) ?? row.type,
			timestamp: row.createdAt.toISOString(),
		});
	}
	for (const d of decisions) {
		candidates.push({
			sourceType: DECISION_SOURCE_TYPE,
			sourceId: d.id,
			label: d.title,
			timestamp: d.decisionDate.toISOString(),
		});
	}
	for (const r of roadmap) {
		candidates.push({
			sourceType: ROADMAP_SOURCE_TYPE,
			sourceId: r.id,
			label: `${r.identifier} · ${r.title}`,
			timestamp: r.activityAt.toISOString(),
		});
	}
	for (const repo of repos) {
		candidates.push({
			sourceType: CODE_REPO_SOURCE_TYPE,
			sourceId: repo.id,
			label: repo.label,
			timestamp: repo.updatedAt.toISOString(),
		});
	}
	return candidates;
}

export type ContextVolumeCandidate = {
	projectId: string;
	userId: string | null;
	organizationId: string | null;
	rawChars: number;
	contextCount: number;
	latestContextAt: Date;
};

/**
 * Cheap grouped pre-filter for the auto-summarization cron: every project whose
 * total raw-context character volume is at least `minChars`. The watchdog then
 * refines each candidate against its latest summary watermark (a small per-
 * candidate query) before dispatching, so this heavy scan runs once per tick.
 */
export async function getContextVolumeCandidates(input: {
	minChars: number;
}): Promise<ContextVolumeCandidate[]> {
	const rows = await db.$queryRaw<
		Array<{
			projectId: string;
			userId: string | null;
			organizationId: string | null;
			raw_chars: bigint;
			context_count: number;
			latest_context_at: Date;
		}>
	>`
		SELECT "projectId",
		       "userId",
		       "organizationId",
		       SUM(LENGTH("content"))::bigint AS raw_chars,
		       COUNT(*)::int AS context_count,
		       MAX("createdAt") AS latest_context_at
		FROM "project_context"
		WHERE "content" <> ''
		GROUP BY "projectId", "userId", "organizationId"
		HAVING SUM(LENGTH("content")) >= ${input.minChars}
	`;
	return rows.map((r) => ({
		projectId: r.projectId,
		userId: r.userId,
		organizationId: r.organizationId,
		rawChars: Number(r.raw_chars),
		contextCount: r.context_count,
		latestContextAt: r.latest_context_at,
	}));
}
