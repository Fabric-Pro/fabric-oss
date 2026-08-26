/**
 * Raw signal queries backing the customer-facing system-health surface.
 *
 * Every function here is a plain Postgres read. There is deliberately no probe
 * that calls the workflow engine, an AI provider, or any other service: the
 * dashboard must not depend on the infrastructure it reports on, and a
 * reachable-but-idle dependency is exactly the failure a liveness ping reports
 * as healthy.
 *
 * This module knows nothing about the component registry — it returns raw
 * signals, and `@repo/api` resolves them into statuses. Keeping the registry
 * out of here is what avoids the
 * `observability → database → storage → observability` package cycle.
 */

import { db } from "../client";

/**
 * Provider/component health vocabulary, as a string-literal union rather than
 * an imported generated enum. Matches the convention in `incidents.ts` /
 * `component-incidents.ts`, and avoids a value-import of a generated enum —
 * which breaks every test that mocks `@repo/database` without re-exporting it.
 */
export type HealthStatusValue =
	| "OPERATIONAL"
	| "DEGRADED"
	| "PARTIAL_OUTAGE"
	| "MAJOR_OUTAGE"
	| "MAINTENANCE"
	| "UNKNOWN"
	| "NOT_CONFIGURED";

/**
 * Audit action keys that indicate a fault on OUR side.
 *
 * Deliberately excludes `error.validation`, `error.permission_denied`,
 * `error.not_found`, `error.conflict` and `error.rate_limited`: those are
 * overwhelmingly the caller's own doing, and counting them would render a
 * tenant's own malformed requests as a platform outage on their dashboard.
 */
export const SERVER_FAULT_ACTIONS = [
	"error.internal",
	"error.unavailable",
	"error.timeout",
] as const;

/**
 * `DataConnection.status` values that mean the customer needs to act
 * (reconnect, re-authorise, fix credentials).
 */
const UNHEALTHY_CONNECTION_STATUSES = ["ERROR", "EXPIRED", "REVOKED"] as const;

/**
 * Ceiling on unfiltered GLOBAL-table reads issued per dashboard load.
 *
 * These reads carry no tenant predicate, so nothing else bounds them, and they
 * run on every 60s poll for every authenticated user. The result set peaks
 * during a real incident — precisely when every customer is also loading the
 * page — so the two pressures compound at the worst moment.
 *
 * Chosen to sit far above any plausible number of simultaneously-open incidents
 * while still being a hard ceiling. The sibling `listStatusUpdateHistory`
 * already clamps for the same stated reason; these were missed because they are
 * signal reads rather than a paginated list.
 */
const GLOBAL_SIGNAL_CAP = 200;

export interface SystemHealthScope {
	organizationId: string | null;
	userId: string | null;
}

/**
 * Build the XOR tenant filter. Org context anchors on `organizationId`;
 * personal context requires BOTH `organizationId: null` and the caller's own
 * `userId`, so a personal read can never see another user's rows.
 */
function tenantWhere(scope: SystemHealthScope) {
	if (scope.organizationId) {
		return { organizationId: scope.organizationId };
	}
	return { organizationId: null, userId: scope.userId };
}

/**
 * Count the tenant's own server-fault audit rows in a rolling window.
 *
 * Uses the existing `[organizationId, createdAt desc]` / `[category,
 * createdAt desc]` indexes — no new index required.
 */
export async function countTenantServerFaults(args: {
	scope: SystemHealthScope;
	since: Date;
}): Promise<number> {
	return db.auditLog.count({
		where: {
			...tenantWhere(args.scope),
			action: { in: [...SERVER_FAULT_ACTIONS] },
			createdAt: { gte: args.since },
		},
	});
}

/**
 * Most recent moment background processing demonstrably completed work.
 *
 * `IntegrationProviderRegistry.lastPolledAt` is written by the status-page
 * poller every two minutes. Reading the maximum across the registry is an
 * end-to-end liveness signal: the schedule fired, the workflow ran, the
 * activity committed. Returns `null` when nothing has ever polled, which the
 * resolver treats as UNKNOWN rather than healthy.
 */
export async function getLastBackgroundWorkAt(): Promise<Date | null> {
	const row = await db.integrationProviderRegistry.aggregate({
		_max: { lastPolledAt: true },
	});
	return row._max.lastPolledAt ?? null;
}

