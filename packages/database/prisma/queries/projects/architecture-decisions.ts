/**
 * Database queries for the Architecture Decision Log (ADL).
 *
 * Project-scoped architecture decisions with threaded comments and per-save
 * version history. Mirrors the tenant-XOR pattern used by stories/documents:
 * tenant isolation is enforced by RLS + the procedure layer; these helpers
 * filter by `projectId` (+ `organizationId` for comments, like comments.ts).
 */

import { type ArchitectureDecisionStatus, db, type Prisma } from "../../client";

// ---------------------------------------------------------------------------
// Identifier generation (ADR-001, per project)
// ---------------------------------------------------------------------------

/**
 * Compute the next per-project ADR identifier (e.g. "ADR-001"). Ordered by
 * createdAt desc (not the string) so it never breaks at the 999→1000 padding
 * boundary — numbers are assigned monotonically with creation.
 */
export async function generateArchitectureDecisionIdentifier(
	projectId: string,
): Promise<string> {
	const last = await db.architectureDecision.findFirst({
		where: { projectId },
		orderBy: { createdAt: "desc" },
		select: { identifier: true },
	});
	return nextIdentifierFrom(last?.identifier);
}

function nextIdentifierFrom(previous: string | undefined | null): string {
	if (!previous) {
		return "ADR-001";
	}
	const match = previous.match(/ADR-(\d+)/);
	const nextNum = match ? Number.parseInt(match[1], 10) + 1 : 1;
	return `ADR-${String(nextNum).padStart(3, "0")}`;
}

function isUniqueIdentifierViolation(error: unknown): boolean {
	return (
		error instanceof Object &&
		"code" in error &&
		(error as { code?: string }).code === "P2002"
	);
}

// ---------------------------------------------------------------------------
// Select shapes
// ---------------------------------------------------------------------------

const decisionListSelect = {
	id: true,
	identifier: true,
	title: true,
	rationale: true,
	status: true,
	domain: true,
	decisionTypeId: true,
	decisionType: { select: { id: true, name: true } },
	ownerUserId: true,
	duration: true,
	priorityFlagged: true,
	priorityFlaggedAt: true,
	decisionDate: true,
	participantUserIds: true,
	participantsText: true,
	supersededById: true,
	relatedDecisionIds: true,
	pinnedAt: true,
	vouchedAt: true,
	vouchedById: true,
	createdById: true,
	lastEditedById: true,
	currentVersion: true,
	sourceKind: true,
	createdAt: true,
	updatedAt: true,
	_count: { select: { comments: { where: { deletedAt: null } } } },
} as const;

const decisionDetailSelect = {
	id: true,
	projectId: true,
	identifier: true,
	title: true,
	contextProblem: true,
	decision: true,
	rationale: true,
	decisionDrivers: true,
	alternativesConsidered: true,
	consequences: true,
	status: true,
	domain: true,
	decisionTypeId: true,
	decisionType: { select: { id: true, name: true } },
	ownerUserId: true,
	duration: true,
	priorityFlagged: true,
	priorityFlaggedAt: true,
	decisionDate: true,
	participantUserIds: true,
	participantsText: true,
	supersededById: true,
	relatedDecisionIds: true,
	pinnedAt: true,
	vouchedAt: true,
	vouchedById: true,
	createdById: true,
	lastEditedById: true,
	currentVersion: true,
	contextId: true,
	sourceKind: true,
	sourceMetadata: true,
	userId: true,
	organizationId: true,
	createdAt: true,
	updatedAt: true,
	_count: { select: { comments: { where: { deletedAt: null } } } },
} as const;

const adlCommentSelect = {
	id: true,
	content: true,
	authorType: true,
	authorId: true,
	parentId: true,
	decisionVersion: true,
	createdAt: true,
	updatedAt: true,
	author: { select: { id: true, name: true, image: true, email: true } },
} as const;

