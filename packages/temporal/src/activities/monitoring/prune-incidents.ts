/**
 * pruneIncidents activity.
 *
 * Deletes ErrorRateIncident + IntegrationIncident rows whose lifecycle
 * timestamp is older than `olderThanDays`. IncidentEvent rows cascade
 * via the existing `onDelete: Cascade` relation on both incident models
 * (see Prisma schema).
 *
 * Spec L13 → 365-day retention.
 *
 * The deletion is split into two `deleteMany` calls (one per incident
 * model) instead of a transaction because the two tables are
 * independent — a partial failure on one does NOT need to roll back
 * the other.
 */
import { db } from "@repo/database";

export interface PruneIncidentsInput {
	/** Threshold age, e.g., 365. Required. */
	olderThanDays: number;
}

export interface PruneIncidentsOutput {
	errorRateDeleted: number;
	integrationDeleted: number;
	cutoff: string; // ISO timestamp used as the cutoff
}

export async function pruneIncidents(
	input: PruneIncidentsInput,
): Promise<PruneIncidentsOutput> {
	if (!Number.isFinite(input.olderThanDays) || input.olderThanDays <= 0) {
		throw new Error(
			`pruneIncidents: olderThanDays must be a positive number, got ${input.olderThanDays}`,
		);
	}

	const cutoff = new Date(
		Date.now() - input.olderThanDays * 24 * 60 * 60 * 1000,
	);

	const errorRateResult = await db.errorRateIncident.deleteMany({
		where: { firedAt: { lt: cutoff } },
	});

	const integrationResult = await db.integrationIncident.deleteMany({
		where: { startedAt: { lt: cutoff } },
	});

	return {
		errorRateDeleted: errorRateResult.count,
		integrationDeleted: integrationResult.count,
		cutoff: cutoff.toISOString(),
	};
}
