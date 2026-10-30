/**
 * Proposal artifact (Fizzy #2946) — the members' answers to analysis
 * findings.
 *
 * Answers to findings belong to the document and the finding's stable key,
 * never to a run, so every run after the answer still finds it. They are
 * written only through a compare-and-swap on the row's `id` and `version`:
 * clearing deletes the row and a new answer starts again at version 1, so the
 * version alone could not tell a cleared-and-given-again answer from the one
 * a member saw.
 */

import { db, type Prisma } from "../../client";
import { sanitizeContent } from "./documents";
import {
	assertDocumentOrganization,
	PROPOSAL_FINDING_ANSWER_KINDS,
	PROPOSAL_FINDING_RESPONSE_TEXT_MAX_LENGTH,
	ProposalArtifactTenantError,
	type ProposalFindingAnswerKind,
	type ProposalFindingResponseKind,
} from "./proposal-artifact-shared";

export type FindingResponseValidationCode =
	| "invalidKind"
	| "textRequired"
	| "textTooLong";

export class FindingResponseValidationError extends Error {
	constructor(readonly code: FindingResponseValidationCode) {
		super(`Invalid finding response: ${code}`);
		this.name = "FindingResponseValidationError";
	}
}

/**
 * Validate an answer's kind and text and normalize the text: trimmed, null
 * when empty. RESPONDED needs text; CONFIRMED may carry none. Text over
 * {@link PROPOSAL_FINDING_RESPONSE_TEXT_MAX_LENGTH} is refused, never cut: a
 * member typed it.
 */
export function normalizeFindingResponseText(
	kind: ProposalFindingAnswerKind,
	text: string | null | undefined,
): string | null {
	// RESOLVED is stored too, but only the save of an applied recommendation
	// writes it; the answer path refuses it.
	if (!(PROPOSAL_FINDING_ANSWER_KINDS as readonly string[]).includes(kind)) {
		throw new FindingResponseValidationError("invalidKind");
	}
	const trimmed = text ? sanitizeContent(text).trim() : "";
	if (trimmed.length > PROPOSAL_FINDING_RESPONSE_TEXT_MAX_LENGTH) {
		throw new FindingResponseValidationError("textTooLong");
	}
	if (kind === "RESPONDED" && !trimmed) {
		throw new FindingResponseValidationError("textRequired");
	}
	return trimmed || null;
}

const FINDING_RESPONSE_VIEW_SELECT = {
	id: true,
	documentId: true,
	stableKey: true,
	kind: true,
	text: true,
	findingTitle: true,
	answeredRunId: true,
	sectionKey: true,
	sectionHash: true,
	authorId: true,
	version: true,
	createdAt: true,
	updatedAt: true,
} as const satisfies Prisma.ProjectDocumentFindingResponseSelect;

export type FindingResponseView =
	Prisma.ProjectDocumentFindingResponseGetPayload<{
		select: typeof FINDING_RESPONSE_VIEW_SELECT;
	}>;

const FINDING_RESPONSE_CURRENT_SELECT = {
	id: true,
	kind: true,
	text: true,
	authorId: true,
	version: true,
	updatedAt: true,
} as const satisfies Prisma.ProjectDocumentFindingResponseSelect;

/**
 * The saved answer a refused write is told about. Its `id` and `version` are
 * the token a further write or clear of it must send.
 */
export type FindingResponseCurrent =
	Prisma.ProjectDocumentFindingResponseGetPayload<{
		select: typeof FINDING_RESPONSE_CURRENT_SELECT;
	}>;

interface UpsertFindingResponseFields {
	/** The owning organization the caller resolved; checked, never stored. */
	organizationId: string;
	projectId: string;
	documentId: string;
	stableKey: string;
	kind: ProposalFindingAnswerKind;
	text?: string | null;
	/** A copy of the answered finding's title. */
	findingTitle: string;
	/** The run whose finding is answered; must be this document's. */
	answeredRunId: string;
	/** The finding's section key and that section's current prose hash. */
	sectionKey: string;
	sectionHash: string;
	/** The session user. Never taken from request input. */
	authorId: string | null;
}

/**
 * The answer the member saw, by row `id` and `version`, given together or not
 * at all. Omitted when they saw none: then the write only creates, and an
 * answer saved meanwhile makes it `stale`. Given, the write only replaces
 * that exact row at that exact version, and an answer changed, cleared, or
 * cleared and given again meanwhile (a new row, back at version 1) makes it
 * `stale`.
 */
type UpsertFindingResponseExpectation =
	| { expectedResponseId?: undefined; expectedVersion?: undefined }
	| { expectedResponseId: string; expectedVersion: number };

export type UpsertFindingResponseInput = UpsertFindingResponseFields &
	UpsertFindingResponseExpectation;

export type UpsertFindingResponseResult =
	| { outcome: "written"; response: FindingResponseView }
	/** `current` is the saved answer, or null when it was cleared. */
	| { outcome: "stale"; current: FindingResponseCurrent | null };

