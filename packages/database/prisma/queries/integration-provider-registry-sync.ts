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
 * Upsert every supplied provider registration into the
 * `IntegrationProviderRegistry` Prisma table. Safe to call multiple
 * times — uniqueness is enforced by the `providerKey` unique
 * constraint.
 *
 * Returns the number of rows upserted (always equals the count of
 * registrations on success). On per-row error, logs and continues —
 * never throws. On total DB failure, every row counts as failed and
 * the function returns `0`.
 */
export async function syncIntegrationProviderRegistry(
	registrations: readonly IntegrationProviderRegistrationInput[],
): Promise<number> {
	let upserted = 0;
	for (const reg of registrations) {
		try {
			await upsertOne(reg);
			upserted++;
		} catch (err) {
			// Best-effort boot. Log and continue.
			// Avoid pulling @repo/logs into this package — keep the
			// dep graph small. Use console.error directly so the
			// message lands in the API container logs.
			console.error(
				`[integration-provider-registry-sync] Failed to upsert provider "${reg.key}":`,
				err,
			);
		}
	}

	return upserted;
}

/**
 * Single-row upsert. Match on the `providerKey` unique key. Update
 * the static config columns only — runtime state (`currentHealth`,
 * `lastPolledAt`, `lastIncidentId`) is preserved across reboots.
 */
async function upsertOne(
	reg: IntegrationProviderRegistrationInput,
): Promise<void> {
	const data = {
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

	await db.integrationProviderRegistry.upsert({
		where: { providerKey: reg.key },
		// Create path includes the unique key + initial defaults. Do
		// NOT set `currentHealth` here — the column defaults to
		// `UNKNOWN` via the Prisma schema, which is exactly what we
		// want for a brand-new provider that has never been polled.
		create: {
			providerKey: reg.key,
			...data,
		},
		// Update path explicitly does NOT touch `currentHealth`,
		// `lastPolledAt`, or `lastIncidentId` — those are owned by
		// the Temporal pollers.
		update: data,
	});
}
