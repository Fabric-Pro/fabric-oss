/**
 * Proposal artifact (Fizzy #2801) — the Internal Analysis runs and their
 * findings: recording, starting, completing and reading them.
 *
 * An analysis run is one row per run, so COMPLETE and FAILED are terminal for
 * the row — a new analysis is a new row, never a re-entry — and the status
 * guards on run rows are deliberately status-scoped.
 */

import { db, type Prisma } from "../../client";
import { computeDocumentContentHash, sanitizeContent } from "./documents";
import {
	normalizeAnalysisReport,
	type ProposalAnalysisReportInput,
	reportToJson,
} from "./proposal-artifact-report";
import {
	assertDocumentOrganization,
	PROPOSAL_ANALYSIS_ERROR_MESSAGE_MAX_LENGTH,
	PROPOSAL_ANALYSIS_MATCH_WINDOW,
	PROPOSAL_ANALYSIS_SOURCE_CONTEXT_MAX_LENGTH,
	PROPOSAL_ANALYSIS_TIMEOUT_MS,
	type ProposalAnalysisKind,
	type ProposalAnalysisStatus,
	type ProposalArtifactGuardedOutcome,
	ProposalArtifactTenantError,
	type ProposalFindingSeverity,
	type ProposalFindingType,
} from "./proposal-artifact-shared";
import {
	MAX_SOURCE_NUMBER,
	normalizeSourceManifest,
	type ProposalSourceManifest,
	type ProposalSourceManifestEntryInput,
	parseStoredSourceManifest,
	toJson,
} from "./proposal-artifact-source-manifest";

export function capErrorMessage(message: string): string {
	return message.slice(0, PROPOSAL_ANALYSIS_ERROR_MESSAGE_MAX_LENGTH);
}

const IN_FLIGHT_STATUSES: readonly ProposalAnalysisStatus[] = [
	"PENDING",
	"RUNNING",
];

/**
 * A PENDING or RUNNING run with no update for longer than
 * {@link PROPOSAL_ANALYSIS_TIMEOUT_MS}. The one rule for "timed out": the
 * read labels a run with it, and a re-run claim marks such a run FAILED
 * instead of waiting for it.
 */
export function isAnalysisRunTimedOut(
	run: { status: ProposalAnalysisStatus; updatedAt: Date },
	now: Date,
): boolean {
	return (
		IN_FLIGHT_STATUSES.includes(run.status) &&
		now.getTime() - run.updatedAt.getTime() > PROPOSAL_ANALYSIS_TIMEOUT_MS
	);
}

/** Newest first, with the id breaking ties between equal timestamps. */
export const NEWEST_FIRST: Prisma.ProjectDocumentAnalysisOrderByWithRelationInput[] =
	[{ createdAt: "desc" }, { id: "desc" }];

function isNewerRun(
	run: { id: string; createdAt: Date },
	than: { id: string; createdAt: Date },
): boolean {
	const difference = run.createdAt.getTime() - than.createdAt.getTime();
	return difference > 0 || (difference === 0 && run.id > than.id);
}

// ---------------------------------------------------------------------------
// Prose hashes
// ---------------------------------------------------------------------------

/** Computes a document prose hash; injected so this module needs no parser. */
export type ComputeProseHash = (content: string) => string;

/** The version prefix of a prose hash (`p1` of `p1:…`); empty when none. */
function proseHashVersion(hash: string): string {
	const separator = hash.indexOf(":");
	return separator === -1 ? "" : hash.slice(0, separator);
}

export type ProposalClient = Pick<typeof db, "projectDocumentAnalysis">;

/**
 * The prose hash of each run, newest first, as far as the first one whose
 * stored hash already equals `currentProseHash` (or all of them when none
 * does). A run with no stored hash — written before the column existed — or
 * with one from another normalizer version gets one computed from its
 * analyzed body, which is read only for those runs. Nothing is backfilled.
 */
