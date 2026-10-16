/**
 * Proposal artifact (Fizzy #2946) — claiming a re-run of a document's
 * Internal Analysis, and choosing the run whose source material it reads.
 */

import { createId } from "@paralleldrive/cuid2";
import { db, type Prisma } from "../../client";
import { computeDocumentContentHash } from "./documents";
import {
	type ComputeProseHash,
	capErrorMessage,
	isAnalysisRunTimedOut,
	NEWEST_FIRST,
	type ProposalClient,
	resolveProseHashes,
} from "./proposal-artifact-runs";
import {
	assertDocumentOrganization,
	PROPOSAL_ANALYSIS_MATCH_WINDOW,
	PROPOSAL_ANALYSIS_TIMED_OUT_FAILURE,
	type ProposalAnalysisStatus,
	ProposalArtifactTenantError,
} from "./proposal-artifact-shared";

/** The workflow id of a re-run, which is also its row's unique `runKey`. */
export function proposalAnalysisRerunKey(
	documentId: string,
	analysisId: string,
): string {
	return `proposal-analysis-rerun-${documentId}-${analysisId}`;
}

export type ClaimRerunConflictReason =
	/** The document is QUEUED or GENERATING. */
	| "DOCUMENT_GENERATING"
	/** A PENDING or RUNNING run has not timed out. */
	| "ANALYSIS_IN_PROGRESS";

export interface ClaimRerunInput {
	/** The owning organization the caller resolved; checked, never stored. */
	organizationId: string;
	projectId: string;
	documentId: string;
	/** The analysis prompt version resolved for the requesting member. */
	promptVersionId: string | null;
	/** Hashes the content read under the lock, and older runs' bodies. */
	computeProseHash: ComputeProseHash;
	/**
	 * What to record on a run found timed out. Defaults to
	 * {@link PROPOSAL_ANALYSIS_TIMED_OUT_FAILURE}.
	 */
	timeoutFailure?: { errorCode: string; errorMessage: string };
	now?: Date;
}

export interface ClaimedRerun {
	analysisId: string;
	/** Also the workflow id to start. */
	runKey: string;
	/** The run whose source material the re-run reads; null when none. */
	sourceRunId: string | null;
	proseHash: string;
	contentHash: string;
	documentVersion: number;
	/** Runs this claim found silent past the timeout and marked FAILED. */
	timedOutRunIds: string[];
}

export type ClaimRerunResult =
	| { outcome: "claimed"; run: ClaimedRerun }
	| { outcome: "conflict"; reason: ClaimRerunConflictReason };

interface LockedDocument {
	id: string;
	projectId: string;
	content: string;
	version: number;
	status: string;
	organizationId: string | null;
}

interface LockedRun {
	id: string;
	status: ProposalAnalysisStatus;
	updatedAt: Date;
}

/**
 * A GENERATION run whose stored source context a re-run may read: a COMPLETE
 * one (with or without context — a generation that had no sources gives the
 * re-run none), or a FAILED one that stored context before its analysis
 * failed (a model error, a timeout). A run recorded FAILED without starting —
 * a project guest's generation, an unbound analysis prompt — stored no
 * context, so it never qualifies; neither does a RERUN row, which stores none
 * of its own.
 */
const RERUN_SOURCE_CANDIDATE: Prisma.ProjectDocumentAnalysisWhereInput = {
	kind: "GENERATION",
	OR: [
		{ status: "COMPLETE" },
		{ status: "FAILED", NOT: { sourceContext: "" } },
	],
};

/**
 * The source run of a re-run (Fizzy #2946): the newest candidate GENERATION
 * run ({@link RERUN_SOURCE_CANDIDATE}) that describes the content being
 * re-analysed — so after a Reject, the sources of the content it restored,
 * and after the latest generation's analysis failed, that generation's own
 * sources, which a re-run is the way to recover — else the newest COMPLETE or
 * FAILED GENERATION run that stored any source context, else none.
 *
 * A run describes the content when its stored prose hash equals the
 * content's; that is looked up across the document's whole history, so
 * content restored from a generation however far back still finds that
 * generation's sources. Only when no stored hash matches are the newest
 * {@link PROPOSAL_ANALYSIS_MATCH_WINDOW} candidates searched again with a
 * hash computed from the analyzed body for each run whose stored hash is
 * missing (recorded before prose hashes existed) or from another normalizer
 * version, which in practice predate every run hashed as the content is now.
 *
 * Called after the claim has marked timed-out runs FAILED, so a timed-out
 * generation run that stored context is a candidate like any other failed
 * one. A PENDING or RUNNING run never is.
 */
async function chooseRerunSource(
	client: ProposalClient,
	input: {
		documentId: string;
		organizationId: string;
		currentProseHash: string;
		computeProseHash: ComputeProseHash;
	},
): Promise<{ id: string; contextCount: number } | null> {
	const scope = {
		documentId: input.documentId,
		organizationId: input.organizationId,
	};
	const stored = await client.projectDocumentAnalysis.findFirst({
		where: {
			...scope,
			...RERUN_SOURCE_CANDIDATE,
			proseHash: input.currentProseHash,
		},
		orderBy: NEWEST_FIRST,
		select: { id: true, contextCount: true },
	});
	if (stored) {
		return stored;
	}
	const generations = await client.projectDocumentAnalysis.findMany({
		where: { ...scope, ...RERUN_SOURCE_CANDIDATE },
		orderBy: NEWEST_FIRST,
		take: PROPOSAL_ANALYSIS_MATCH_WINDOW,
		select: { id: true, proseHash: true, contextCount: true },
	});
	const hashes = await resolveProseHashes(client, generations, input);
	const describing = generations.find(
		(run) => hashes.get(run.id) === input.currentProseHash,
	);
	if (describing) {
		return { id: describing.id, contextCount: describing.contextCount };
	}
	return client.projectDocumentAnalysis.findFirst({
		where: {
			...scope,
			kind: "GENERATION",
			status: { in: ["COMPLETE", "FAILED"] },
			NOT: { sourceContext: "" },
		},
		orderBy: NEWEST_FIRST,
		select: { id: true, contextCount: true },
	});
}