export type ArchitectureDecisionDetail = Prisma.ArchitectureDecisionGetPayload<{
	select: typeof decisionDetailSelect;
}>;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateArchitectureDecisionInput {
	projectId: string;
	createdById: string;
	/** Display name of the author, snapshotted into version history. */
	editedByName: string;
	title: string;
	contextProblem: string;
	decision: string;
	rationale: string;
	decisionDrivers?: string | null;
	alternativesConsidered?: string | null;
	consequences?: string | null;
	status?: ArchitectureDecisionStatus;
	domain?: string | null;
	decisionDate?: Date;
	participantUserIds?: string[];
	participantsText?: string | null;
	supersededById?: string | null;
	relatedDecisionIds?: string[];
	// Tagging metadata (type row-id, accountable owner, horizon, roadmap flag).
	decisionTypeId?: string | null;
	ownerUserId?: string | null;
	duration?: "LONG_STANDING" | "SHORT_TERM" | null;
	priorityFlagged?: boolean;
	sourceKind?: string | null;
	sourceMetadata?: Prisma.InputJsonValue;
	userId?: string | null;
	organizationId?: string | null;
}

export async function createArchitectureDecision(
	input: CreateArchitectureDecisionInput,
): Promise<ArchitectureDecisionDetail> {
	// Retry on the rare identifier race (two concurrent creates) — the
	// @@unique([projectId, identifier]) constraint is the integrity backstop.
	for (let attempt = 0; ; attempt++) {
		try {
			return await db.$transaction(async (tx) => {
				const last = await tx.architectureDecision.findFirst({
					where: { projectId: input.projectId },
					orderBy: { createdAt: "desc" },
					select: { identifier: true },
				});
				const identifier = nextIdentifierFrom(last?.identifier);

				const created = await tx.architectureDecision.create({
					data: {
						projectId: input.projectId,
						identifier,
						createdById: input.createdById,
						lastEditedById: input.createdById,
						title: input.title,
						contextProblem: input.contextProblem,
						decision: input.decision,
						rationale: input.rationale,
						decisionDrivers: input.decisionDrivers ?? null,
						alternativesConsidered:
							input.alternativesConsidered ?? null,
						consequences: input.consequences ?? null,
						status: input.status ?? "PROPOSED",
						domain: input.domain ?? null,
						decisionDate: input.decisionDate ?? new Date(),
						participantUserIds: input.participantUserIds ?? [],
						participantsText: input.participantsText ?? null,
						supersededById: input.supersededById ?? null,
						relatedDecisionIds: input.relatedDecisionIds ?? [],
						decisionTypeId: input.decisionTypeId ?? null,
						ownerUserId: input.ownerUserId ?? null,
						duration: input.duration ?? null,
						priorityFlagged: input.priorityFlagged ?? false,
						priorityFlaggedAt: input.priorityFlagged
							? new Date()
							: null,
						sourceKind: input.sourceKind ?? null,
						sourceMetadata: input.sourceMetadata,
						userId: input.userId ?? null,
						organizationId: input.organizationId ?? null,
					},
					select: decisionDetailSelect,
				});

				await tx.architectureDecisionVersion.create({
					data: {
						architectureDecisionId: created.id,
						version: 1,
						title: created.title,
						contextProblem: created.contextProblem,
						decision: created.decision,
						rationale: created.rationale,
						decisionDrivers: created.decisionDrivers,
						alternativesConsidered: created.alternativesConsidered,
						consequences: created.consequences,
						status: created.status,
						decisionDate: created.decisionDate,
						participantUserIds: created.participantUserIds,
						participantsText: created.participantsText,
						decisionTypeId: created.decisionTypeId,
						ownerUserId: created.ownerUserId,
						duration: created.duration,
						priorityFlagged: created.priorityFlagged,
						editedById: input.createdById,
						editedByName: input.editedByName,
						userId: created.userId,
						organizationId: created.organizationId,
					},
				});

				return created;
			});
		} catch (error) {
			if (isUniqueIdentifierViolation(error) && attempt < 3) {
				continue;
			}
			throw error;
		}
	}
}