/**
 * The document's project and owning organization, checked against what the
 * caller resolved. Fails closed: a missing document, a project outside any
 * organization, or a mismatch throws {@link ProposalArtifactTenantError}.
 */
async function documentTenant(
	client: Pick<typeof db, "projectDocument">,
	input: { documentId: string; projectId: string; organizationId: string },
): Promise<{ organizationId: string; projectId: string }> {
	const document = await client.projectDocument.findFirst({
		where: { id: input.documentId, projectId: input.projectId },
		select: {
			projectId: true,
			project: { select: { organizationId: true } },
		},
	});
	assertDocumentOrganization(
		document?.project.organizationId,
		input.organizationId,
	);
	return {
		organizationId: document.project.organizationId,
		projectId: document.projectId,
	};
}

/**
 * Save a member's answer to a finding, as a compare-and-swap on the row's
 * `id` and `version`.
 *
 * Without an expectation the write is an `INSERT … ON CONFLICT DO NOTHING`
 * on `(documentId, stableKey)`; with one, an `UPDATE` guarded on that row id
 * and version, which bumps the version. Either way two writers racing on one
 * key leave one row, never a unique-key error: the loser waits on the
 * winner's row lock, finds the row or version it expected gone, and answers
 * `stale` with the saved answer. Every field is replaced on a write, the
 * author too.
 *
 * The text and the expectation are validated before anything is read. Tenant
 * columns come from the document's project; the answered run must be a run
 * of this document in the same organization.
 */
export async function upsertFindingResponse(
	input: UpsertFindingResponseInput,
): Promise<UpsertFindingResponseResult> {
	const text = normalizeFindingResponseText(input.kind, input.text);
	if (
		(input.expectedResponseId === undefined) !==
		(input.expectedVersion === undefined)
	) {
		// A version without the row it belongs to could match a row cleared
		// and given again since; the caller must send both or neither.
		throw new TypeError(
			"expectedResponseId and expectedVersion are given together or not at all",
		);
	}
	return db.$transaction(async (tx) => {
		const { organizationId, projectId } = await documentTenant(tx, input);
		const answeredRun = await tx.projectDocumentAnalysis.findFirst({
			where: {
				id: input.answeredRunId,
				documentId: input.documentId,
				organizationId,
			},
			select: { id: true },
		});
		if (!answeredRun) {
			throw new ProposalArtifactTenantError(
				"The answered run is not a run of this document",
			);
		}

		const key = {
			documentId: input.documentId,
			stableKey: input.stableKey,
			organizationId,
		};
		const fields = {
			kind: input.kind,
			text,
			findingTitle: sanitizeContent(input.findingTitle),
			answeredRunId: input.answeredRunId,
			sectionKey: input.sectionKey,
			sectionHash: input.sectionHash,
			authorId: input.authorId,
		};
		const { count } =
			input.expectedResponseId === undefined
				? await tx.projectDocumentFindingResponse.createMany({
						data: [
							{
								organizationId,
								projectId,
								documentId: input.documentId,
								stableKey: input.stableKey,
								...fields,
							},
						],
						skipDuplicates: true,
					})
				: await tx.projectDocumentFindingResponse.updateMany({
						where: {
							...key,
							id: input.expectedResponseId,
							version: input.expectedVersion,
						},
						data: { ...fields, version: { increment: 1 } },
					});

		if (count > 0) {
			// The write holds the row lock until commit, so this reads it.
			const response = await tx.projectDocumentFindingResponse.findFirst({
				where: key,
				select: FINDING_RESPONSE_VIEW_SELECT,
			});
			if (response) {
				return { outcome: "written" as const, response };
			}
		}
		const current = await tx.projectDocumentFindingResponse.findFirst({
			where: key,
			select: FINDING_RESPONSE_CURRENT_SELECT,
		});
		return { outcome: "stale" as const, current };
	});
}

/**
 * The answer a finding-driven revision started from is no longer the one
 * saved: it was given, changed or cleared since. Thrown by
 * {@link writeResolvedFindingResponse} inside the save's transaction, so the
 * body saved with it rolls back too.
 */
export class FindingResponseChangedError extends Error {
	constructor(
		readonly documentId: string,
		readonly stableKey: string,
	) {
		super(
			`The answer to finding ${stableKey} on document ${documentId} changed since the revision started`,
		);
		this.name = "FindingResponseChangedError";
	}
}

export interface WriteResolvedFindingResponseInput {
	/** The owning organization the caller resolved; checked, never stored. */
	organizationId: string;
	projectId: string;
	documentId: string;
	stableKey: string;
	/** A copy of the resolved finding's title. */
	findingTitle: string;
	/** The run whose finding's recommendation was applied. */
	answeredRunId: string;
	/** The finding's section key and its prose hash in the body as saved. */
	sectionKey: string;
	sectionHash: string;
	/** The session user who saved the revision. */
	authorId: string;
	/**
	 * The answer the revision started from, by row `id` and `version`, or
	 * null when there was none: then the write only creates.
	 */
	expected: { id: string; version: number } | null;
}

