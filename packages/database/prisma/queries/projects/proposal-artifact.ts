/**
 * Proposal artifact (Fizzy #2801) — the live sections of an in-flight
 * coordinated Proposal run, the Internal Analysis runs and their findings, and
 * the document's style settings.
 *
 * Live sections are OWNED BY A RUN TOKEN. Planning a run mints `liveRunId` and
 * resets the live columns; the generation activity claims its attempt on
 * entry; every later live write is guarded on that run, on GENERATING, and on
 * the attempt — never on a shared status alone, which every regeneration
 * passes through
 * (docs/solutions/architecture-patterns/a-terminal-status-guard-blocks-the-retry-that-starts-from-it.md).
 * `content` is never written here: the final save owns it.
 *
 * An analysis run is one row per run, so COMPLETE and FAILED are terminal for
 * the row — a new analysis is a new row, never a re-entry — and the status
 * guards on run rows are deliberately status-scoped.
 *
 * Every guarded write returns `written` or `superseded`, never a bare count,
 * so a caller never has to guess what a zero meant.
 *
 * Tenant columns are never taken from the caller. Writers copy them from the
 * document's project (or from the run row, for findings), and readers take the
 * owning organization's id and put it in `where`, so a read can never return
 * another organization's row. The Temporal worker bypasses RLS, so this is
 * what keeps its writes in the right tenant; `org_only` RLS and
 * ORG_ONLY_TABLES enforce the same for sessions.
 */

import { HEX_COLOR_PATTERN } from "@repo/utils/brand-colors";
import { db, type Prisma } from "../../client";
import { computeDocumentContentHash, sanitizeContent } from "./documents";

/** The answer of every guarded write in this module. */
export type ProposalArtifactGuardedOutcome = "written" | "superseded";

export const PROPOSAL_ANALYSIS_STATUSES = [
	"PENDING",
	"RUNNING",
	"COMPLETE",
	"FAILED",
] as const;
export type ProposalAnalysisStatus =
	(typeof PROPOSAL_ANALYSIS_STATUSES)[number];

export const PROPOSAL_FINDING_SEVERITIES = [
	"BLOCKING",
	"IMPORTANT",
	"INFORMATIONAL",
] as const;
export type ProposalFindingSeverity =
	(typeof PROPOSAL_FINDING_SEVERITIES)[number];

export const PROPOSAL_FINDING_TYPES = [
	"SCOPE",
	"COMMERCIAL",
	"ASSUMPTION",
	"RISK",
	"GAP",
	"SOURCE_VALIDATION",
	"ARCHITECTURE",
	"BRANDING",
	"OPPORTUNITY",
] as const;
export type ProposalFindingType = (typeof PROPOSAL_FINDING_TYPES)[number];

/**
 * Hard ceiling on the source context stored with an analysis run. The caller
 * owns the real budget for the model window; this only keeps the row bounded
 * whatever the caller passes.
 */
export const PROPOSAL_ANALYSIS_SOURCE_CONTEXT_MAX_LENGTH = 200_000;

/** Longest error message persisted on an analysis run. */
export const PROPOSAL_ANALYSIS_ERROR_MESSAGE_MAX_LENGTH = 500;

export const PROPOSAL_STYLE_MAX_ACCENT_COLORS = 3;
export const PROPOSAL_STYLE_MAX_DIRECTION_LENGTH = 500;

/**
 * The document is missing, or its project has no organization, or the
 * organization the caller expected is not the document's. Every caller has
 * already resolved the owning organization; reaching this means the caller and
 * the data disagree, so it fails closed.
 */
export class ProposalArtifactTenantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProposalArtifactTenantError";
	}
}

// ---------------------------------------------------------------------------
// Live sections
// ---------------------------------------------------------------------------

export interface LiveRunAttempt {
	documentId: string;
	/** The run token minted when the run was planned. */
	runId: string;
	/** The generation activity's attempt number. */
	attempt: number;
}

/**
 * This attempt still owns the run: no later attempt has claimed it. A null
 * `liveAttempt` is a run nobody has claimed yet.
 */
function attemptStillCurrent(
	attempt: number,
): Prisma.ProjectDocumentWhereInput {
	return { OR: [{ liveAttempt: null }, { liveAttempt: { lte: attempt } }] };
}

/**
 * Start a run's live sections: point the document at the new run and drop
 * whatever an earlier run left behind. Planning a run is what takes the live
 * columns over, so any older run's later writes become `superseded`.
 *
 * With `generationStartedAt`, the generation attempt's identity as the
 * dispatch stamped it, the takeover happens only while the document still
 * carries that identity: a late or retried plan of an attempt that a newer
 * request replaced is `superseded` and writes nothing (a document that no
 * longer exists answers the same). Without it, for runs started with no
 * attempt identity, the takeover is unconditional, as it always was, and
 * throws when the document no longer exists.
 */