export async function getArchitectureDecision(input: {
	id: string;
	projectId: string;
}): Promise<ArchitectureDecisionDetail | null> {
	return db.architectureDecision.findFirst({
		where: { id: input.id, projectId: input.projectId, deletedAt: null },
		select: decisionDetailSelect,
	});
}

export interface ListArchitectureDecisionsOptions {
	projectId: string;
	search?: string;
	status?: ArchitectureDecisionStatus;
	/** Filter by category/domain (infra, data, ai, security, frontend, platform). */
	domain?: string;
	/** Filter by a linked project-member participant. */
	participantUserId?: string;
	/** Free-text participant search (external participants). */
	participant?: string;
	dateFrom?: Date;
	dateTo?: Date;
	limit?: number;
	offset?: number;
}

export async function listArchitectureDecisions(
	options: ListArchitectureDecisionsOptions,
) {
	const {
		projectId,
		search,
		status,
		domain,
		participantUserId,
		participant,
		dateFrom,
		dateTo,
		limit = 100,
		offset = 0,
	} = options;

	const and: Prisma.ArchitectureDecisionWhereInput[] = [];
	if (search) {
		and.push({
			OR: [
				{ title: { contains: search, mode: "insensitive" } },
				{ identifier: { contains: search, mode: "insensitive" } },
				{ contextProblem: { contains: search, mode: "insensitive" } },
				{ decision: { contains: search, mode: "insensitive" } },
				{ rationale: { contains: search, mode: "insensitive" } },
			],
		});
	}
	if (participantUserId) {
		and.push({ participantUserIds: { has: participantUserId } });
	}
	if (participant) {
		and.push({
			participantsText: { contains: participant, mode: "insensitive" },
		});
	}

	const where: Prisma.ArchitectureDecisionWhereInput = {
		projectId,
		deletedAt: null,
		...(status ? { status } : {}),
		...(domain ? { domain } : {}),
		...(dateFrom || dateTo
			? {
					decisionDate: {
						...(dateFrom ? { gte: dateFrom } : {}),
						...(dateTo ? { lte: dateTo } : {}),
					},
				}
			: {}),
		...(and.length > 0 ? { AND: and } : {}),
	};

	const [items, total] = await Promise.all([
		db.architectureDecision.findMany({
			where,
			orderBy: { decisionDate: "desc" },
			take: limit,
			skip: offset,
			select: decisionListSelect,
		}),
		db.architectureDecision.count({ where }),
	]);

	return { items, total };
}

/**
 * Return the aggregate counts needed by agent context without loading ADR rows.
 */
export async function countArchitectureDecisionsByStatus(
	projectId: string,
): Promise<{ total: number; proposed: number }> {
	const counts = await db.architectureDecision.groupBy({
		by: ["status"],
		where: { projectId, deletedAt: null },
		_count: { _all: true },
	});

	let total = 0;
	let proposed = 0;
	for (const count of counts) {
		total += count._count._all;
		if (count.status === "PROPOSED") {
			proposed = count._count._all;
		}
	}

	return { total, proposed };
}

const decisionGuidanceSelect = {
	identifier: true,
	title: true,
	decision: true,
	domain: true,
	duration: true,
	priorityFlagged: true,
} as const;

export type AcceptedDecisionForGuidance =
	Prisma.ArchitectureDecisionGetPayload<{
		select: typeof decisionGuidanceSelect;
	}>;

/**
 * The project's confirmed (ACCEPTED) decisions, shaped for the reprioritization
 * prompt's guidance block. A narrow projection (no rationale, alternatives or
 * consequences), capped at a handful of the most recent, so the model gets the
 * team's standing guidance as context without the prompt ballooning.
 * Priority-flagged decisions sort first (they are the ones meant to drive
 * prioritization), then most recent. Tenant isolation is by `projectId`
 * (+ RLS), the same boundary the reprioritization procedure uses for its story load.
 */
