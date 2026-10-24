/**
 * Recurring-error detection bookkeeping.
 *
 * The scheduled scan groups a project's application errors (and its open bug
 * reports) and files a BUG proposal for each group that keeps recurring. These
 * queries are the scan's memory between runs: one `RecurringErrorSignature`
 * per (project, source, fingerprint), so a rescan updates the group it already
 * filed instead of filing it again.
 */

import { TERMINAL_DRAFTING_STAGES } from "../../../utils";
import { db } from "../../client";
import type {
	Prisma,
	RecurringErrorSignature,
	RecurringErrorSource,
} from "../../generated/client";

/** Open = not declined/closed, not auto-hidden by the PM poll, not in a final column. */
const OPEN_STORY_WHERE = {
	draftingStage: { notIn: TERMINAL_DRAFTING_STAGES },
	pmAutoHidden: false,
	status: { isFinal: false },
} satisfies Prisma.UserStoryWhereInput;

export interface ProjectDueForRecurringErrorScan {
	projectId: string;
	organizationId: string | null;
	/** The project owner — the attributed user for proposals the scan files. */
	userId: string;
	threshold: number;
	windowHours: number;
	similarityThreshold: number;
}

/**
 * Projects that opted into recurring-error detection.
 *
 * The toggle is the whole gate: turning it off removes the project from the
 * next sweep, so nothing new is filed (proposals already in the inbox stay
 * there for review). Least-recently-scanned first, with never-scanned
 * projects at the front, so a capped sweep rotates through the estate.
 */
export async function listProjectsDueForRecurringErrorScan(input?: {
	limit?: number;
}): Promise<ProjectDueForRecurringErrorScan[]> {
	const rows = await db.project.findMany({
		where: {
			autoDetectRecurringErrors: true,
			status: { in: ["ACTIVE", "COMPLETED"] },
		},
		select: {
			id: true,
			organizationId: true,
			userId: true,
			recurringErrorThreshold: true,
			recurringErrorWindowHours: true,
			recurringErrorSimilarityThreshold: true,
		},
		orderBy: { recurringErrorLastScanAt: { sort: "asc", nulls: "first" } },
		take: Math.min(input?.limit ?? 200, 500),
	});
	return rows.map((row) => ({
		projectId: row.id,
		organizationId: row.organizationId,
		userId: row.userId,
		threshold: row.recurringErrorThreshold,
		windowHours: row.recurringErrorWindowHours,
		similarityThreshold: row.recurringErrorSimilarityThreshold,
	}));
}

/** Whether the project still has the scan switched on, read at use time. */
export async function isRecurringErrorScanEnabled(
	projectId: string,
): Promise<boolean> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { autoDetectRecurringErrors: true },
	});
	return project?.autoDetectRecurringErrors === true;
}

/**
 * Record the outcome of a scan. `error` is a short, credential-free summary
 * shown beside the toggle; `null` clears a previous failure.
 */
export async function recordRecurringErrorScanOutcome(
	projectId: string,
	outcome: { at: Date; error: string | null },
): Promise<void> {
	await db.project.update({
		where: { id: projectId },
		data: {
			recurringErrorLastScanAt: outcome.at,
			recurringErrorLastScanError: outcome.error?.slice(0, 500) ?? null,
		},
	});
}

export async function findRecurringErrorSignatures(
	projectId: string,
	source: RecurringErrorSource,
	fingerprints: string[],
): Promise<RecurringErrorSignature[]> {
	if (fingerprints.length === 0) {
		return [];
	}
	return db.recurringErrorSignature.findMany({
		where: { projectId, source, fingerprint: { in: fingerprints } },
	});
}

export async function listRecurringErrorSignatures(
	projectId: string,
	source: RecurringErrorSource,
): Promise<RecurringErrorSignature[]> {
	return db.recurringErrorSignature.findMany({
		where: { projectId, source },
	});
}

export interface RecurringErrorObservation {
	title: string;
	occurrenceCount: number;
	affectedUsers: number;
	components: string[];
	firstSeenAt: Date;
	lastSeenAt: Date;
	sampleExcerpts: Prisma.InputJsonValue;
	sourceStoryIds?: string[];
}