export async function resetLiveSections(input: {
	documentId: string;
	runId: string;
	generationStartedAt?: Date;
}): Promise<ProposalArtifactGuardedOutcome> {
	const data = {
		liveRunId: input.runId,
		liveContent: null,
		liveAttempt: null,
	};
	if (!input.generationStartedAt) {
		await db.projectDocument.update({
			where: { id: input.documentId },
			data,
		});
		return "written";
	}
	const { count } = await db.projectDocument.updateMany({
		where: {
			id: input.documentId,
			generationStartedAt: input.generationStartedAt,
		},
		data,
	});
	return count > 0 ? "written" : "superseded";
}

/**
 * Claim the run for this generation attempt, on entry to the activity. A
 * later attempt's claim makes every write of an earlier one `superseded`, so
 * an attempt Temporal has given up on cannot keep writing while its
 * replacement streams. `superseded` means another run owns the document or a
 * later attempt already claimed this one.
 */
export async function claimLiveAttempt(
	input: LiveRunAttempt,
): Promise<ProposalArtifactGuardedOutcome> {
	const { count } = await db.projectDocument.updateMany({
		where: {
			id: input.documentId,
			liveRunId: input.runId,
			...attemptStillCurrent(input.attempt),
		},
		data: { liveAttempt: input.attempt },
	});
	return count > 0 ? "written" : "superseded";
}

/**
 * Save the completed sections streamed so far. Written only while the run
 * owns the document, the document is still GENERATING, and no later attempt
 * has claimed the run. `updatedAt` is set explicitly so readers polling on it
 * see every new section. `superseded` means this attempt must stop writing
 * live sections; it does not mean the generation failed.
 */
export async function writeLiveSections(
	input: LiveRunAttempt & { content: string; now?: Date },
): Promise<ProposalArtifactGuardedOutcome> {
	const { count } = await db.projectDocument.updateMany({
		where: {
			id: input.documentId,
			liveRunId: input.runId,
			status: "GENERATING",
			...attemptStillCurrent(input.attempt),
		},
		data: {
			liveContent: sanitizeContent(input.content),
			updatedAt: input.now ?? new Date(),
		},
	});
	return count > 0 ? "written" : "superseded";
}

/**
 * Drop the live preview of a run, on failure or when the gateway fallback
 * takes over. A run may clear its own preview in any status, but never a
 * newer run's. With `attempt` (an activity attempt clearing on its own
 * fallback), only while no later attempt has claimed the run: an attempt
 * Temporal gave up on, finishing late, must not erase the preview its retry
 * is writing. Without it (the workflow, once the run has failed), the run
 * alone. `superseded` means nothing was written.
 */
export async function clearLiveContent(input: {
	documentId: string;
	runId: string;
	attempt?: number;
	now?: Date;
}): Promise<ProposalArtifactGuardedOutcome> {
	const { count } = await db.projectDocument.updateMany({
		where: {
			id: input.documentId,
			liveRunId: input.runId,
			...(input.attempt !== undefined &&
				attemptStillCurrent(input.attempt)),
		},
		data: { liveContent: null, updatedAt: input.now ?? new Date() },
	});
	return count > 0 ? "written" : "superseded";
}

// ---------------------------------------------------------------------------
// Internal Analysis runs
// ---------------------------------------------------------------------------

function capErrorMessage(message: string): string {
	return message.slice(0, PROPOSAL_ANALYSIS_ERROR_MESSAGE_MAX_LENGTH);
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
 */
export async function createAnalysisRun(
	input: CreateAnalysisRunInput,
): Promise<CreateAnalysisRunResult | "superseded"> {
	const now = input.now ?? new Date();
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
		const organizationId = document?.project.organizationId;
		if (!document || !organizationId) {
			throw new ProposalArtifactTenantError(
				"The document is not in an organization project",
			);
		}
		if (input.organizationId && input.organizationId !== organizationId) {
			throw new ProposalArtifactTenantError(
				"The document belongs to another organization",
			);
		}

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
					sourceContext: sanitizeContent(input.sourceContext).slice(
						0,
						PROPOSAL_ANALYSIS_SOURCE_CONTEXT_MAX_LENGTH,
					),
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
 * What the analysis activity needs to run: the stored Main body and source
 * context, and the pinned prompt version. The workflow carries ids only, so
 * these never travel through Temporal history.
 */
export interface AnalysisRunInput {
	analysisId: string;
	documentId: string;
	projectId: string;
	organizationId: string;
	status: ProposalAnalysisStatus;
	analyzedContent: string;
	contentHash: string;
	sourceContext: string;
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
			id: true,
			documentId: true,
			projectId: true,
			organizationId: true,
			status: true,
			analyzedContent: true,
			contentHash: true,
			sourceContext: true,
			contextCount: true,
			documentVersion: true,
			promptVersionId: true,
		},
	});
	if (!run) {
		return null;
	}
	const { id, ...rest } = run;
	return { analysisId: id, ...rest };
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
 */