export async function getAcceptedDecisionsForGuidance(args: {
	projectId: string;
	limit?: number;
}): Promise<AcceptedDecisionForGuidance[]> {
	return db.architectureDecision.findMany({
		where: {
			projectId: args.projectId,
			status: "ACCEPTED",
			deletedAt: null,
		},
		orderBy: [{ priorityFlagged: "desc" }, { decisionDate: "desc" }],
		take: args.limit ?? 20,
		select: decisionGuidanceSelect,
	});
}

export interface UpdateArchitectureDecisionInput {
	id: string;
	projectId: string;
	editedById: string;
	editedByName: string;
	data: {
		title?: string;
		contextProblem?: string;
		decision?: string;
		rationale?: string;
		decisionDrivers?: string | null;
		alternativesConsidered?: string | null;
		consequences?: string | null;
		status?: ArchitectureDecisionStatus;
		domain?: string | null;
		decisionDate?: Date;
		participantUserIds?: string[];
		participantsText?: string | null;
		supersededById?: string | null;
		relatedDecisionIds?: string[];
		decisionTypeId?: string | null;
		ownerUserId?: string | null;
		duration?: "LONG_STANDING" | "SHORT_TERM" | null;
		priorityFlagged?: boolean;
	};
}

/**
 * Update a decision and append a version snapshot. Returns null if the decision
 * does not exist (or is soft-deleted) within the project.
 */
export async function updateArchitectureDecision(
	input: UpdateArchitectureDecisionInput,
): Promise<ArchitectureDecisionDetail | null> {
	return db.$transaction(async (tx) => {
		const existing = await tx.architectureDecision.findFirst({
			where: {
				id: input.id,
				projectId: input.projectId,
				deletedAt: null,
			},
			select: { id: true },
		});
		if (!existing) {
			return null;
		}

		const d = input.data;
		const lastVersion = await tx.architectureDecisionVersion.findFirst({
			where: { architectureDecisionId: input.id },
			orderBy: { version: "desc" },
			select: { version: true },
		});
		const nextVersion = (lastVersion?.version ?? 0) + 1;

		const updated = await tx.architectureDecision.update({
			where: { id: input.id },
			data: {
				...(d.title !== undefined ? { title: d.title } : {}),
				...(d.contextProblem !== undefined
					? { contextProblem: d.contextProblem }
					: {}),
				...(d.decision !== undefined ? { decision: d.decision } : {}),
				...(d.rationale !== undefined
					? { rationale: d.rationale }
					: {}),
				...(d.decisionDrivers !== undefined
					? { decisionDrivers: d.decisionDrivers }
					: {}),
				...(d.alternativesConsidered !== undefined
					? { alternativesConsidered: d.alternativesConsidered }
					: {}),
				...(d.consequences !== undefined
					? { consequences: d.consequences }
					: {}),
				...(d.status !== undefined ? { status: d.status } : {}),
				...(d.domain !== undefined ? { domain: d.domain } : {}),
				...(d.decisionDate !== undefined
					? { decisionDate: d.decisionDate }
					: {}),
				...(d.participantUserIds !== undefined
					? { participantUserIds: d.participantUserIds }
					: {}),
				...(d.participantsText !== undefined
					? { participantsText: d.participantsText }
					: {}),
				...(d.supersededById !== undefined
					? { supersededById: d.supersededById }
					: {}),
				...(d.relatedDecisionIds !== undefined
					? { relatedDecisionIds: d.relatedDecisionIds }
					: {}),
				...(d.decisionTypeId !== undefined
					? { decisionTypeId: d.decisionTypeId }
					: {}),
				...(d.ownerUserId !== undefined
					? { ownerUserId: d.ownerUserId }
					: {}),
				...(d.duration !== undefined ? { duration: d.duration } : {}),
				...(d.priorityFlagged !== undefined
					? {
							priorityFlagged: d.priorityFlagged,
							priorityFlaggedAt: d.priorityFlagged
								? new Date()
								: null,
						}
					: {}),
				lastEditedById: input.editedById,
				currentVersion: nextVersion,
			},
			select: decisionDetailSelect,
		});

		await tx.architectureDecisionVersion.create({
			data: {
				architectureDecisionId: updated.id,
				version: nextVersion,
				title: updated.title,
				contextProblem: updated.contextProblem,
				decision: updated.decision,
				rationale: updated.rationale,
				decisionDrivers: updated.decisionDrivers,
				alternativesConsidered: updated.alternativesConsidered,
				consequences: updated.consequences,
				status: updated.status,
				decisionDate: updated.decisionDate,
				participantUserIds: updated.participantUserIds,
				participantsText: updated.participantsText,
				decisionTypeId: updated.decisionTypeId,
				ownerUserId: updated.ownerUserId,
				duration: updated.duration,
				priorityFlagged: updated.priorityFlagged,
				editedById: input.editedById,
				editedByName: input.editedByName,
				userId: updated.userId,
				organizationId: updated.organizationId,
			},
		});

		return updated;
	});
}

