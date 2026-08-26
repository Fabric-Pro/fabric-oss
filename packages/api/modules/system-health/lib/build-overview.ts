/**
 * Assemble the customer-facing health overview from the registry + raw signals.
 *
 * Split out of the procedure so both the oRPC procedure and the API-key REST
 * route return byte-identical shapes from one code path — two hand-written
 * projections of the same data is how an external consumer ends up seeing a
 * field the in-product surface withheld.
 */

import {
	type CustomerStatusUpdate,
	countTenantServerFaults,
	getLastBackgroundWorkAt,
	getProviderHealthByKeys,
	getTenantConnectionSummary,
	listActiveStatusUpdates,
	listOpenComponentIncidents,
	listOpenProviderIncidents,
	type SystemHealthScope,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	getIncidentKeyOwners,
	listCustomerVisibleComponents,
	listRegistrations,
} from "@repo/observability";
import {
	type HealthStatus,
	impactToStatus,
	isWorse,
	type ResolvedComponent,
	resolveComponents,
	resolveOverallStatus,
	severityToStatus,
} from "./resolve-component-health";

/** Longest window any registered component asks for, so one query serves all. */
function widestFaultWindowMinutes(): number {
	return listCustomerVisibleComponents().reduce((widest, c) => {
		return c.signal.kind === "tenant-server-faults"
			? Math.max(widest, c.signal.windowMinutes)
			: widest;
	}, 0);
}

/** Every provider key any registered component rolls up. */
function rolledUpProviderKeys(): string[] {
	const keys = new Set<string>();
	for (const component of listCustomerVisibleComponents()) {
		if (component.signal.kind === "provider-rollup") {
			for (const key of component.signal.providerKeys) keys.add(key);
		}
	}
	return Array.from(keys);
}

/**
 * Provider keys relevant to a tenant, derived from the `DataConnectionProvider`
 * enum values they have actually connected.
 *
 * The registry's `dataConnectionProvider` field is the join: it maps a registry
 * key ("notion") to the enum value stored on `DataConnection` ("NOTION").
 */
function providerKeysForConnectedProviders(
	connectedProviders: string[],
): Set<string> {
	if (connectedProviders.length === 0) return new Set();
	const connected = new Set(connectedProviders);
	const keys = new Set<string>();
	for (const registration of listRegistrations()) {
		if (
			registration.dataConnectionProvider &&
			connected.has(registration.dataConnectionProvider)
		) {
			keys.add(registration.key);
		}
	}
	return keys;
}

interface RelevantProviderIssue {
	providerKey: string;
	providerName: string;
	status: HealthStatus;
	startedAt: Date;
	statusPageUrl: string | null;
}

export interface SystemHealthOverview {
	overallStatus: HealthStatus;
	components: ResolvedComponent[];
	/** Active announcements, customer-safe projection. */
	announcements: CustomerStatusUpdate[];
	/** Open provider issues, narrowed to providers this tenant connected. */
	providerIssues: RelevantProviderIssue[];
	generatedAt: Date;
}

/**
 * Build the overview for one tenant.
 *
 * All seven signal reads are issued concurrently — they are independent, and
 * serialising them would put seven round-trips on a page load.
 *
 * They are settled INDIVIDUALLY rather than with `Promise.all`, and that is the
 * difference between this page working during an outage and not.
 *
 * With `Promise.all` a single failing read rejects the whole overview, the
 * procedure propagates it, and the customer gets "We could not load platform
 * status" — no per-component detail at all. The page whose entire purpose is to
 * answer "is this problem yours or mine" would go blank precisely when it is
 * asked. Worse, the most likely cause of a failing read is the datastore, which
 * is also what the `core-api` component measures, so the one dependency the
 * requirement exists to guard against was the one that could black the page out.
 *
 * Settling per read keeps the same rule the resolver already applies to a stale
 * signal: an unavailable signal resolves its component to UNKNOWN, never to
 * green and never to a hard failure. A partial outage now yields a partial
 * answer, which is the honest and useful result.
 */