/**
 * Claim a re-run of the document's Internal Analysis over its current
 * content, atomically: of two claims at once, one creates the run and the
 * other answers `conflict`.
 *
 * One transaction. The document row is locked first (`FOR UPDATE`), then its
 * PENDING and RUNNING runs, always in that order, so two claims serialize on
 * the document and never deadlock on the runs. Then:
 *  - a QUEUED or GENERATING document answers `DOCUMENT_GENERATING`;
 *  - a PENDING or RUNNING run that has not timed out by the shared rule
 *    ({@link isAnalysisRunTimedOut}: silence, not age) answers
 *    `ANALYSIS_IN_PROGRESS`, and nothing is written;
 *  - runs that have timed out are marked FAILED and stop blocking; a late
 *    completion of one is refused, as for any FAILED run;
 *  - the RERUN row is inserted PENDING with the document's current content,
 *    its hashes and version, an empty `sourceContext`, the source run chosen
 *    by {@link chooseRerunSource}, its context count, and the pinned prompt
 *    version.
 *
 * The row id is minted here, before the insert, because the `runKey` (the
 * workflow id) embeds it. Tenant columns come from the document's project;
 * the caller's organization and project are only checked against them.
 */
export async function claimRerun(
	input: ClaimRerunInput,
): Promise<ClaimRerunResult> {
	const now = input.now ?? new Date();
	const failure = input.timeoutFailure ?? PROPOSAL_ANALYSIS_TIMED_OUT_FAILURE;
	return db.$transaction(async (tx) => {
		const [document] = await tx.$queryRaw<LockedDocument[]>`
			SELECT d."id", d."projectId", d."content", d."version",
				d."status"::text AS "status", p."organizationId"
			FROM "project_document" d
			JOIN "project" p ON p."id" = d."projectId"
			WHERE d."id" = ${input.documentId}
			FOR UPDATE OF d`;
		assertDocumentOrganization(
			document?.organizationId,
			input.organizationId,
		);
		const organizationId = document.organizationId;
		if (input.projectId !== document.projectId) {
			throw new ProposalArtifactTenantError(
				"The document belongs to another project",
			);
		}
		if (document.status === "QUEUED" || document.status === "GENERATING") {
			return {
				outcome: "conflict" as const,
				reason: "DOCUMENT_GENERATING" as const,
			};
		}

		const inFlight = await tx.$queryRaw<LockedRun[]>`
			SELECT "id", "status"::text AS "status", "updatedAt"
			FROM "project_document_analysis"
			WHERE "documentId" = ${input.documentId}
				AND "organizationId" = ${organizationId}
				AND "status" IN ('PENDING', 'RUNNING')
			ORDER BY "id"
			FOR UPDATE`;
		if (inFlight.some((run) => !isAnalysisRunTimedOut(run, now))) {
			return {
				outcome: "conflict" as const,
				reason: "ANALYSIS_IN_PROGRESS" as const,
			};
		}
		const timedOutRunIds = inFlight.map((run) => run.id);
		if (timedOutRunIds.length > 0) {
			await tx.projectDocumentAnalysis.updateMany({
				where: {
					id: { in: timedOutRunIds },
					status: { in: ["PENDING", "RUNNING"] },
				},
				data: {
					status: "FAILED",
					errorCode: failure.errorCode,
					errorMessage: capErrorMessage(failure.errorMessage),
					completedAt: now,
				},
			});
		}

		const proseHash = input.computeProseHash(document.content);
		const source = await chooseRerunSource(tx, {
			documentId: input.documentId,
			organizationId,
			currentProseHash: proseHash,
			computeProseHash: input.computeProseHash,
		});
		const analysisId = createId();
		const run = await tx.projectDocumentAnalysis.create({
			data: {
				id: analysisId,
				organizationId,
				projectId: document.projectId,
				documentId: input.documentId,
				runKey: proposalAnalysisRerunKey(input.documentId, analysisId),
				status: "PENDING",
				kind: "RERUN",
				sourceRunId: source?.id ?? null,
				analyzedContent: document.content,
				contentHash: computeDocumentContentHash(document.content),
				proseHash,
				sourceContext: "",
				documentVersion: document.version,
				contextCount: source?.contextCount ?? 0,
				promptVersionId: input.promptVersionId,
			},
			select: {
				id: true,
				runKey: true,
				sourceRunId: true,
				contentHash: true,
			},
		});
		return {
			outcome: "claimed" as const,
			run: {
				analysisId: run.id,
				runKey: run.runKey,
				sourceRunId: run.sourceRunId,
				proseHash,
				contentHash: run.contentHash,
				documentVersion: document.version,
				timedOutRunIds,
			},
		};
	});
}