/**
 * Revert a decision to a prior version's content by writing it as a brand-new
 * version (history is append-only — reverting never rewrites past versions).
 * Returns null if the decision or target version doesn't exist.
 */
export async function revertArchitectureDecisionToVersion(input: {
	id: string;
	projectId: string;
	version: number;
	editedById: string;
	editedByName: string;
}): Promise<ArchitectureDecisionDetail | null> {
	return db.$transaction(async (tx) => {
		const existing = await tx.architectureDecision.findFirst({
			where: {
				id: input.id,
				projectId: input.projectId,
				deletedAt: null,
			},
			select: { id: true },
		});
		if (!existing) {
			return null;
		}

		const target = await tx.architectureDecisionVersion.findFirst({
			where: { architectureDecisionId: input.id, version: input.version },
		});
		if (!target) {
			return null;
		}

		const lastVersion = await tx.architectureDecisionVersion.findFirst({
			where: { architectureDecisionId: input.id },
			orderBy: { version: "desc" },
			select: { version: true },
		});
		const nextVersion = (lastVersion?.version ?? 0) + 1;

		const updated = await tx.architectureDecision.update({
			where: { id: input.id },
			data: {
				title: target.title,
				contextProblem: target.contextProblem,
				decision: target.decision,
				rationale: target.rationale,
				decisionDrivers: target.decisionDrivers,
				alternativesConsidered: target.alternativesConsidered,
				consequences: target.consequences,
				status: target.status,
				decisionDate: target.decisionDate,
				participantUserIds: target.participantUserIds,
				participantsText: target.participantsText,
				decisionTypeId: target.decisionTypeId,
				ownerUserId: target.ownerUserId,
				duration: target.duration,
				priorityFlagged: target.priorityFlagged,
				priorityFlaggedAt: target.priorityFlagged
					? // Reverting restores the flag but stamps the revert time.
						new Date()
					: null,
				lastEditedById: input.editedById,
				currentVersion: nextVersion,
			},
			select: decisionDetailSelect,
		});

		await tx.architectureDecisionVersion.create({
			data: {
				architectureDecisionId: updated.id,
				version: nextVersion,
				title: updated.title,
				contextProblem: updated.contextProblem,
				decision: updated.decision,
				rationale: updated.rationale,
				decisionDrivers: updated.decisionDrivers,
				alternativesConsidered: updated.alternativesConsidered,
				consequences: updated.consequences,
				status: updated.status,
				decisionDate: updated.decisionDate,
				participantUserIds: updated.participantUserIds,
				participantsText: updated.participantsText,
				decisionTypeId: updated.decisionTypeId,
				ownerUserId: updated.ownerUserId,
				duration: updated.duration,
				priorityFlagged: updated.priorityFlagged,
				editedById: input.editedById,
				editedByName: input.editedByName,
				userId: updated.userId,
				organizationId: updated.organizationId,
			},
		});

		return updated;
	});
}

/**
 * Soft-delete a decision. Returns `{ id, contextId }` so the caller can clean
 * up the mirrored RAG ProjectContext + its embedding, or null if not found.
 */