/**
 * Insert or refresh one signature with what this scan saw. `firstSeenAt` and
 * `detectedAt` keep their earliest values across scans; everything else is
 * this window's view.
 */
export async function upsertRecurringErrorSignature(
	params: {
		projectId: string;
		source: RecurringErrorSource;
		fingerprint: string;
		observation: RecurringErrorObservation;
		scannedAt: Date;
	},
	client: Prisma.TransactionClient = db,
): Promise<RecurringErrorSignature> {
	const { observation } = params;
	const existing = await client.recurringErrorSignature.findUnique({
		where: {
			projectId_source_fingerprint: {
				projectId: params.projectId,
				source: params.source,
				fingerprint: params.fingerprint,
			},
		},
		select: { firstSeenAt: true },
	});
	const firstSeenAt =
		existing && existing.firstSeenAt < observation.firstSeenAt
			? existing.firstSeenAt
			: observation.firstSeenAt;
	const data = {
		title: observation.title.slice(0, 500),
		occurrenceCount: observation.occurrenceCount,
		affectedUsers: observation.affectedUsers,
		components: observation.components,
		firstSeenAt,
		lastSeenAt: observation.lastSeenAt,
		lastScanAt: params.scannedAt,
		sampleExcerpts: observation.sampleExcerpts,
		...(observation.sourceStoryIds
			? { sourceStoryIds: observation.sourceStoryIds }
			: {}),
	};
	return client.recurringErrorSignature.upsert({
		where: {
			projectId_source_fingerprint: {
				projectId: params.projectId,
				source: params.source,
				fingerprint: params.fingerprint,
			},
		},
		create: {
			projectId: params.projectId,
			source: params.source,
			fingerprint: params.fingerprint,
			detectedAt: params.scannedAt,
			...data,
		},
		update: data,
	});
}

export async function linkRecurringErrorSignature(
	signatureId: string,
	link: { pendingProposalId?: string | null; storyId?: string | null },
	client: Prisma.TransactionClient = db,
): Promise<void> {
	await client.recurringErrorSignature.update({
		where: { id: signatureId },
		data: {
			...(link.pendingProposalId !== undefined
				? { pendingProposalId: link.pendingProposalId }
				: {}),
			...(link.storyId !== undefined ? { storyId: link.storyId } : {}),
		},
	});
}

/**
 * What a signature's earlier filing has become, read at scan time.
 *
 * - `open-story`: the proposal was approved and its BUG is still open — the
 *   recurrence is evidence for that story, not a new ticket.
 * - `pending`: a proposal is still waiting for review (or mid-apply, or failed
 *   and retryable) — refresh it, do not file a second one.
 * - `declined`: a reviewer rejected or parked the proposal — do not re-file a
 *   problem someone already decided about.
 * - `none`: nothing open is tracking it (never filed, the story was closed, or
 *   the proposal was superseded or pruned) — file a new proposal.
 */
export type SignatureTrackingState =
	| { state: "open-story"; storyId: string; organizationId: string | null }
	| { state: "pending"; proposalId: string }
	| { state: "declined"; proposalId: string }
	| { state: "none" };