export async function resolveProseHashes(
	client: ProposalClient,
	runs: readonly { id: string; proseHash: string | null }[],
	input: {
		organizationId: string;
		currentProseHash: string;
		computeProseHash: ComputeProseHash;
	},
): Promise<Map<string, string>> {
	const version = proseHashVersion(input.currentProseHash);
	const usable = (hash: string | null): hash is string =>
		hash !== null && proseHashVersion(hash) === version;
	const storedMatch = runs.findIndex(
		(run) => run.proseHash === input.currentProseHash,
	);
	const scanned = storedMatch === -1 ? runs : runs.slice(0, storedMatch + 1);

	const hashes = new Map<string, string>();
	const unhashed = scanned
		.filter((run) => !usable(run.proseHash))
		.map((run) => run.id);
	if (unhashed.length > 0) {
		const bodies = await client.projectDocumentAnalysis.findMany({
			where: {
				id: { in: unhashed },
				organizationId: input.organizationId,
			},
			select: { id: true, analyzedContent: true },
		});
		for (const body of bodies) {
			hashes.set(body.id, input.computeProseHash(body.analyzedContent));
		}
	}
	for (const run of scanned) {
		if (usable(run.proseHash)) {
			hashes.set(run.id, run.proseHash);
		}
	}
	return hashes;
}

export interface CreateAnalysisRunInput {
	documentId: string;
	/** The analysis workflow id; one run row per key. */
	runKey: string;
	/**
	 * The generation run the analysis belongs to. The document must still be
	 * that run's (`ProjectDocument.liveRunId`, which the final save keeps), or
	 * its Main is another run's and nothing is recorded.
	 */
	liveRunId: string;
	/** Truncated to `PROPOSAL_ANALYSIS_SOURCE_CONTEXT_MAX_LENGTH`. */
	sourceContext: string;
	contextCount: number;
	promptVersionId?: string | null;
	model?: string | null;
	/**
	 * Record the run as already FAILED, for a run that must not start (the
	 * analysis prompt is unbound, or a project guest triggered the
	 * generation). The code is fixed; the message is truncated here.
	 */
	failure?: { errorCode: string; errorMessage: string };
	/**
	 * Computes the run's document prose hash from the body read back here.
	 * The caller never holds that body, so it passes the hasher instead of a
	 * hash. Omitted, the run stores none and readers compute it later.
	 */
	computeProseHash?: ComputeProseHash;
	/**
	 * The evidence manifest of `sourceContext`; bounded by
	 * {@link normalizeSourceManifest} before it is stored. Omitted or null,
	 * the run stores none.
	 */
	sourceManifest?: readonly ProposalSourceManifestEntryInput[] | null;
	/** When given, checked against the document's owning organization. */
	organizationId?: string;
	now?: Date;
}

export interface CreateAnalysisRunResult {
	analysisId: string;
	status: ProposalAnalysisStatus;
	/** False when a run with this key already existed: a retried creation. */
	created: boolean;
}

/**
 * Create the run row for one analysis, PENDING (or FAILED with `failure`).
 *
 * The analyzed content and its version are read back from the document row —
 * the body as saved, not the caller's copy — and stored with its hash, which
 * `computeDocumentContentHash` computes exactly as the document read does, so
 * staleness is a plain comparison at read time. The row is read only while
 * the document is still `liveRunId`'s: once a newer generation has taken it,
 * its body is that run's Main, not this one's, and the answer is `superseded`
 * with nothing written — whether the run would have been PENDING or FAILED.
 *
 * Idempotent per `runKey`: a retried creation finds the row the first attempt
 * wrote and returns it unchanged, whatever its status by now, and even if a
 * newer run has taken the document since — the row holds this run's Main.
 *
 * Always a GENERATION run: a RERUN row is created only by
 * `claimRerun` (proposal-artifact-rerun.ts), which picks its source run under the document lock.
 */
