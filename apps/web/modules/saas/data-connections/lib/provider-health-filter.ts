/**
 * Pure helpers for the Settings -> Integrations status filter.
 *
 * Extracted from `ConnectionsPageContent.tsx` so the filter logic is
 * unit-testable without rendering the page (which would require mocking
 * organization context, oRPC, and TanStack Query).
 *
 */

import type { DataConnectionProvider } from "@repo/connectors/types";

export type StatusFilterValue =
	| "all"
	| "operational"
	| "degraded"
	| "outage"
	| "unknown";

export type HealthStatusValue =
	| "OPERATIONAL"
	| "DEGRADED"
	| "PARTIAL_OUTAGE"
	| "MAJOR_OUTAGE"
	| "MAINTENANCE"
	| "UNKNOWN"
	| "NOT_CONFIGURED";

export interface HealthLookupRow {
	providerKey: string;
	dataConnectionProvider: string | null;
	currentHealth: HealthStatusValue;
}

/**
 * Returns `true` when the provider should remain in the filtered grid
 * given the active status filter and the global health lookup.
 *
 * The grid never hides a provider for the `all` filter, regardless of
 * whether the lookup has a row for it.
 */
export function matchesStatusFilter(
	provider: DataConnectionProvider,
	statusFilter: StatusFilterValue,
	byProviderKey: Record<string, HealthLookupRow>,
): boolean {
	if (statusFilter === "all") {
		return true;
	}
	const health = resolveProviderHealth(provider, byProviderKey);
	if (statusFilter === "operational") {
		return health === "OPERATIONAL";
	}
	if (statusFilter === "degraded") {
		return health === "DEGRADED";
	}
	if (statusFilter === "outage") {
		return health === "MAJOR_OUTAGE" || health === "PARTIAL_OUTAGE";
	}
	if (statusFilter === "unknown") {
		return health === "UNKNOWN";
	}
	return true;
}

/**
 * Looks up the upstream health rating for a given DataConnectionProvider
 * by trying (in order):
 *   1. Any row whose `dataConnectionProvider` matches the enum value.
 *   2. The lowercase registry key (`google_drive`) -- defensive fallback
 *      while the seed normalises to canonical keys.
 *
 * Falls back to `UNKNOWN` when no row is found -- the UI must always be
 * able to render something, even before the registry is fully seeded.
 */
export function resolveProviderHealth(
	provider: DataConnectionProvider,
	byProviderKey: Record<string, HealthLookupRow>,
): HealthStatusValue {
	for (const row of Object.values(byProviderKey)) {
		if (row.dataConnectionProvider === provider) {
			return row.currentHealth;
		}
	}
	const lowercased = byProviderKey[provider.toLowerCase()];
	if (lowercased) {
		return lowercased.currentHealth;
	}
	return "UNKNOWN";
}