/**
 * Current health for the named provider keys. Missing keys are simply absent
 * from the map — the resolver reports UNKNOWN for those rather than assuming
 * they are fine.
 */
export async function getProviderHealthByKeys(
	providerKeys: string[],
): Promise<Map<string, HealthStatusValue>> {
	if (providerKeys.length === 0) return new Map();
	const rows = await db.integrationProviderRegistry.findMany({
		where: { providerKey: { in: providerKeys } },
		select: { providerKey: true, currentHealth: true },
	});
	return new Map(
		rows.map((r) => [r.providerKey, r.currentHealth as HealthStatusValue]),
	);
}

export interface TenantConnectionSummary {
	/** Distinct `DataConnectionProvider` enum values the tenant has connected. */
	connectedProviders: string[];
	/** How many of the tenant's connections need the customer to act. */
	unhealthyCount: number;
	/** Total connections, so "2 of 9" can be stated rather than just "2". */
	totalCount: number;
}

/**
 * The tenant's own connection inventory and how much of it is broken.
 *
 * Drives both the `integrations` component's status AND per-tenant relevance
 * filtering of global provider incidents — an outage at a provider the tenant
 * never connected is not their problem and is not shown to them.
 */
export async function getTenantConnectionSummary(
	scope: SystemHealthScope,
): Promise<TenantConnectionSummary> {
	const rows = await db.dataConnection.findMany({
		where: tenantWhere(scope),
		select: { provider: true, status: true },
	});
	const unhealthy = new Set<string>(UNHEALTHY_CONNECTION_STATUSES);
	return {
		connectedProviders: Array.from(new Set(rows.map((r) => r.provider))),
		unhealthyCount: rows.filter((r) => unhealthy.has(r.status)).length,
		totalCount: rows.length,
	};
}

export interface OpenComponentIncidentSignal {
	componentKey: string;
	severity: string;
}

/**
 * Open (FIRING or ACKNOWLEDGED) internal subsystem incidents.
 *
 * Returned raw — the resolver maps `componentKey` onto a customer-visible
 * component through the registry's explicit allow-list, because that column is
 * free text written by whatever posts the alertmanager webhook and an
 * unrecognised key must not silently create a phantom component.
 */
export async function listOpenComponentIncidents(): Promise<
	OpenComponentIncidentSignal[]
> {
	const rows = await db.componentIncident.findMany({
		where: { status: { in: ["FIRING", "ACKNOWLEDGED"] } },
		select: { componentKey: true, severity: true },
		orderBy: { firedAt: "desc" },
		// Capped: this is a GLOBAL table read that fires on every dashboard poll
		// for every user, and the result set is largest during exactly the
		// incident the dashboard exists for. Only the worst status per component
		// survives the resolver, so a cap costs nothing in fidelity — a component
		// with 200 open incidents resolves identically to one with 5.
		take: GLOBAL_SIGNAL_CAP,
	});
	return rows.map((r) => ({
		componentKey: r.componentKey,
		severity: r.severity,
	}));
}

export interface OpenProviderIncidentSignal {
	providerKey: string;
	providerName: string;
	severity: string;
	health: HealthStatusValue;
	startedAt: Date;
	/** Vendor status-page link, when the provider publishes one. */
	statusPageUrl: string | null;
}

/**
 * Open provider incidents, unfiltered. The caller narrows to the providers the
 * tenant actually connected.
 *
 * `summary` is deliberately NOT selected: it is vendor/alert payload text and
 * is not cleared for customer display. Customer-facing wording comes from a
 * `StatusUpdate`.
 */
export async function listOpenProviderIncidents(): Promise<
	OpenProviderIncidentSignal[]
> {
	const rows = await db.integrationIncident.findMany({
		where: { status: { in: ["FIRING", "ACKNOWLEDGED"] } },
		select: {
			providerKey: true,
			providerName: true,
			severity: true,
			health: true,
			startedAt: true,
			statusPageUrl: true,
		},
		orderBy: { startedAt: "desc" },
		// Same reasoning as `listOpenComponentIncidents`. Newest-first, so a cap
		// drops the stalest rows rather than the ones a customer is asking about.
		take: GLOBAL_SIGNAL_CAP,
	});
	return rows.map((r) => ({
		providerKey: r.providerKey,
		providerName: r.providerName,
		severity: r.severity,
		health: r.health as HealthStatusValue,
		startedAt: r.startedAt,
		statusPageUrl: r.statusPageUrl,
	}));
}