export async function buildSystemHealthOverview(
	scope: SystemHealthScope,
	now: Date = new Date(),
): Promise<SystemHealthOverview> {
	const faultWindowMinutes = widestFaultWindowMinutes();
	const providerKeys = rolledUpProviderKeys();

	/**
	 * Run one signal read, degrading to `fallback` if it fails.
	 *
	 * The failure is logged rather than swallowed silently — a signal that has
	 * started failing is itself an operational event, and the customer-visible
	 * UNKNOWN is deliberately not enough to notice it by.
	 */
	async function settle<T>(
		label: string,
		read: () => Promise<T>,
		fallback: T,
	): Promise<T> {
		try {
			return await read();
		} catch (error) {
			logger.warn(
				{
					event: "system_health.signal_read_failed",
					signal: label,
					error:
						error instanceof Error ? error.message : String(error),
				},
				"System-health signal read failed; degrading that component to UNKNOWN",
			);
			return fallback;
		}
	}

	const [
		serverFaultCount,
		lastBackgroundWorkAt,
		providerHealth,
		connections,
		componentIncidents,
		providerIncidents,
		announcements,
	] = await Promise.all([
		faultWindowMinutes > 0
			? settle(
					"tenant-server-faults",
					() =>
						countTenantServerFaults({
							scope,
							since: new Date(
								now.getTime() - faultWindowMinutes * 60_000,
							),
						}),
					// Zero, not "unknown": the fault count only ever moves this
					// component AWAY from operational, so a failed read must not
					// invent a problem. The datastore being unreachable surfaces
					// through the other components instead.
					0,
				)
			: Promise.resolve(0),
		settle("background-work-freshness", getLastBackgroundWorkAt, null),
		settle(
			"provider-health",
			() => getProviderHealthByKeys(providerKeys),
			// Empty map, so every rolled-up provider resolves to UNKNOWN rather
			// than to a false green.
			new Map<string, HealthStatus>(),
		),
		settle("tenant-connections", () => getTenantConnectionSummary(scope), {
			connectedProviders: [],
			unhealthyCount: 0,
			totalCount: 0,
		}),
		settle("component-incidents", listOpenComponentIncidents, []),
		settle("provider-incidents", listOpenProviderIncidents, []),
		settle("status-announcements", listActiveStatusUpdates, []),
	]);

	// Fold internally-detected subsystem incidents onto customer components via
	// the registry's explicit allow-list. An unrecognised `componentKey` is
	// dropped rather than creating a phantom component on the customer surface.
	const incidentOwners = getIncidentKeyOwners();
	const incidentStatusByComponent = new Map<string, HealthStatus>();
	for (const incident of componentIncidents) {
		const owner = incidentOwners.get(incident.componentKey);
		if (!owner) continue;
		const status = severityToStatus(incident.severity);
		const existing = incidentStatusByComponent.get(owner);
		if (!existing || isWorse(status, existing)) {
			incidentStatusByComponent.set(owner, status);
		}
	}

	const tenantProviderKeys = providerKeysForConnectedProviders(
		connections.connectedProviders,
	);

	// Per-tenant announcement relevance. `StatusUpdate.affectedProviderKeys`
	// exists for exactly this — its schema comment promises "an announcement
	// about a provider the tenant never connected is not shown to them" — and
	// nothing implemented it, so every tenant saw every provider announcement.
	//
	// An EMPTY list means platform-wide (a core-api outage is not provider
	// scoped) and is always shown. A non-empty list is shown only when the
	// tenant actually connected one of those providers.
	//
	// Filtered ONCE, before both uses below. Filtering only the list would leave
	// a component painted by an announcement the tenant cannot see — a status
	// change with no visible explanation, which is worse than showing the text.
	const relevantAnnouncements = announcements.filter(
		(announcement) =>
			announcement.affectedProviderKeys.length === 0 ||
			announcement.affectedProviderKeys.some((key) =>
				tenantProviderKeys.has(key),
			),
	);

	// An announcement with impact NONE is informational: it still appears in the
	// announcements list, but must not change a component's status.
	const announcementStatusByComponent = new Map<string, HealthStatus>();
	for (const announcement of relevantAnnouncements) {
		const status = impactToStatus(announcement.impact);
		if (!status) continue;
		for (const key of announcement.affectedComponentKeys) {
			const existing = announcementStatusByComponent.get(key);
			if (!existing || isWorse(status, existing)) {
				announcementStatusByComponent.set(key, status);
			}
		}
	}

	const providerIssues: RelevantProviderIssue[] = providerIncidents
		.filter((incident) => tenantProviderKeys.has(incident.providerKey))
		.map((incident) => ({
			providerKey: incident.providerKey,
			providerName: incident.providerName,
			status: incident.health,
			startedAt: incident.startedAt,
			statusPageUrl: incident.statusPageUrl,
		}));

	const components = resolveComponents(listCustomerVisibleComponents(), {
		serverFaultCount,
		lastBackgroundWorkAt,
		providerHealth,
		unhealthyConnectionCount: connections.unhealthyCount,
		totalConnectionCount: connections.totalCount,
		relevantProviderIncidentCount: providerIssues.length,
		incidentStatusByComponent,
		announcementStatusByComponent,
		now,
	});

	return {
		// Announcement impacts come from `relevantAnnouncements`, already filtered
		// per tenant above, so a provider-scoped announcement cannot degrade the
		// banner for a tenant that never connected that provider.
		overallStatus: resolveOverallStatus(
			components,
			relevantAnnouncements
				.map((a) => impactToStatus(a.impact))
				.filter((s): s is HealthStatus => s !== null),
		),
		components,
		announcements: relevantAnnouncements,
		providerIssues,
		generatedAt: now,
	};
}