/**
 * Record a finding as RESOLVED, inside the transaction that saves the
 * revision applying its recommendation (Fizzy #2946). Nothing else writes
 * RESOLVED: the member answer path refuses it.
 *
 * A compare-and-swap on the answer the revision started from, as in
 * {@link upsertFindingResponse}: with none, an `INSERT … ON CONFLICT DO
 * NOTHING`; with one, an `UPDATE` guarded on that row id and version, which
 * bumps the version. Anything else saved meanwhile throws
 * {@link FindingResponseChangedError}. Earlier answer text is kept: an
 * applied recommendation does not erase what a member said about it. The
 * author becomes the person who saved the revision.
 */
export async function writeResolvedFindingResponse(
	tx: Prisma.TransactionClient,
	input: WriteResolvedFindingResponseInput,
): Promise<FindingResponseView> {
	const { organizationId, projectId } = await documentTenant(tx, input);
	const answeredRun = await tx.projectDocumentAnalysis.findFirst({
		where: {
			id: input.answeredRunId,
			documentId: input.documentId,
			organizationId,
		},
		select: { id: true },
	});
	if (!answeredRun) {
		throw new ProposalArtifactTenantError(
			"The answered run is not a run of this document",
		);
	}

	const key = {
		documentId: input.documentId,
		stableKey: input.stableKey,
		organizationId,
	};
	const fields = {
		kind: "RESOLVED" as const,
		findingTitle: sanitizeContent(input.findingTitle),
		answeredRunId: input.answeredRunId,
		sectionKey: input.sectionKey,
		sectionHash: input.sectionHash,
		authorId: input.authorId,
	};
	const { count } =
		input.expected === null
			? await tx.projectDocumentFindingResponse.createMany({
					data: [
						{
							organizationId,
							projectId,
							documentId: input.documentId,
							stableKey: input.stableKey,
							text: null,
							...fields,
						},
					],
					skipDuplicates: true,
				})
			: await tx.projectDocumentFindingResponse.updateMany({
					where: {
						...key,
						id: input.expected.id,
						version: input.expected.version,
					},
					// `text` is left as it is.
					data: { ...fields, version: { increment: 1 } },
				});
	const response =
		count > 0
			? await tx.projectDocumentFindingResponse.findFirst({
					where: key,
					select: FINDING_RESPONSE_VIEW_SELECT,
				})
			: null;
	if (!response) {
		throw new FindingResponseChangedError(
			input.documentId,
			input.stableKey,
		);
	}
	return response;
}

export type ClearFindingResponseResult =
	| { outcome: "cleared"; kind: ProposalFindingResponseKind }
	| { outcome: "stale"; current: FindingResponseCurrent }
	| { outcome: "not_found" };

/**
 * Remove a member's answer, only while it is still the row `responseId` at
 * `version`: an answer edited, or cleared and given again (a new row, back at
 * version 1), since the member saw it is never removed. Keyed by document and
 * stable key, so an answer whose key no run raises any more can be cleared
 * too. `stale` carries the saved answer; `not_found` means there is no answer
 * for the key in the owning organization.
 */
export async function clearFindingResponse(input: {
	organizationId: string;
	documentId: string;
	stableKey: string;
	/** The `id` of the answer the member saw. */
	responseId: string;
	/** The `version` of the answer the member saw. */
	version: number;
}): Promise<ClearFindingResponseResult> {
	const key = {
		documentId: input.documentId,
		stableKey: input.stableKey,
		organizationId: input.organizationId,
	};
	return db.$transaction(async (tx) => {
		const current = await tx.projectDocumentFindingResponse.findFirst({
			where: key,
			select: FINDING_RESPONSE_CURRENT_SELECT,
		});
		if (!current) {
			return { outcome: "not_found" as const };
		}
		if (
			current.id === input.responseId &&
			current.version === input.version
		) {
			const { count } =
				await tx.projectDocumentFindingResponse.deleteMany({
					where: {
						...key,
						id: input.responseId,
						version: input.version,
					},
				});
			if (count > 0) {
				return { outcome: "cleared" as const, kind: current.kind };
			}
		}
		// Changed between the read and the delete, or another row or version.
		const now = await tx.projectDocumentFindingResponse.findFirst({
			where: key,
			select: FINDING_RESPONSE_CURRENT_SELECT,
		});
		return now
			? { outcome: "stale" as const, current: now }
			: { outcome: "not_found" as const };
	});
}

/**
 * Every answer on the document in the owning organization, oldest first.
 * Includes answers whose key no run raises any more.
 */
export async function listResponsesForDocument(input: {
	organizationId: string;
	documentId: string;
}): Promise<FindingResponseView[]> {
	return db.projectDocumentFindingResponse.findMany({
		where: {
			documentId: input.documentId,
			organizationId: input.organizationId,
		},
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		select: FINDING_RESPONSE_VIEW_SELECT,
	});
}