export async function softDeleteArchitectureDecision(input: {
	id: string;
	projectId: string;
}): Promise<{ id: string; contextId: string | null } | null> {
	const existing = await db.architectureDecision.findFirst({
		where: { id: input.id, projectId: input.projectId, deletedAt: null },
		select: { id: true, contextId: true },
	});
	if (!existing) {
		return null;
	}

	await db.architectureDecision.update({
		where: { id: input.id },
		data: { deletedAt: new Date() },
	});
	return existing;
}

/** Persist the mirrored ProjectContext id back onto the decision (AC5 link). */
export async function setArchitectureDecisionContextId(input: {
	id: string;
	contextId: string | null;
}) {
	return db.architectureDecision.update({
		where: { id: input.id },
		data: { contextId: input.contextId },
		select: { id: true, contextId: true },
	});
}

/** Pin or unpin a decision (team-wide). Returns the updated detail, or null if not found. */
export async function setArchitectureDecisionPinned(input: {
	id: string;
	projectId: string;
	pinned: boolean;
}): Promise<ArchitectureDecisionDetail | null> {
	const existing = await db.architectureDecision.findFirst({
		where: { id: input.id, projectId: input.projectId, deletedAt: null },
		select: { id: true },
	});
	if (!existing) {
		return null;
	}
	return db.architectureDecision.update({
		where: { id: input.id },
		data: { pinnedAt: input.pinned ? new Date() : null },
		select: decisionDetailSelect,
	});
}

/** Record or clear a human endorsement ("vouch"). Returns the updated detail, or null if not found. */
export async function setArchitectureDecisionVouched(input: {
	id: string;
	projectId: string;
	vouched: boolean;
	vouchedById: string;
}): Promise<ArchitectureDecisionDetail | null> {
	const existing = await db.architectureDecision.findFirst({
		where: { id: input.id, projectId: input.projectId, deletedAt: null },
		select: { id: true },
	});
	if (!existing) {
		return null;
	}
	return db.architectureDecision.update({
		where: { id: input.id },
		data: input.vouched
			? { vouchedAt: new Date(), vouchedById: input.vouchedById }
			: { vouchedAt: null, vouchedById: null },
		select: decisionDetailSelect,
	});
}

/**
 * Mark the given decisions as superseded by `supersederId` (sets status =
 * SUPERSEDED + the back-link). Skips the superseder itself. Returns the ids
 * actually changed so the caller can re-embed their AI context.
 */
export async function markArchitectureDecisionsSuperseded(input: {
	projectId: string;
	targetIds: string[];
	supersederId: string;
}): Promise<string[]> {
	const targets = input.targetIds.filter((id) => id !== input.supersederId);
	if (targets.length === 0) {
		return [];
	}
	const rows = await db.architectureDecision.findMany({
		where: {
			id: { in: targets },
			projectId: input.projectId,
			deletedAt: null,
		},
		select: { id: true },
	});
	const ids = rows.map((r) => r.id);
	if (ids.length === 0) {
		return [];
	}
	await db.architectureDecision.updateMany({
		where: { id: { in: ids } },
		data: { status: "SUPERSEDED", supersededById: input.supersederId },
	});
	return ids;
}

/** Resolve decision row-ids → human identifiers (for relationship text/links). */
export async function resolveArchitectureDecisionIdentifiers(input: {
	projectId: string;
	ids: string[];
}): Promise<Map<string, string>> {
	if (input.ids.length === 0) {
		return new Map();
	}
	const rows = await db.architectureDecision.findMany({
		where: { id: { in: input.ids }, projectId: input.projectId },
		select: { id: true, identifier: true },
	});
	return new Map(rows.map((r) => [r.id, r.identifier]));
}

/** Identifiers of decisions this one supersedes (reverse lookup of supersededById). */
export async function listSupersededIdentifiers(input: {
	projectId: string;
	supersederId: string;
}): Promise<{ id: string; identifier: string }[]> {
	return db.architectureDecision.findMany({
		where: {
			projectId: input.projectId,
			supersededById: input.supersederId,
			deletedAt: null,
		},
		select: { id: true, identifier: true },
	});
}

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

