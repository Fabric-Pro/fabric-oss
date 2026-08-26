import { db } from "../client";
import type { PmStateChangeEntityType } from "../generated/client";

/**
 * Increment (or create) the missing-poll streak for a specific ticket on a
 * specific entity, capped at `cap` so a long-deleted ticket never grows the
 * counter unbounded. Keyed by (projectId, entityType, entityId, externalId) so
 * a re-link can never inherit a different ticket's streak. Returns the new
 * missStreak value. Safe to call from the poll activity (non-deterministic Date
 * is fine in activities).
 *
 * Idempotent per poll cycle (#1360 review Fix C): `pollRunId` is the cycle's
 * unique token (the child poll workflow's runId). If this streak was already
 * advanced by the SAME cycle (`lastCountedRunId === pollRunId`) — e.g. a
 * Temporal activity retry after a mid-loop failure, or a concurrent re-run —
 * the existing value is returned unchanged and NO write occurs. So the
 * threshold counts DISTINCT poll cycles, not activity attempts, and the
 * "3 consecutive cycles" contract holds under at-least-once execution.
 */
export async function incrementMissingStreak(params: {
	projectId: string;
	entityType: PmStateChangeEntityType;
	entityId: string;
	externalId: string;
	cap: number;
	pollRunId: string;
}): Promise<number> {
	const { projectId, entityType, entityId, externalId, cap, pollRunId } =
		params;
	const now = new Date();

	const existing = await db.pmTicketMissingStreak.findUnique({
		where: {
			projectId_entityType_entityId_externalId: {
				projectId,
				entityType,
				entityId,
				externalId,
			},
		},
		select: { missStreak: true, lastCountedRunId: true },
	});

	// Already counted this poll cycle → idempotent no-op (retry/concurrent run).
	if (existing?.lastCountedRunId === pollRunId) {
		return existing.missStreak;
	}

	const next = Math.min((existing?.missStreak ?? 0) + 1, cap);

	const row = await db.pmTicketMissingStreak.upsert({
		where: {
			projectId_entityType_entityId_externalId: {
				projectId,
				entityType,
				entityId,
				externalId,
			},
		},
		create: {
			projectId,
			entityType,
			entityId,
			externalId,
			missStreak: next,
			firstMissingAt: now,
			lastMissingAt: now,
			lastCountedRunId: pollRunId,
		},
		update: {
			missStreak: next,
			lastMissingAt: now,
			lastCountedRunId: pollRunId,
		},
		select: { missStreak: true },
	});

	return row.missStreak;
}

/**
 * Reset (delete) streaks for every ticket that was successfully fetched this
 * cycle ("seen → forget"). Keyed by externalId to match the streak identity.
 */
export async function resetMissingStreaks(
	projectId: string,
	seenExternalIds: string[],
): Promise<void> {
	if (seenExternalIds.length === 0) {
		return;
	}
	await db.pmTicketMissingStreak.deleteMany({
		where: { projectId, externalId: { in: seenExternalIds } },
	});
}
