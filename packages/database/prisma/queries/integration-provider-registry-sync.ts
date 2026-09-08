/**
 * Integration Provider Registry — DB sync
 *
 * Mirrors the in-memory TS registry (owned by `@repo/observability`)
 * into the `IntegrationProviderRegistry` Prisma table. Called once at
 * Hono server boot.
 *
 * Design notes:
 *
 * - **Idempotent**. Re-running on boot must not duplicate rows and
 *   must NOT clobber the runtime columns (`currentHealth`,
 *   `lastPolledAt`, `lastIncidentId`) — those are owned by the
 *   Temporal pollers.
 * - **Compare before writing**. A Prisma `upsert` issues an UPDATE
 *   whenever the row exists, even when every synced column already
 *   holds the value we would write — which bumps `updatedAt` and
 *   produces a row version for nothing. The web app runs serverless,
 *   so every cold start replayed the whole registry: staging saw four
 *   boots in six minutes, each rewriting all 33 rows. We now read the
 *   synced columns once and write only the rows that actually differ,
 *   which makes a steady-state boot cost one SELECT and no writes.
 * - **Best-effort**. A DB outage at boot is logged and swallowed so
 *   the API server can still start and serve health checks. The
 *   registry rows will be reconciled on next boot.
 * - **Package layering**. This file lives in `@repo/database` rather
 *   than `@repo/observability` to break the package-level cycle:
 *     `@repo/observability → @repo/database → @repo/storage → @repo/observability`
 *   Callers pass the registry data in as an argument so this module
 *   does not statically depend on `@repo/observability`. The caller
 *   (`@repo/api`) imports both packages and bridges them at the
 *   boot site.
 */
import { db } from "../client";

/**
 * Synthetic probe shape that the sync function needs from a
 * registration. Kept structurally compatible with
 * `@repo/observability`'s `SyntheticProbeConfig` so callers can pass
 * the live registration objects directly without re-mapping.
 */
export interface IntegrationProviderRegistrationSyntheticProbe {
	interval: string;
}

/**
 * Subset of `@repo/observability`'s `IntegrationProviderRegistration`
 * needed by the sync. Kept structurally compatible — the caller can
 * pass live registrations directly (TS will accept the wider type).
 */
export interface IntegrationProviderRegistrationInput {
	key: string;
	displayName: string;
	statusPageUrl?: string;
	statusPageApiUrl?: string;
	statusPagePolling?: boolean;
	syntheticProbe?: IntegrationProviderRegistrationSyntheticProbe;
	breakerKey?: string;
	affectedFeatures: string[];
	dataConnectionProvider?: string;
}

/**
 * Per-boot outcome breakdown. `created + updated + skipped + failed`
 * always equals the number of registrations passed in.
 *
 * A healthy steady-state boot reports everything under `skipped` — that
 * is the whole point of the compare-before-write pass.
 */
export interface SyncIntegrationProviderRegistrySummary {
	/** Rows inserted because no row carried the provider key. */
	created: number;
	/** Rows rewritten because at least one synced column differed. */
	updated: number;
	/** Rows left untouched because every synced column already matched. */
	skipped: number;
	/** Rows whose write threw. Logged and swallowed — boot continues. */
	failed: number;
}

/**
 * The config columns this sync owns. Runtime state (`currentHealth`,
 * `lastPolledAt`, `lastIncidentId`) is deliberately absent: those are
 * owned by the Temporal pollers and must survive a reboot untouched.
 */
interface SyncedRegistryColumns {
	displayName: string;
	statusPageUrl: string | null;
	statusPageApiUrl: string | null;
	statusPagePolling: boolean;
	syntheticProbeEnabled: boolean;
	syntheticProbeInterval: string | null;
	breakerKey: string | null;
	affectedFeatures: string[];
	dataConnectionProvider: string | null;
}

/**
 * Normalise a registration into the exact column values we would
 * persist. Both the write payload and the equality check read from
 * this, so a "no change" verdict can never disagree with what an
 * update would have written.
 */
function toSyncedColumns(
	reg: IntegrationProviderRegistrationInput,
): SyncedRegistryColumns {
	return {
		displayName: reg.displayName,
		statusPageUrl: reg.statusPageUrl ?? null,
		statusPageApiUrl: reg.statusPageApiUrl ?? null,
		// Default to `true` to match the Prisma column default; only
		// set `false` when the registration explicitly disables it.
		statusPagePolling: reg.statusPagePolling !== false,
		syntheticProbeEnabled: reg.syntheticProbe !== undefined,
		syntheticProbeInterval: reg.syntheticProbe?.interval ?? null,
		breakerKey: reg.breakerKey ?? null,
		affectedFeatures: [...reg.affectedFeatures],
		dataConnectionProvider: reg.dataConnectionProvider ?? null,
	};
}