export async function listArchitectureDecisionVersions(input: {
	architectureDecisionId: string;
}) {
	return db.architectureDecisionVersion.findMany({
		where: { architectureDecisionId: input.architectureDecisionId },
		orderBy: { version: "desc" },
	});
}

// ---------------------------------------------------------------------------
// Threaded comments (mirrors comments.ts for stories)
// ---------------------------------------------------------------------------

export async function listArchitectureDecisionComments(input: {
	architectureDecisionId: string;
	organizationId?: string | null;
}) {
	return db.architectureDecisionComment.findMany({
		where: {
			architectureDecisionId: input.architectureDecisionId,
			organizationId: input.organizationId ?? null,
			deletedAt: null,
		},
		orderBy: { createdAt: "asc" },
		select: adlCommentSelect,
	});
}

export async function createArchitectureDecisionComment(input: {
	architectureDecisionId: string;
	authorId: string;
	content: string;
	parentId?: string | null;
	decisionVersion?: number | null;
	organizationId?: string | null;
}) {
	return db.architectureDecisionComment.create({
		data: {
			architectureDecisionId: input.architectureDecisionId,
			authorId: input.authorId,
			content: input.content,
			authorType: "USER",
			parentId: input.parentId ?? undefined,
			decisionVersion: input.decisionVersion ?? undefined,
			organizationId: input.organizationId ?? null,
		},
		select: adlCommentSelect,
	});
}

// ---------------------------------------------------------------------------
// Meeting-decision bridge (extractedDecisions → draft ADL entries)
// ---------------------------------------------------------------------------

export interface MeetingDecisionCandidate {
	transcriptId: string;
	meetingId: string;
	meetingSubject: string | null;
	meetingDate: Date | null;
	decisionIndex: number;
	text: string;
	relatedStoryIdentifier?: string;
	/** Already turned into an ADL via the create-from-meeting flow. */
	alreadyConverted: boolean;
	/** A user declined this candidate. */
	dismissed: boolean;
	/** Closely matches a decision that already exists (e.g. logged manually). */
	alreadyExists: boolean;
	/** When it matches an existing decision, the one it most likely updates. */
	matchedDecision?: { id: string; identifier: string; title: string };
}

type RawMeetingDecision = {
	text?: unknown;
	relatedStoryIdentifier?: unknown;
};

/**
 * List extracted meeting decisions for a project as candidate draft ADL
 * entries, flagging ones already converted (tracked via ADL.sourceMetadata).
 */