export async function createAnalysisRun(
	input: CreateAnalysisRunInput,
): Promise<CreateAnalysisRunResult | "superseded"> {
	const now = input.now ?? new Date();
	const sourceManifest = input.sourceManifest
		? normalizeSourceManifest(input.sourceManifest)
		: null;
	return db.$transaction(async (tx) => {
		const document = await tx.projectDocument.findUnique({
			where: { id: input.documentId },
			select: {
				content: true,
				version: true,
				projectId: true,
				liveRunId: true,
				project: { select: { organizationId: true } },
			},
		});
		assertDocumentOrganization(
			document?.project.organizationId,
			input.organizationId || undefined,
		);
		const organizationId = document.project.organizationId;

		// The retry check comes before the ownership check: a first attempt
		// that recorded the run and lost its answer must find its row, not
		// report superseded and leave that row PENDING with nothing to run it.
		const recorded = await tx.projectDocumentAnalysis.findUnique({
			where: { runKey: input.runKey },
			select: { id: true, documentId: true, status: true },
		});
		if (recorded) {
			if (recorded.documentId !== input.documentId) {
				throw new ProposalArtifactTenantError(
					"The run key belongs to another document",
				);
			}
			return {
				analysisId: recorded.id,
				status: recorded.status,
				created: false,
			};
		}
		if (document.liveRunId !== input.liveRunId) {
			return "superseded" as const;
		}

		// ON CONFLICT DO NOTHING on runKey: a creation racing this one with
		// the same key leaves the row it wrote alone instead of failing on
		// the unique key.
		const { count } = await tx.projectDocumentAnalysis.createMany({
			data: [
				{
					organizationId,
					projectId: document.projectId,
					documentId: input.documentId,
					runKey: input.runKey,
					status: input.failure ? "FAILED" : "PENDING",
					analyzedContent: document.content,
					contentHash: computeDocumentContentHash(document.content),
					proseHash:
						input.computeProseHash?.(document.content) ?? null,
					sourceContext: sanitizeContent(input.sourceContext).slice(
						0,
						PROPOSAL_ANALYSIS_SOURCE_CONTEXT_MAX_LENGTH,
					),
					...(sourceManifest && {
						sourceManifest: toJson(sourceManifest),
					}),
					documentVersion: document.version,
					contextCount: input.contextCount,
					promptVersionId: input.promptVersionId ?? null,
					model: input.model ?? null,
					errorCode: input.failure?.errorCode ?? null,
					errorMessage: input.failure
						? capErrorMessage(input.failure.errorMessage)
						: null,
					completedAt: input.failure ? now : null,
				},
			],
			skipDuplicates: true,
		});

		const run = await tx.projectDocumentAnalysis.findUniqueOrThrow({
			where: { runKey: input.runKey },
			select: { id: true, documentId: true, status: true },
		});
		if (run.documentId !== input.documentId) {
			throw new ProposalArtifactTenantError(
				"The run key belongs to another document",
			);
		}
		return { analysisId: run.id, status: run.status, created: count > 0 };
	});
}

/**
 * The source material a run reads: its own stored context and manifest, or,
 * for a re-run, those of the run it references. A re-run whose source run is
 * missing (none existed, or it was deleted) reads none.
 */
export interface RunSourceContext {
	/** The run the material is stored on; null when there is none. */
	fromRunId: string | null;
	sourceContext: string;
	sourceManifest: ProposalSourceManifest | null;
}

const RUN_SOURCE_SELECT = {
	id: true,
	documentId: true,
	organizationId: true,
	kind: true,
	sourceRunId: true,
	sourceContext: true,
	sourceManifest: true,
} as const satisfies Prisma.ProjectDocumentAnalysisSelect;

type RunSourceRow = Prisma.ProjectDocumentAnalysisGetPayload<{
	select: typeof RUN_SOURCE_SELECT;
}>;

/**
 * Follow a re-run to its source run. The source run is read only within the
 * same document and organization as the run, so a damaged reference fails
 * closed to "no source material", never to another document's.
 */