export async function resolveSignatureTracking(
	signature: Pick<
		RecurringErrorSignature,
		"projectId" | "pendingProposalId" | "storyId"
	>,
): Promise<SignatureTrackingState> {
	let storyId = signature.storyId;
	if (!storyId && signature.pendingProposalId) {
		const proposal = await db.pendingBacklogProposal.findUnique({
			where: { id: signature.pendingProposalId },
			select: {
				id: true,
				status: true,
				applications: {
					where: { createdEntityId: { not: null } },
					select: { createdEntityId: true },
					orderBy: { changeIndex: "asc" },
					take: 1,
				},
			},
		});
		if (proposal) {
			switch (proposal.status) {
				case "PENDING":
				case "APPROVED":
				case "APPLYING":
				case "FAILED":
					return { state: "pending", proposalId: proposal.id };
				case "REJECTED":
				case "BACKLOG":
					return { state: "declined", proposalId: proposal.id };
				case "APPLIED":
					// Not every approve path writes application rows: the one the
					// review inbox uses for scan proposals links the story it
					// creates through `createdFromProposalId` instead.
					storyId =
						proposal.applications[0]?.createdEntityId ??
						(
							await db.userStory.findFirst({
								where: {
									createdFromProposalId: proposal.id,
									projectId: signature.projectId,
								},
								select: { id: true },
								orderBy: { createdAt: "asc" },
							})
						)?.id ??
						null;
					break;
				case "SUPERSEDED":
					break;
				default: {
					const unreachable: never = proposal.status;
					throw new Error(
						`Unhandled proposal status: ${unreachable}`,
					);
				}
			}
		}
	}
	if (!storyId) {
		return { state: "none" };
	}
	const story = await db.userStory.findFirst({
		where: {
			id: storyId,
			projectId: signature.projectId,
			...OPEN_STORY_WHERE,
		},
		select: { id: true, project: { select: { organizationId: true } } },
	});
	return story
		? {
				state: "open-story",
				storyId: story.id,
				organizationId: story.project.organizationId,
			}
		: { state: "none" };
}

/** A project's open BUG stories, newest first. */
export async function listOpenBugStoriesForClustering(
	projectId: string,
	limit = 200,
): Promise<Array<{ id: string; identifier: string; title: string }>> {
	return db.userStory.findMany({
		where: { projectId, kind: "BUG", ...OPEN_STORY_WHERE },
		select: { id: true, identifier: true, title: true },
		orderBy: { createdAt: "desc" },
		take: limit,
	});
}

/**
 * A project's open BUG stories with the fields their detection text is built
 * from (`detectionTextForStory`), newest first, for matching a recurring
 * error to a bug someone already filed.
 */
export async function listOpenBugStoriesForMatching(
	projectId: string,
	limit = 200,
) {
	return db.userStory.findMany({
		where: { projectId, kind: "BUG", ...OPEN_STORY_WHERE },
		select: {
			id: true,
			identifier: true,
			title: true,
			description: true,
			acceptanceCriteria: true,
			tasks: {
				select: { title: true, description: true },
				orderBy: { createdAt: "asc" },
			},
		},
		orderBy: { createdAt: "desc" },
		take: limit,
	});
}

/**
 * Confirmed-duplicate edges among the given stories: pairs the duplicate
 * detector's verifier judged to be the same problem, with at least
 * `minConfidence`, and nobody dismissed. The detector itself only records a
 * link at its own threshold, so a lower `minConfidence` admits nothing more.
 */
export async function listDuplicateEdgesAmong(
	projectId: string,
	storyIds: string[],
	minConfidence: number,
): Promise<Array<{ storyAId: string; storyBId: string }>> {
	if (storyIds.length < 2) {
		return [];
	}
	return db.storyDuplicateLink.findMany({
		where: {
			projectId,
			status: "PENDING",
			linkType: "DUPLICATE",
			confidence: { gte: minConfidence },
			storyAId: { in: storyIds },
			storyBId: { in: storyIds },
		},
		select: { storyAId: true, storyBId: true },
	});
}

/**
 * A project's log-error proposals still awaiting review, newest first, with
 * the text a later error group is compared against: a group that is the same
 * problem joins the proposal instead of filing a second one.
 */
export async function listPendingLogProposalsForMatching(
	projectId: string,
	limit = 50,
): Promise<Array<{ id: string; summary: string; evidence: string }>> {
	const proposals = await db.pendingBacklogProposal.findMany({
		where: { projectId, source: "LOG_MONITOR", status: "PENDING" },
		select: { id: true, summary: true, sourceMetadata: true },
		orderBy: { createdAt: "desc" },
		take: limit,
	});
	return proposals.map((proposal) => {
		const metadata = jsonObject(proposal.sourceMetadata);
		return {
			id: proposal.id,
			summary: proposal.summary ?? "",
			evidence: primaryEvidence(metadata),
		};
	});
}