export async function completeAnalysisRun(input: {
	analysisId: string;
	findings: AnalysisFindingInput[];
	model?: string | null;
	now?: Date;
}): Promise<ProposalArtifactGuardedOutcome> {
	const now = input.now ?? new Date();
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

const ANALYSIS_VIEW_SELECT = {
	id: true,
	documentId: true,
	projectId: true,
	organizationId: true,
	runKey: true,
	status: true,
	contentHash: true,
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
		select: {
			id: true,
			severity: true,
			type: true,
			title: true,
			detail: true,
			recommendation: true,
			sectionHeading: true,
			position: true,
		},
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
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		select: ANALYSIS_VIEW_SELECT,
	});
}

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

export type DocumentStyleValidationCode =
	| "directionTooLong"
	| "tooManyAccentColors"
	| "invalidColor";

export class DocumentStyleValidationError extends Error {
	constructor(readonly code: DocumentStyleValidationCode) {
		super(`Invalid document style: ${code}`);
		this.name = "DocumentStyleValidationError";
	}
}

export interface DocumentStyleFields {
	styleDirection: string | null;
	primaryColor: string | null;
	accentColors: string[];
}

/**
 * Validate and normalize style fields: trimmed direction (empty becomes null)
 * of at most 500 characters, a lowercase `#rrggbb` primary color, and up to
 * three lowercase `#rrggbb` accents.
 */
export function normalizeDocumentStyleFields(input: {
	styleDirection?: string | null;
	primaryColor?: string | null;
	accentColors?: string[];
}): DocumentStyleFields {
	const styleDirection = input.styleDirection?.trim() || null;
	if (
		styleDirection &&
		styleDirection.length > PROPOSAL_STYLE_MAX_DIRECTION_LENGTH
	) {
		throw new DocumentStyleValidationError("directionTooLong");
	}

	const primaryColor = input.primaryColor?.trim() || null;
	if (primaryColor && !HEX_COLOR_PATTERN.test(primaryColor)) {
		throw new DocumentStyleValidationError("invalidColor");
	}

	const accentColors = input.accentColors ?? [];
	if (accentColors.length > PROPOSAL_STYLE_MAX_ACCENT_COLORS) {
		throw new DocumentStyleValidationError("tooManyAccentColors");
	}
	if (!accentColors.every((color) => HEX_COLOR_PATTERN.test(color))) {
		throw new DocumentStyleValidationError("invalidColor");
	}

	return {
		styleDirection,
		primaryColor: primaryColor?.toLowerCase() ?? null,
		accentColors: accentColors.map((color) => color.toLowerCase()),
	};
}

const STYLE_VIEW_SELECT = {
	documentId: true,
	projectId: true,
	organizationId: true,
	styleDirection: true,
	primaryColor: true,
	accentColors: true,
	updatedById: true,
	updatedAt: true,
} as const satisfies Prisma.ProjectDocumentStyleSelect;

export type DocumentStyleView = Prisma.ProjectDocumentStyleGetPayload<{
	select: typeof STYLE_VIEW_SELECT;
}>;

/** The document's saved style, scoped to the owning organization. */
export async function getDocumentStyle(input: {
	documentId: string;
	organizationId: string;
}): Promise<DocumentStyleView | null> {
	return db.projectDocumentStyle.findFirst({
		where: {
			documentId: input.documentId,
			organizationId: input.organizationId,
		},
		select: STYLE_VIEW_SELECT,
	});
}

/**
 * Save the document's style, replacing every field. Fields are validated
 * before anything is read. The tenant columns come from the document's
 * project; the document must belong to `projectId`, and `organizationId`,
 * when given, is only checked against the project's.
 */
export async function upsertDocumentStyle(input: {
	documentId: string;
	projectId: string;
	organizationId?: string;
	styleDirection: string | null;
	primaryColor: string | null;
	accentColors: string[];
	updatedById: string | null;
}): Promise<DocumentStyleView> {
	const fields = normalizeDocumentStyleFields(input);

	const document = await db.projectDocument.findFirst({
		where: { id: input.documentId, projectId: input.projectId },
		select: { project: { select: { organizationId: true } } },
	});
	const organizationId = document?.project.organizationId;
	if (!organizationId) {
		throw new ProposalArtifactTenantError(
			"The document is not in an organization project",
		);
	}
	if (input.organizationId && input.organizationId !== organizationId) {
		throw new ProposalArtifactTenantError(
			"The document belongs to another organization",
		);
	}

	return db.projectDocumentStyle.upsert({
		where: { documentId: input.documentId },
		create: {
			documentId: input.documentId,
			projectId: input.projectId,
			organizationId,
			...fields,
			updatedById: input.updatedById,
		},
		update: { ...fields, updatedById: input.updatedById },
		select: STYLE_VIEW_SELECT,
	});
}
