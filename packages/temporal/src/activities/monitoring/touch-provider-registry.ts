/**
 * Change-guarded, throttled writer for `IntegrationProviderRegistry`.
 *
 * NOT an activity, and deliberately NOT re-exported from
 * `activities/monitoring/index.ts` — everything the top-level activities
 * barrel exports becomes a schedulable Temporal activity, and this is an
 * internal helper the monitoring activities call in-process.
 *
 * ## Why this exists
 *
 * The registry row is durable state read by the admin monitoring grid,
 * the provider drawer, and `getLastBackgroundWorkAt()` (the
 * "background processing" platform component). Every monitoring
 * activity used to rewrite its provider's row on every single call,
 * unconditionally, just to move `lastPolledAt` forward — the
 * status-page poller ticks every 2 minutes across 29 providers, so an
 * idle environment with no users still churned the table continuously.
 *
 * So: write only when something actually changed, or when the stored
 * heartbeat has gone stale.
 *
 * ## Why 3 minutes
 *
 * The two real cadences bound the worst-case staleness:
 *
 *   - A healthy provider gets a stamp opportunity every ~4 minutes —
 *     the poller ticks every 2 minutes but `closeIntegrationIncident`
 *     only runs once the 2-poll operational hysteresis clears.
 *   - A provider with a live incident gets one every 2 minutes, via
 *     `upsertIntegrationIncident`'s continuation branch.
 *
 * With a 3-minute floor, the first opportunity at or past 3 minutes
 * writes: ~4 minutes for the healthy case, ~4 minutes for the incident
 * case (stamps at 0, skips at 2, writes at 4). Both sit comfortably
 * under the 10-minute "background processing degraded" threshold in
 * `@repo/observability`'s platform-component registry, which is still
 * at least two missed heartbeats away. Anything that changes the poll
 * cadence, the hysteresis, or that threshold should be re-checked
 * against this number.
 */
import { db } from "@repo/database";
import type { ProviderHealthStatus } from "./shared-types";

/**
 * Minimum age of the stored `lastPolledAt` before an otherwise
 * no-op poll is allowed to rewrite the row purely to move the
 * heartbeat forward.
 */
export const PROVIDER_HEARTBEAT_MIN_INTERVAL_MS = 3 * 60_000;

export interface TouchProviderRegistryInput {
	providerKey: string;
	/** Omit to leave currentHealth untouched. */
	currentHealth?: ProviderHealthStatus;
	/** Omit to leave lastIncidentId untouched; pass null to clear. */
	lastIncidentId?: string | null;
	now?: Date;
}

export interface TouchProviderRegistryResult {
	/** A row was written. */
	updated: boolean;
	/** currentHealth actually changed value. */
	healthChanged: boolean;
}

/**
 * Reconcile one provider's registry row.
 *
 * Wholly best-effort — it never throws, and never reports work it did
 * not do. That is load-bearing at the call sites, not a nicety: none of
 * them could fail on a registry problem before this helper existed, and
 * `upsertIntegrationIncident` in particular calls it *after* committing
 * the incident row and its FIRED event. A throw there would fail the
 * activity, and the retry would find the incident already present,
 * return `wasNew: false`, and leave the lifecycle workflow unstarted.
 *
 * So: a read failure and a missing row (boot ordering — the API server
 * writes every row on start) both degrade to a no-op, and a failed
 * write reports `updated: false` so a caller cannot announce a
 * transition that was never persisted. The next tick re-reads the old
 * value and retries.
 */
export async function touchProviderRegistry(
	input: TouchProviderRegistryInput,
): Promise<TouchProviderRegistryResult> {
	const existing = await db.integrationProviderRegistry
		.findUnique({
			where: { providerKey: input.providerKey },
			select: {
				currentHealth: true,
				lastIncidentId: true,
				lastPolledAt: true,
			},
		})
		.catch(() => null);

	if (!existing) {
		return { updated: false, healthChanged: false };
	}

	const now = input.now ?? new Date();
	const data: {
		currentHealth?: ProviderHealthStatus;
		lastIncidentId?: string | null;
		lastPolledAt?: Date;
	} = {};

	const healthChanged =
		input.currentHealth !== undefined &&
		existing.currentHealth !== input.currentHealth;
	if (healthChanged) {
		data.currentHealth = input.currentHealth;
	}

	if (
		input.lastIncidentId !== undefined &&
		existing.lastIncidentId !== input.lastIncidentId
	) {
		data.lastIncidentId = input.lastIncidentId;
	}

	// A row we are already rewriting gets a fresh heartbeat for free, so
	// the staleness check only decides whether an otherwise-empty write
	// is worth issuing.
	const stale =
		!existing.lastPolledAt ||
		now.getTime() - existing.lastPolledAt.getTime() >=
			PROVIDER_HEARTBEAT_MIN_INTERVAL_MS;

	const changed = Object.keys(data).length > 0;
	if (changed || stale) {
		data.lastPolledAt = now;
	}

	if (Object.keys(data).length === 0) {
		return { updated: false, healthChanged: false };
	}

	const written = await db.integrationProviderRegistry
		.update({
			where: { providerKey: input.providerKey },
			data,
		})
		.then(() => true)
		// The row may have been removed since the read — best-effort.
		.catch(() => false);

	return written
		? { updated: true, healthChanged }
		: { updated: false, healthChanged: false };
}