function jsonObject(value: Prisma.JsonValue | undefined): Prisma.JsonObject {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}

/** The evidence of the group a proposal was filed for, without related ones. */
function primaryEvidence(metadata: Prisma.JsonObject): string {
	const own = metadata.recurringErrorEvidence ?? metadata.transcript;
	return typeof own === "string" ? own : "";
}

interface RelatedErrorEvidence {
	fingerprint: string;
	title: string;
	evidence: string;
	recurringError: Prisma.JsonObject;
}

function relatedErrors(metadata: Prisma.JsonObject): RelatedErrorEvidence[] {
	const list = metadata.relatedErrors;
	if (!Array.isArray(list)) {
		return [];
	}
	return list.flatMap((item) => {
		const entry = jsonObject(item);
		return typeof entry.fingerprint === "string" &&
			typeof entry.title === "string" &&
			typeof entry.evidence === "string"
			? [
					{
						fingerprint: entry.fingerprint,
						title: entry.title,
						evidence: entry.evidence,
						recurringError: jsonObject(entry.recurringError),
					},
				]
			: [];
	});
}

/**
 * A proposal's stored transcript: its own group's evidence, then each related
 * group's under its headline. It is what the reviewer reads as the evidence
 * and what the approve path hands the drafting step.
 */
export function composeRecurringErrorTranscript(
	own: string,
	related: Array<{ title: string; evidence: string }>,
): string {
	if (related.length === 0) {
		return own;
	}
	return [
		own,
		"",
		"Other recurring errors the scan judged to be the same problem:",
		...related.flatMap((entry) => [
			"",
			`#### ${entry.title}`,
			"",
			entry.evidence,
		]),
	].join("\n");
}

/**
 * Refresh the evidence on a proposal still awaiting review, so the reviewer
 * sees the current frequency rather than the count at filing time. Only a
 * PENDING row is touched: one already claimed for apply keeps what the
 * reviewer approved. Returns whether the row was updated.
 *
 * The group the proposal was filed for replaces the proposal's own evidence.
 * Any other group, one the scan judged to be the same problem, is kept as a
 * related error alongside it, one entry per fingerprint, so neither group's
 * refresh overwrites the other's.
 */
export async function refreshRecurringErrorProposalEvidence(
	proposalId: string,
	evidence: {
		fingerprint: string;
		title: string;
		recurringError: Prisma.InputJsonObject;
		transcript: string;
	},
): Promise<boolean> {
	const proposal = await db.pendingBacklogProposal.findUnique({
		where: { id: proposalId },
		select: { status: true, sourceMetadata: true },
	});
	if (!proposal || proposal.status !== "PENDING") {
		return false;
	}
	const base = jsonObject(proposal.sourceMetadata);
	const ownFingerprint = jsonObject(base.recurringError).fingerprint;
	const isOwn =
		typeof ownFingerprint !== "string" ||
		ownFingerprint === evidence.fingerprint;
	const own = isOwn ? evidence.transcript : primaryEvidence(base);
	const related: Array<
		Omit<RelatedErrorEvidence, "recurringError"> & {
			recurringError: Prisma.InputJsonObject;
		}
	> = relatedErrors(base).filter(
		(entry) => entry.fingerprint !== evidence.fingerprint,
	);
	if (!isOwn) {
		related.push({
			fingerprint: evidence.fingerprint,
			title: evidence.title,
			evidence: evidence.transcript,
			recurringError: evidence.recurringError,
		});
	}
	const updated = await db.pendingBacklogProposal.updateMany({
		where: { id: proposalId, status: "PENDING" },
		data: {
			sourceMetadata: {
				...base,
				recurringError: isOwn
					? evidence.recurringError
					: base.recurringError,
				recurringErrorEvidence: own,
				relatedErrors: related.map((entry) => ({ ...entry })),
				transcript: composeRecurringErrorTranscript(own, related),
			},
		},
	});
	return updated.count > 0;
}