async function resolveRunSource(
	client: ProposalClient,
	run: RunSourceRow,
): Promise<RunSourceContext> {
	if (run.kind !== "RERUN") {
		return {
			fromRunId: run.id,
			sourceContext: run.sourceContext,
			sourceManifest: parseStoredSourceManifest(run.sourceManifest),
		};
	}
	const source = run.sourceRunId
		? await client.projectDocumentAnalysis.findFirst({
				where: {
					id: run.sourceRunId,
					documentId: run.documentId,
					organizationId: run.organizationId,
				},
				select: { id: true, sourceContext: true, sourceManifest: true },
			})
		: null;
	if (!source) {
		return { fromRunId: null, sourceContext: "", sourceManifest: null };
	}
	return {
		fromRunId: source.id,
		sourceContext: source.sourceContext,
		sourceManifest: parseStoredSourceManifest(source.sourceManifest),
	};
}

/**
 * The source material of a run, following a re-run to its source run. Null
 * when the run does not exist.
 */
export async function getRunSourceContext(
	analysisId: string,
): Promise<RunSourceContext | null> {
	const run = await db.projectDocumentAnalysis.findUnique({
		where: { id: analysisId },
		select: RUN_SOURCE_SELECT,
	});
	return run ? resolveRunSource(db, run) : null;
}

/**
 * What the analysis activity needs to run: the stored Main body and source
 * context, and the pinned prompt version. The workflow carries ids only, so
 * these never travel through Temporal history.
 *
 * `sourceContext` and `sourceManifest` are the run's source material as
 * {@link getRunSourceContext} resolves it: a re-run's come from its source
 * run, and a generation run's are its own, exactly as before re-runs existed.
 */
export interface AnalysisRunInput {
	analysisId: string;
	documentId: string;
	projectId: string;
	organizationId: string;
	status: ProposalAnalysisStatus;
	kind: ProposalAnalysisKind;
	analyzedContent: string;
	contentHash: string;
	/** Null on a run recorded before prose hashes existed. */
	proseHash: string | null;
	sourceContext: string;
	sourceManifest: ProposalSourceManifest | null;
	/** The run the source material was read from; null when there is none. */
	sourceContextRunId: string | null;
	/** The run a re-run references; null on a generation run. */
	sourceRunId: string | null;
	contextCount: number;
	documentVersion: number | null;
	promptVersionId: string | null;
}

export async function getAnalysisRunInput(
	analysisId: string,
): Promise<AnalysisRunInput | null> {
	const run = await db.projectDocumentAnalysis.findUnique({
		where: { id: analysisId },
		select: {
			...RUN_SOURCE_SELECT,
			projectId: true,
			status: true,
			analyzedContent: true,
			contentHash: true,
			proseHash: true,
			contextCount: true,
			documentVersion: true,
			promptVersionId: true,
		},
	});
	if (!run) {
		return null;
	}
	const source = await resolveRunSource(db, run);
	return {
		analysisId: run.id,
		documentId: run.documentId,
		projectId: run.projectId,
		organizationId: run.organizationId,
		status: run.status,
		kind: run.kind,
		analyzedContent: run.analyzedContent,
		contentHash: run.contentHash,
		proseHash: run.proseHash,
		sourceContext: source.sourceContext,
		sourceManifest: source.sourceManifest,
		sourceContextRunId: source.fromRunId,
		sourceRunId: run.sourceRunId,
		contextCount: run.contextCount,
		documentVersion: run.documentVersion,
		promptVersionId: run.promptVersionId,
	};
}

/**
 * Mark the run RUNNING as the analysis activity starts. A retried activity
 * finds it RUNNING already and proceeds; `startedAt` keeps the first start.
 * `superseded` means the run already finished (COMPLETE or FAILED) and the
 * activity must not run the model.
 */
export async function markAnalysisRunning(
	analysisId: string,
	now: Date = new Date(),
): Promise<ProposalArtifactGuardedOutcome> {
	const firstStart = await db.projectDocumentAnalysis.updateMany({
		where: {
			id: analysisId,
			status: { in: ["PENDING", "RUNNING"] },
			startedAt: null,
		},
		data: { status: "RUNNING", startedAt: now },
	});
	if (firstStart.count > 0) {
		return "written";
	}
	// Already started once: a retried attempt. Still bumps `updatedAt`, so the
	// read-time timeout measures from the latest attempt.
	const retry = await db.projectDocumentAnalysis.updateMany({
		where: { id: analysisId, status: { in: ["PENDING", "RUNNING"] } },
		data: { status: "RUNNING" },
	});
	return retry.count > 0 ? "written" : "superseded";
}