/**
 * True when the stored row already holds every value the sync would
 * write. `affectedFeatures` is a Postgres array — compared element-wise
 * in order, because order is meaningful to the admin UI that renders it.
 */
function matchesStoredRow(
	stored: SyncedRegistryColumns,
	next: SyncedRegistryColumns,
): boolean {
	if (stored.affectedFeatures.length !== next.affectedFeatures.length) {
		return false;
	}
	for (let i = 0; i < next.affectedFeatures.length; i++) {
		if (stored.affectedFeatures[i] !== next.affectedFeatures[i]) {
			return false;
		}
	}

	return (
		stored.displayName === next.displayName &&
		stored.statusPageUrl === next.statusPageUrl &&
		stored.statusPageApiUrl === next.statusPageApiUrl &&
		stored.statusPagePolling === next.statusPagePolling &&
		stored.syntheticProbeEnabled === next.syntheticProbeEnabled &&
		stored.syntheticProbeInterval === next.syntheticProbeInterval &&
		stored.breakerKey === next.breakerKey &&
		stored.dataConnectionProvider === next.dataConnectionProvider
	);
}

/**
 * Read the synced columns for every registry row, keyed by provider.
 *
 * Throws if the read fails; the caller turns that into a fully-failed
 * summary. There is nothing useful to attempt afterwards — a read that
 * cannot reach the database means the writes could not either.
 */
async function readStoredColumns(): Promise<
	Map<string, SyncedRegistryColumns>
> {
	const rows = await db.integrationProviderRegistry.findMany({
		select: {
			providerKey: true,
			displayName: true,
			statusPageUrl: true,
			statusPageApiUrl: true,
			statusPagePolling: true,
			syntheticProbeEnabled: true,
			syntheticProbeInterval: true,
			breakerKey: true,
			affectedFeatures: true,
			dataConnectionProvider: true,
		},
	});

	const byKey = new Map<string, SyncedRegistryColumns>();
	for (const { providerKey, ...columns } of rows) {
		byKey.set(providerKey, columns);
	}
	return byKey;
}

/**
 * Reconcile every supplied provider registration against the
 * `IntegrationProviderRegistry` Prisma table. Safe to call multiple
 * times — uniqueness is enforced by the `providerKey` unique
 * constraint, and a registration whose stored row already matches is
 * skipped without a write.
 *
 * Never throws. On per-row error, logs and continues; on total DB
 * failure every row counts as failed.
 */
export async function syncIntegrationProviderRegistry(
	registrations: readonly IntegrationProviderRegistrationInput[],
): Promise<SyncIntegrationProviderRegistrySummary> {
	const summary: SyncIntegrationProviderRegistrySummary = {
		created: 0,
		updated: 0,
		skipped: 0,
		failed: 0,
	};

	if (registrations.length === 0) {
		return summary;
	}

	let stored: Map<string, SyncedRegistryColumns>;
	try {
		stored = await readStoredColumns();
	} catch (err) {
		// The database is unreachable, so attempting the writes anyway
		// would only produce N copies of the same failure. Log once, count
		// every registration as failed, and let the next boot reconcile.
		// Avoid pulling @repo/logs into this package — keep the dep graph
		// small. Use console.error directly so the message lands in the API
		// container logs.
		console.error(
			"[integration-provider-registry-sync] Failed to read existing rows; skipping sync until next boot:",
			err,
		);
		summary.failed = registrations.length;
		return summary;
	}

	for (const reg of registrations) {
		const data = toSyncedColumns(reg);
		const existing = stored.get(reg.key);

		try {
			if (!existing) {
				// Create path includes the unique key + initial defaults. Do
				// NOT set `currentHealth` here — the column defaults to
				// `UNKNOWN` via the Prisma schema, which is exactly what we
				// want for a brand-new provider that has never been polled.
				await db.integrationProviderRegistry.create({
					data: { providerKey: reg.key, ...data },
				});
				summary.created++;
				continue;
			}

			if (matchesStoredRow(existing, data)) {
				summary.skipped++;
				continue;
			}

			// Update path explicitly does NOT touch `currentHealth`,
			// `lastPolledAt`, or `lastIncidentId` — those are owned by
			// the Temporal pollers.
			await db.integrationProviderRegistry.update({
				where: { providerKey: reg.key },
				data,
			});
			summary.updated++;
		} catch (err) {
			// Best-effort boot. Log and continue.
			summary.failed++;
			console.error(
				`[integration-provider-registry-sync] Failed to sync provider "${reg.key}":`,
				err,
			);
		}
	}

	return summary;
}
