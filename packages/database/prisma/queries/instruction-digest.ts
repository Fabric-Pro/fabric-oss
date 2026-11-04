/**
 * The Coding Instructions tab's "what changed since your last visit" digest:
 * the per-person seen marker on `ProjectUserPreference` and the reads the
 * digest is built from. Every read is tenant-scoped by project and
 * organization; the API applies the viewer's proposal visibility.
 */
import { db } from "../client";

const DIGEST_LIST_LIMIT = 20;

/**
 * A snapshot whose content is readable as a version: the same rule as
 * `isInstructionSnapshotContentReadable` in the API.
 */
const readableVersionFilter = {
	contentKind: "FULL_SNAPSHOT" as const,
	status: "READY" as const,
	proposalDestination: { not: "REPOSITORY_COMMIT" as const },
	OR: [{ proposalStatus: null }, { proposalStatus: "APPROVED" as const }],
};

export type InstructionSeenMarker = {
	snapshotId: string | null;
	version: number | null;
	seenAt: Date;
};

/** The person's marker, or null on a first visit. */
export async function getInstructionSeenMarker(
	projectId: string,
	userId: string,
): Promise<InstructionSeenMarker | null> {
	const row = await db.projectUserPreference.findUnique({
		where: { projectId_userId: { projectId, userId } },
		select: {
			instructionsSeenSnapshotId: true,
			instructionsSeenVersion: true,
			instructionsSeenAt: true,
		},
	});
	if (!row?.instructionsSeenAt) {
		return null;
	}
	return {
		snapshotId: row.instructionsSeenSnapshotId,
		version: row.instructionsSeenVersion,
		seenAt: row.instructionsSeenAt,
	};
}

/**
 * Records that the person has seen the project's instructions as of
 * `snapshotId` (null when nothing is published yet). Overwrites the marker.
 */
export async function recordInstructionSeen(input: {
	projectId: string;
	userId: string;
	organizationId: string;
	snapshotId: string | null;
	version: number | null;
}): Promise<void> {
	const seen = {
		instructionsSeenSnapshotId: input.snapshotId,
		instructionsSeenVersion: input.version,
		instructionsSeenAt: new Date(),
	};
	await db.projectUserPreference.upsert({
		where: {
			projectId_userId: {
				projectId: input.projectId,
				userId: input.userId,
			},
		},
		create: {
			projectId: input.projectId,
			userId: input.userId,
			// Mirrors the parent project's tenancy, as every other row on
			// this table does.
			organizationId: input.organizationId,
			...seen,
		},
		update: seen,
	});
}

/**
 * A readable version by number: what the digest falls back to when the
 * marker's snapshot was pruned or deleted. Null when that version is gone too.
 */
export function findReadableInstructionVersion(input: {
	projectId: string;
	organizationId: string;
	version: number;
}) {
	return db.projectInstructionSnapshot.findFirst({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId,
			version: input.version,
			...readableVersionFilter,
		},
		select: { id: true, version: true },
	});
}

/**
 * Versions that have held the published pointer and are newer than the
 * marker, oldest first. A version published, rolled back and published again
 * appears once.
 */
export function listInstructionVersionsPublishedSince(input: {
	projectId: string;
	organizationId: string;
	afterVersion: number;
}) {
	return db.projectInstructionSnapshot.findMany({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId,
			version: { gt: input.afterVersion },
			publishedAt: { not: null },
			...readableVersionFilter,
		},
		orderBy: { version: "asc" },
		take: DIGEST_LIST_LIMIT,
		select: {
			id: true,
			version: true,
			source: true,
			sourceRef: true,
			sourceCommitSha: true,
			publishedAt: true,
			user: { select: { id: true, name: true } },
		},
	});
}

/**
 * Upload-mode proposals approved or rejected after `since`, newest first.
 * `proposerUserId` narrows to the viewer's own, plus the approved ones every
 * reader may see, for a viewer who cannot review (the visibility the History
 * list applies).
 */
export function listInstructionProposalsResolvedSince(input: {
	projectId: string;
	organizationId: string;
	since: Date;
	proposerUserId?: string;
}) {
	return db.projectInstructionSnapshot.findMany({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId,
			proposalStatus: { in: ["APPROVED", "REJECTED"] },
			reviewedAt: { gt: input.since },
			...(input.proposerUserId !== undefined
				? {
						OR: [
							{ proposalStatus: "APPROVED" as const },
							{ userId: input.proposerUserId },
						],
					}
				: {}),
		},
		orderBy: { reviewedAt: "desc" },
		take: DIGEST_LIST_LIMIT,
		select: {
			id: true,
			version: true,
			proposalStatus: true,
			reviewedAt: true,
			proposalNote: true,
			user: { select: { id: true, name: true } },
			reviewer: { select: { id: true, name: true } },
		},
	});
}