export interface AnalysisFindingInput {
	severity: ProposalFindingSeverity;
	type: ProposalFindingType;
	title: string;
	detail: string;
	recommendation?: string | null;
	sectionHeading?: string | null;
	/**
	 * The finding's identity across runs. The caller folds same-key findings
	 * into the earliest before completing the run, so a key appears at most
	 * once per run; nothing here enforces it. Omitted on a finding that has
	 * no key, which then can never be answered.
	 */
	stableKey?: string | null;
	sectionKey?: string | null;
	sectionHash?: string | null;
	/** `### Source N` numbers; anything but a positive integer is dropped. */
	sourceRefs?: readonly number[];
	/** Titles of the same-key findings folded into this one. */
	foldedTitles?: readonly string[];
}

function storedSourceRefs(refs: readonly number[] | undefined): number[] {
	return (refs ?? []).filter(
		(ref) => Number.isInteger(ref) && ref >= 1 && ref <= MAX_SOURCE_NUMBER,
	);
}

/**
 * Store the run's findings and mark it COMPLETE, in one transaction: the
 * status write first, then the run's findings, positioned by array order. An
 * empty list completes the run with none.
 *
 * The first completion wins. Only a PENDING or RUNNING run is completed: the
 * status write locks the run row, so a second completion of the same run
 * (a timed-out attempt still finishing while its retry runs, each with its
 * own model output) waits, finds the run COMPLETE, and is refused. Findings
 * people have already seen never change under them.
 *
 * Refused (`superseded`, nothing written) when the run is COMPLETE already or
 * FAILED — the workflow gave up on it, and a late activity must not
 * resurrect it.
 *
 * The report, when given, is bounded by `normalizeAnalysisReport` here, so no
 * caller can skip it, and is written by the same status update that completes
 * the run: a refused completion writes no report either, and the first
 * writer's stays as it was. A report with no content writes neither report
 * column, never a JSON null.
 */
export async function completeAnalysisRun(input: {
	analysisId: string;
	findings: AnalysisFindingInput[];
	model?: string | null;
	report?: ProposalAnalysisReportInput | null;
	now?: Date;
}): Promise<ProposalArtifactGuardedOutcome> {
	const now = input.now ?? new Date();
	const report = normalizeAnalysisReport(input.report);
	return db.$transaction(async (tx) => {
		const { count } = await tx.projectDocumentAnalysis.updateMany({
			where: {
				id: input.analysisId,
				status: { in: ["PENDING", "RUNNING"] },
			},
			data: {
				status: "COMPLETE",
				completedAt: now,
				errorCode: null,
				errorMessage: null,
				...(input.model !== undefined && { model: input.model }),
				...(report && {
					report: reportToJson(report.report),
					reportText: report.reportText,
				}),
			},
		});
		if (count === 0) {
			return "superseded" as const;
		}

		const run = await tx.projectDocumentAnalysis.findUniqueOrThrow({
			where: { id: input.analysisId },
			select: { organizationId: true },
		});
		await tx.projectDocumentFinding.deleteMany({
			where: { analysisId: input.analysisId },
		});
		if (input.findings.length > 0) {
			await tx.projectDocumentFinding.createMany({
				data: input.findings.map((finding, position) => ({
					organizationId: run.organizationId,
					analysisId: input.analysisId,
					severity: finding.severity,
					type: finding.type,
					title: finding.title,
					detail: finding.detail,
					recommendation: finding.recommendation ?? null,
					sectionHeading: finding.sectionHeading ?? null,
					position,
					stableKey: finding.stableKey ?? null,
					sectionKey: finding.sectionKey ?? null,
					sectionHash: finding.sectionHash ?? null,
					sourceRefs: storedSourceRefs(finding.sourceRefs),
					foldedTitles: [...(finding.foldedTitles ?? [])],
				})),
			});
		}
		return "written" as const;
	});
}

