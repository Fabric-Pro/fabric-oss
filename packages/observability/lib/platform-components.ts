/**
 * Platform Component Registry — the customer-facing view of Fabric's own
 * subsystems.
 *
 * Sibling concept to `integration-registry.ts`, which catalogues THIRD-PARTY
 * providers. This one catalogues Fabric itself: the handful of subsystems a
 * customer can meaningfully reason about when something looks wrong ("is the
 * API degraded, or is my Notion connection broken, or is it me?").
 *
 * Two deliberate differences from the provider registry:
 *
 *   1. **No DB mirror.** The provider registry is mirrored into Postgres
 *      because the Settings → Integrations *client* needs badges from one bulk
 *      query without pulling the registry into the browser bundle. Component
 *      health is resolved server-side in an oRPC procedure that can import this
 *      module directly and returns plain JSON, so a mirror table would add a
 *      boot sync, a migration and a second source of truth for no gain.
 *
 *   2. **Every entry carries the signal that determines its health.** A
 *      component whose health cannot actually be measured would render a
 *      permanent, meaningless green — worse than not listing it at all. The
 *      `signal` field is what stops a component being registered aspirationally.
 *
 * Resolution of `signal` into a status lives in the API layer
 * (`resolveComponentHealth`), not here: this module stays pure static config
 * with no Prisma dependency, mirroring how the provider registry avoids the
 * `observability → database → storage → observability` package cycle.
 *
 * Adding a component is a config-only change — append one
 * `registerPlatformComponent({...})` call.
 */

/**
 * Coarse grouping used to section the customer dashboard. Kept small on
 * purpose: more groups than this and the page reads as an org chart rather
 * than an answer to "is it working".
 */
export type PlatformComponentGroup =
	| "CORE"
	| "AI"
	| "INTEGRATIONS"
	| "AUTOMATION"
	| "DATA";

/**
 * How a component's health is actually determined. Each variant names a
 * signal that exists in Postgres today — nothing here requires new
 * instrumentation.
 */
export type PlatformComponentSignal =
	/**
	 * Count of the calling tenant's own server-fault audit rows over a rolling
	 * window. Deliberately counts ONLY faults we caused (`error.internal`,
	 * `error.unavailable`, `error.timeout`) — a tenant's own validation and
	 * permission-denied errors are usually their own doing and would make bad
	 * requests look like a platform outage.
	 */
	| {
			kind: "tenant-server-faults";
			windowMinutes: number;
			/** Fault count at or above which the component reads DEGRADED. */
			degradedAt: number;
			/** Fault count at or above which it reads PARTIAL_OUTAGE. */
			outageAt: number;
	  }
	/**
	 * Freshness of work background processing demonstrably completed. Reads
	 * `max(IntegrationProviderRegistry.lastPolledAt)` — written every two
	 * minutes by the existing status-page poller.
	 *
	 * Chosen over pinging the workflow engine directly because a reachable
	 * engine that is not executing anything is exactly the failure a ping
	 * reports as healthy, and because the dashboard must not depend on the
	 * infrastructure it reports on.
	 */
	| {
			kind: "background-work-freshness";
			degradedAfterMinutes: number;
			/** Beyond this the signal is treated as dead → UNKNOWN, never green. */
			staleAfterMinutes: number;
	  }
	/**
	 * Rollup of `IntegrationProviderRegistry.currentHealth` across one or more
	 * platform provider keys. Worst status wins.
	 */
	| { kind: "provider-rollup"; providerKeys: string[] }
	/**
	 * The calling tenant's own connection health — how many of their
	 * `DataConnection` rows are in a failed/expired state, plus open provider
	 * incidents for providers they actually connected.
	 */
	| { kind: "tenant-connections" };

/**
 * Static configuration for one customer-visible platform component.
 *
 * Runtime state (current status, last evaluation time) is deliberately absent:
 * it is resolved per request from the signal, never stored.
 */
export interface PlatformComponentRegistration {
	/** Stable lower-case kebab key. Unique across the registry. */
	key: string;

	/**
	 * Customer-facing label. Names a capability the customer recognises, not
	 * an internal service ("Background processing", not "temporal-worker").
	 */
	displayName: string;

	/**
	 * Customer-safe one-line description. Must not name internal topology,
	 * hostnames, or vendors the customer has no relationship with.
	 */
	description: string;

	group: PlatformComponentGroup;

	/** What determines this component's health. See `PlatformComponentSignal`. */
	signal: PlatformComponentSignal;

	/**
	 * `ComponentIncident.componentKey` values that should surface against this
	 * component. That column is free text written by whatever posts the
	 * alertmanager webhook, so the mapping is an explicit allow-list rather
	 * than an assumed key match — and one component can absorb several
	 * internal subsystem keys.
	 */
	incidentKeys?: string[];

	/**
	 * Defaults to `true`. Set `false` for a component that is worth resolving
	 * internally but carries no customer-actionable meaning.
	 */
	customerVisible?: boolean;

	/** Ascending sort position on the dashboard. */
	displayOrder: number;
}

const REGISTRY = new Map<string, PlatformComponentRegistration>();

/**
 * Register one platform component. Throws on a duplicate key — the registry is
 * append-only at boot and a silent overwrite would shadow an earlier entry.
 */
export function registerPlatformComponent(
	reg: PlatformComponentRegistration,
): void {
	if (REGISTRY.has(reg.key)) {
		throw new Error(`Duplicate platform component key: ${reg.key}`);
	}
	REGISTRY.set(reg.key, clonePlatformComponent(reg));
}

/**
 * Deep-copy a registration so a caller cannot mutate stored entries.
 *
 * A spread alone would leave `incidentKeys` and the nested `signal` (with its
 * `providerKeys` array) shared. `structuredClone` handles the whole shape —
 * every field is plain JSON-cloneable data — so a field added later cannot be
 * forgotten here, which a hand-rolled copy invites.
 */
function clonePlatformComponent(
	reg: PlatformComponentRegistration,
): PlatformComponentRegistration {
	return structuredClone(reg);
}

/**
 * Every registration, in display order. Returns deep copies so a caller
 * cannot mutate stored entries.
 */
export function listPlatformComponents(): PlatformComponentRegistration[] {
	return Array.from(REGISTRY.values())
		.map(clonePlatformComponent)
		.sort((a, b) => a.displayOrder - b.displayOrder);
}

/** The subset a customer should see, in display order. */
export function listCustomerVisibleComponents(): PlatformComponentRegistration[] {
	return listPlatformComponents().filter((c) => c.customerVisible !== false);
}

/**
 * Every `ComponentIncident.componentKey` the registry claims, mapped to the
 * component that owns it. Used to fold internally-detected subsystem outages
 * onto the customer surface without a per-caller join.
 */
export function getIncidentKeyOwners(): Map<string, string> {
	const owners = new Map<string, string>();
	for (const component of listPlatformComponents()) {
		for (const incidentKey of component.incidentKeys ?? []) {
			owners.set(incidentKey, component.key);
		}
	}
	return owners;
}

/**
 * Test-only reset. The registry is module-scoped and populated at import time,
 * so a test wanting a clean slate (or exercising the duplicate guard) must
 * clear it explicitly.
 */
export function __resetPlatformComponentsForTests(): void {
	REGISTRY.clear();
}