export async function listMeetingDecisionCandidates(input: {
	projectId: string;
	organizationId?: string | null;
}): Promise<MeetingDecisionCandidate[]> {
	const [transcripts, existing] = await Promise.all([
		db.projectMeetingTranscript.findMany({
			where: {
				projectId: input.projectId,
				organizationId: input.organizationId ?? null,
			},
			select: {
				id: true,
				meetingId: true,
				meetingSubject: true,
				meetingDate: true,
				extractedDecisions: true,
				dismissedDecisionIndexes: true,
			},
			orderBy: { meetingDate: "desc" },
		}),
		// Every live decision — used both for the meeting-pointer conversion check
		// and for content-level de-dup against decisions logged manually.
		db.architectureDecision.findMany({
			where: { projectId: input.projectId, deletedAt: null },
			select: {
				id: true,
				identifier: true,
				title: true,
				decision: true,
				sourceKind: true,
				sourceMetadata: true,
			},
		}),
	]);

	const convertedKeys = new Set<string>();
	for (const c of existing) {
		if (c.sourceKind !== "meeting_decision") {
			continue;
		}
		const meta = c.sourceMetadata as {
			transcriptId?: string;
			decisionIndex?: number;
		} | null;
		if (meta?.transcriptId != null && meta?.decisionIndex != null) {
			convertedKeys.add(`${meta.transcriptId}:${meta.decisionIndex}`);
		}
	}

	const candidates: MeetingDecisionCandidate[] = [];
	for (const t of transcripts) {
		const decisions: RawMeetingDecision[] = Array.isArray(
			t.extractedDecisions,
		)
			? (t.extractedDecisions as RawMeetingDecision[])
			: [];
		const dismissed = new Set(t.dismissedDecisionIndexes ?? []);
		decisions.forEach((raw, idx) => {
			if (
				!raw ||
				typeof raw.text !== "string" ||
				raw.text.trim() === ""
			) {
				return;
			}
			const text = raw.text;
			const match = existing.find(
				(e) =>
					isSimilarDecision(text, e.title) ||
					isSimilarDecision(text, e.decision),
			);
			candidates.push({
				transcriptId: t.id,
				meetingId: t.meetingId,
				meetingSubject: t.meetingSubject,
				meetingDate: t.meetingDate,
				decisionIndex: idx,
				text,
				relatedStoryIdentifier:
					typeof raw.relatedStoryIdentifier === "string"
						? raw.relatedStoryIdentifier
						: undefined,
				alreadyConverted: convertedKeys.has(`${t.id}:${idx}`),
				dismissed: dismissed.has(idx),
				alreadyExists: Boolean(match),
				matchedDecision: match
					? {
							id: match.id,
							identifier: match.identifier,
							title: match.title,
						}
					: undefined,
			});
		});
	}
	return candidates;
}

function normalizeDecisionText(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Heuristic "same decision" check used to de-dup meeting candidates against
 * decisions that already exist (e.g. logged manually). Matches on substring
 * containment or strong word-overlap (Jaccard ≥ 0.5) of the normalized text.
 */
function isSimilarDecision(a: string, b: string): boolean {
	if (!a || !b) {
		return false;
	}
	const na = normalizeDecisionText(a);
	const nb = normalizeDecisionText(b);
	if (na.length < 4 || nb.length < 4) {
		return false;
	}
	if (na.includes(nb) || nb.includes(na)) {
		return true;
	}
	const ta = new Set(na.split(" ").filter((w) => w.length > 2));
	const tb = new Set(nb.split(" ").filter((w) => w.length > 2));
	if (ta.size === 0 || tb.size === 0) {
		return false;
	}
	let inter = 0;
	for (const w of ta) {
		if (tb.has(w)) {
			inter++;
		}
	}
	const union = ta.size + tb.size - inter;
	return union > 0 && inter / union >= 0.5;
}

/** Mark a meeting decision (transcript + index) as dismissed so it isn't re-suggested. */
export async function dismissMeetingDecision(input: {
	projectId: string;
	transcriptId: string;
	decisionIndex: number;
	organizationId?: string | null;
}): Promise<boolean> {
	const t = await db.projectMeetingTranscript.findFirst({
		where: {
			id: input.transcriptId,
			projectId: input.projectId,
			organizationId: input.organizationId ?? null,
		},
		select: { id: true, dismissedDecisionIndexes: true },
	});
	if (!t) {
		return false;
	}
	if (t.dismissedDecisionIndexes.includes(input.decisionIndex)) {
		return true;
	}
	await db.projectMeetingTranscript.update({
		where: { id: t.id },
		data: {
			dismissedDecisionIndexes: [
				...t.dismissedDecisionIndexes,
				input.decisionIndex,
			],
		},
	});
	return true;
}

/** Fetch one transcript (scoped to the project/tenant) for the createFrom flow. */
export async function getMeetingTranscriptForDecision(input: {
	projectId: string;
	transcriptId: string;
	organizationId?: string | null;
}) {
	return db.projectMeetingTranscript.findFirst({
		where: {
			id: input.transcriptId,
			projectId: input.projectId,
			organizationId: input.organizationId ?? null,
		},
		select: {
			id: true,
			meetingId: true,
			meetingSubject: true,
			meetingDate: true,
			extractedDecisions: true,
		},
	});
}