/**
 * Record the run as FAILED with a fixed code and a fixed message (truncated
 * here). Never overwrites a finished run: `superseded` means it is already
 * COMPLETE or FAILED, and there is nothing left to do.
 */
export async function failAnalysisRun(input: {
	analysisId: string;
	errorCode: string;
	errorMessage: string;
	now?: Date;
}): Promise<ProposalArtifactGuardedOutcome> {
	const { count } = await db.projectDocumentAnalysis.updateMany({
		where: { id: input.analysisId, status: { in: ["PENDING", "RUNNING"] } },
		data: {
			status: "FAILED",
			errorCode: input.errorCode,
			errorMessage: capErrorMessage(input.errorMessage),
			completedAt: input.now ?? new Date(),
		},
	});
	return count > 0 ? "written" : "superseded";
}

const FINDING_VIEW_SELECT = {
	id: true,
	severity: true,
	type: true,
	title: true,
	detail: true,
	recommendation: true,
	sectionHeading: true,
	position: true,
	stableKey: true,
	sectionKey: true,
	sectionHash: true,
	sourceRefs: true,
	foldedTitles: true,
} as const satisfies Prisma.ProjectDocumentFindingSelect;

const ANALYSIS_VIEW_SELECT = {
	id: true,
	documentId: true,
	projectId: true,
	organizationId: true,
	runKey: true,
	status: true,
	kind: true,
	sourceRunId: true,
	contentHash: true,
	proseHash: true,
	documentVersion: true,
	contextCount: true,
	promptVersionId: true,
	model: true,
	errorCode: true,
	errorMessage: true,
	startedAt: true,
	completedAt: true,
	createdAt: true,
	updatedAt: true,
	findings: {
		orderBy: { position: "asc" },
		select: FINDING_VIEW_SELECT,
	},
} as const satisfies Prisma.ProjectDocumentAnalysisSelect;

export type ProposalAnalysisView = Prisma.ProjectDocumentAnalysisGetPayload<{
	select: typeof ANALYSIS_VIEW_SELECT;
}>;

/**
 * The document's newest analysis run — by creation, so an older run that
 * finishes late never displaces a newer one — with its findings in order.
 * Scoped to the owning organization. Never returns the stored content or
 * source context; `contentHash` is there for the read-time staleness check.
 */
export async function getLatestAnalysisForDocument(input: {
	documentId: string;
	organizationId: string;
}): Promise<ProposalAnalysisView | null> {
	return db.projectDocumentAnalysis.findFirst({
		where: {
			documentId: input.documentId,
			organizationId: input.organizationId,
		},
		orderBy: NEWEST_FIRST,
		select: ANALYSIS_VIEW_SELECT,
	});
}

/** The run a read shows, with what the API needs to render and check it. */
export type ProposalAnalysisShownRun = Omit<
	ProposalAnalysisView,
	"proseHash"
> & {
	/** Stored, or computed from the analyzed body for an older run. */
	proseHash: string;
	/**
	 * The evidence manifest of the source material the run read: its own, or
	 * a re-run's source run's. Null when there is none.
	 */
	sourceManifest: ProposalSourceManifest | null;
};

/**
 * The document's newest run, when it is newer than the shown one and has not
 * completed.
 */
export interface ProposalAnalysisNewerRun {
	id: string;
	kind: ProposalAnalysisKind;
	status: Exclude<ProposalAnalysisStatus, "COMPLETE">;
	errorCode: string | null;
	/** PENDING or RUNNING and silent past the shared timeout. */
	timedOut: boolean;
	createdAt: Date;
}

export interface ProposalAnalysisForContent {
	/** Null when the document has no COMPLETE run yet. */
	run: ProposalAnalysisShownRun | null;
	/** The shown run describes other content than the document's current. */
	isStale: boolean;
	newerRun: ProposalAnalysisNewerRun | null;
}

