/**
 * useProviderHealth Hook
 *
 * Fetches provider-health for the Settings -> Integrations page. Wraps the
 * bulk `integrationHealth.listProviderHealth` oRPC procedure and returns a
 * lookup keyed by `providerKey` so each `ConnectionCard` can resolve its
 * own health row in O(1).
 *
 * Behaviour
 * ---------
 * - 30s `refetchInterval` to match the incident-banner cadence.
 * - Disabled when the `feature-integration-health-badges` flag is off, so
 *   tenants without the feature pay zero round-trips. Callers MUST gate the
 *   hook with `useMonitoringFeatureFlag("feature-integration-health-badges")`
 *   when they want both UI + query gated together (we expose `enabled` so
 *   the caller chooses).
 * - The query is GLOBAL (provider health is not per-tenant); no
 *   `organizationId` is included in the cache key.
 */

"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

/**
 * Shape of one row returned by `listProviderHealth`. Mirrors the Prisma
 * `IntegrationProviderRegistry` row plus the joined `activeIncident`.
 * Defined locally so the data-connections module is not coupled to the
 * generated Prisma types in the client bundle.
 */
interface ProviderHealthRow {
	id: string;
	providerKey: string;
	displayName: string;
	currentHealth:
		| "OPERATIONAL"
		| "DEGRADED"
		| "PARTIAL_OUTAGE"
		| "MAJOR_OUTAGE"
		| "MAINTENANCE"
		| "UNKNOWN"
		| "NOT_CONFIGURED";
	lastPolledAt: string | Date | null;
	statusPageUrl: string | null;
	dataConnectionProvider: string | null;
	activeIncident: {
		id: string;
		providerKey: string;
		providerName: string;
		severity: "SEV1" | "SEV2" | "SEV3";
		health: ProviderHealthRow["currentHealth"];
		status: "FIRING" | "ACKNOWLEDGED" | "RESOLVED";
		startedAt: string | Date;
		resolvedAt: string | Date | null;
		summary: string | null;
		statusPageUrl: string | null;
	} | null;
}

/** Default refresh cadence matches the app-shell incident banner. */
const REFETCH_INTERVAL_MS = 30_000;

export interface UseProviderHealthResult {
	/** Map of `providerKey` -> health row. Empty object when loading or disabled. */
	byProviderKey: Record<string, ProviderHealthRow>;
	/** Raw list as returned by the server, preserving server-side ordering. */
	rows: ProviderHealthRow[];
	isLoading: boolean;
	isError: boolean;
	error: unknown;
}

export function useProviderHealth(
	options: { enabled?: boolean } = {},
): UseProviderHealthResult {
	const enabled = options.enabled ?? true;

	const { data, isLoading, isError, error } = useQuery({
		queryKey: ["integrationHealth", "listProviderHealth"],
		queryFn: async () => {
			const result =
				(await orpcClient.integrationHealth.listProviderHealth({})) as {
					providers: ProviderHealthRow[];
				};
			return result.providers;
		},
		refetchInterval: REFETCH_INTERVAL_MS,
		refetchOnWindowFocus: false,
		enabled,
	});

	const byProviderKey = useMemo(() => {
		const lookup: Record<string, ProviderHealthRow> = {};
		for (const row of data ?? []) {
			lookup[row.providerKey] = row;
		}
		return lookup;
	}, [data]);

	return {
		byProviderKey,
		rows: data ?? [],
		isLoading,
		isError,
		error,
	};
}