/**
 * The analysis that describes the document's current content.
 *
 * The newest COMPLETE run whose stored prose hash equals `currentProseHash`
 * is shown as current, looked up across the document's whole history. Only
 * when none matches are the newest {@link PROPOSAL_ANALYSIS_MATCH_WINDOW}
 * COMPLETE runs searched again, newest first, with a hash computed from the
 * analyzed body with `computeProseHash` for each run recorded before prose
 * hashes existed or hashed by another normalizer version (nothing is
 * backfilled), so a formatting-only save does not make such a run stale.
 * When still no run matches, the newest COMPLETE run is shown as stale. So a
 * Reject that restores earlier content — however many runs ago — shows the
 * run that described it again, and a re-run and a generation finishing in
 * either order leave the right run shown.
 *
 * `newerRun` is the document's newest run, when it was created after the
 * shown one (or nothing is shown) and has not completed: an analysis in
 * progress, or one that failed. A newer run that completed reports nothing,
 * even over an older failure between it and the shown run.
 *
 * Scoped to the owning organization. Never returns the analyzed body or the
 * stored source context.
 */
export async function getAnalysisForCurrentContent(input: {
	organizationId: string;
	documentId: string;
	currentProseHash: string;
	computeProseHash: ComputeProseHash;
	now?: Date;
}): Promise<ProposalAnalysisForContent> {
	const now = input.now ?? new Date();
	const scope = {
		documentId: input.documentId,
		organizationId: input.organizationId,
	};

	const [storedMatch, newest] = await Promise.all([
		db.projectDocumentAnalysis.findFirst({
			where: {
				...scope,
				status: "COMPLETE",
				proseHash: input.currentProseHash,
			},
			orderBy: NEWEST_FIRST,
			select: { id: true, createdAt: true },
		}),
		db.projectDocumentAnalysis.findFirst({
			where: scope,
			orderBy: NEWEST_FIRST,
			select: {
				id: true,
				kind: true,
				status: true,
				errorCode: true,
				createdAt: true,
				updatedAt: true,
			},
		}),
	]);

	let shown: { id: string; createdAt: Date } | null;
	let shownProseHash: string | undefined;
	let isStale: boolean;
	if (storedMatch) {
		shown = storedMatch;
		shownProseHash = input.currentProseHash;
		isStale = false;
	} else {
		const complete = await db.projectDocumentAnalysis.findMany({
			where: { ...scope, status: "COMPLETE" },
			orderBy: NEWEST_FIRST,
			take: PROPOSAL_ANALYSIS_MATCH_WINDOW,
			select: { id: true, createdAt: true, proseHash: true },
		});
		const hashes = await resolveProseHashes(db, complete, input);
		const describing = complete.find(
			(run) => hashes.get(run.id) === input.currentProseHash,
		);
		shown = describing ?? complete[0] ?? null;
		shownProseHash = shown ? hashes.get(shown.id) : undefined;
		isStale = !describing;
	}

	const newerRun: ProposalAnalysisNewerRun | null =
		newest &&
		newest.status !== "COMPLETE" &&
		(!shown || isNewerRun(newest, shown))
			? {
					id: newest.id,
					kind: newest.kind,
					status: newest.status,
					errorCode: newest.errorCode,
					timedOut: isAnalysisRunTimedOut(newest, now),
					createdAt: newest.createdAt,
				}
			: null;

	const view =
		shown && shownProseHash !== undefined
			? await db.projectDocumentAnalysis.findFirst({
					where: { ...scope, id: shown.id },
					select: { ...ANALYSIS_VIEW_SELECT, sourceManifest: true },
				})
			: null;
	if (!view || shownProseHash === undefined) {
		return { run: null, isStale: false, newerRun };
	}

	// A re-run's evidence is its source run's manifest, read within the same
	// document and organization, as the run input reads it.
	const { sourceManifest: ownManifest, ...fields } = view;
	const manifestRun =
		view.kind !== "RERUN"
			? { sourceManifest: ownManifest }
			: view.sourceRunId
				? await db.projectDocumentAnalysis.findFirst({
						where: { ...scope, id: view.sourceRunId },
						select: { sourceManifest: true },
					})
				: null;
	return {
		run: {
			...fields,
			proseHash: shownProseHash,
			sourceManifest: parseStoredSourceManifest(
				manifestRun?.sourceManifest,
			),
		},
		isStale,
		newerRun,
	};
}
