/**
 * Resolve raw health signals into the statuses a customer sees.
 *
 * Deliberately a PURE function over already-fetched inputs. Every interesting
 * rule here — precedence, staleness, rollup arithmetic — is a branch that wants
 * a test, and none of them should require a database to exercise.
 *
 * This module is the bridge between the registry (`@repo/observability`, static
 * config) and the signals (`@repo/database`, raw reads). It lives in
 * `@repo/api` because that is the only package that already depends on both,
 * the same reasoning as the provider-registry boot bridge.
 */

import type { StatusUpdateImpact as CanonicalImpact } from "@repo/database";
import type {
	PlatformComponentGroup,
	PlatformComponentRegistration,
} from "@repo/observability";

export type HealthStatus =
	| "OPERATIONAL"
	| "DEGRADED"
	| "PARTIAL_OUTAGE"
	| "MAJOR_OUTAGE"
	| "MAINTENANCE"
	| "UNKNOWN"
	| "NOT_CONFIGURED";

/**
 * Ordering used by every "worst wins" rollup.
 *
 * Two placements are deliberate and worth stating:
 *
 *   - `UNKNOWN` ranks BELOW `DEGRADED`. A known degradation must never be
 *     masked by an unknown sibling — "we know this is bad" outranks "we don't
 *     know about that".
 *   - `NOT_CONFIGURED` ranks near the bottom because it is not an outage. It
 *     means we cannot OBSERVE the capability here — the probe credential is
 *     absent in this environment — and says nothing about whether it works.
 *     Usually it does.
 */
const STATUS_RANK: Record<HealthStatus, number> = {
	OPERATIONAL: 0,
	NOT_CONFIGURED: 1,
	MAINTENANCE: 2,
	UNKNOWN: 3,
	DEGRADED: 4,
	PARTIAL_OUTAGE: 5,
	MAJOR_OUTAGE: 6,
};

export function isWorse(a: HealthStatus, b: HealthStatus): boolean {
	return STATUS_RANK[a] > STATUS_RANK[b];
}

/** Worst of the given statuses, or `OPERATIONAL` when the list is empty. */
export function worstStatus(statuses: HealthStatus[]): HealthStatus {
	return statuses.reduce<HealthStatus>(
		(worst, s) => (isWorse(s, worst) ? s : worst),
		"OPERATIONAL",
	);
}

/**
 * Both aliases resolve to the generated Prisma enum types, deliberately rather
 * than re-declaring the literal unions by hand.
 *
 * These values live in exactly one place — the `StatusUpdateLifecycle` /
 * `StatusUpdateImpact` enums in the Prisma schema — and adding a variant there
 * must break every consumer that has not handled it. Four independent hand-written
 * copies of the same union produced the opposite: a migration plus `generate` would
 * update the canonical type and leave the copies silently short, with no build error
 * pointing at the label maps and option lists that had gone stale.
 */
export type StatusUpdateImpact = CanonicalImpact;

/**
 * Map a human-declared customer impact onto a component status.
 *
 * `NONE` returns `null` rather than `OPERATIONAL`: an informational
 * announcement must not *upgrade* a component that a probe or an incident has
 * already found unhealthy.
 */
export function impactToStatus(
	impact: StatusUpdateImpact,
): HealthStatus | null {
	switch (impact) {
		case "CRITICAL":
			return "MAJOR_OUTAGE";
		case "MAJOR":
			return "PARTIAL_OUTAGE";
		case "MINOR":
			return "DEGRADED";
		case "NONE":
			return null;
		default: {
			// Exhaustiveness: a new impact value must be handled here rather
			// than silently resolving to "fine".
			const never: never = impact;
			throw new Error(`Unhandled status impact: ${String(never)}`);
		}
	}
}

/** Internal SEV ladder → customer-facing status. */
export function severityToStatus(severity: string): HealthStatus {
	switch (severity) {
		case "SEV1":
			return "MAJOR_OUTAGE";
		case "SEV2":
			return "PARTIAL_OUTAGE";
		case "SEV3":
			return "DEGRADED";
		default:
			// An unrecognised severity is a signal we cannot interpret — report
			// UNKNOWN rather than assuming it is minor.
			return "UNKNOWN";
	}
}

/** What decided a component's status. Diagnostic; never rendered to customers. */
type HealthSource = "announcement" | "incident" | "signal";

export interface ResolvedComponent {
	key: string;
	displayName: string;
	description: string;
	group: PlatformComponentGroup;
	status: HealthStatus;
	/** Customer-safe sentence explaining the status. Never names internals. */
	detail: string;
	source: HealthSource;
}

export interface HealthSignalInputs {
	/** The tenant's own server-fault count over the registry's window. */
	serverFaultCount: number;
	/** `max(lastPolledAt)` across the provider registry, or null if never. */
	lastBackgroundWorkAt: Date | null;
	/** Provider key → current health. Absent keys resolve to UNKNOWN. */
	providerHealth: Map<string, HealthStatus>;
	/** How many of the tenant's own connections need customer action. */
	unhealthyConnectionCount: number;
	/** Total connections the tenant has, for honest empty-state wording. */
	totalConnectionCount: number;
	/**
	 * Provider incidents narrowed to providers this tenant actually connected.
	 * Only the count is needed to move the integrations component.
	 */
	relevantProviderIncidentCount: number;
	/** Component key → worst open incident status, already mapped. */
	incidentStatusByComponent: Map<string, HealthStatus>;
	/**
	 * Component key → status implied by an active announcement. Absent when no
	 * announcement covers the component, or its impact is `NONE`.
	 */
	announcementStatusByComponent: Map<string, HealthStatus>;
	now: Date;
}

/**
 * Resolve one component.
 *
 * Precedence is fixed and deliberate: a human who published an announcement
 * outranks an automated detection, which outranks an inference from a signal.
 * A probe reading green while an operator has told customers the area is
 * degraded is the one outcome this ordering exists to prevent.
 */
export function resolveComponent(
	registration: PlatformComponentRegistration,
	inputs: HealthSignalInputs,
): ResolvedComponent {
	const base = {
		key: registration.key,
		displayName: registration.displayName,
		description: registration.description,
		group: registration.group,
	};

	const announced = inputs.announcementStatusByComponent.get(
		registration.key,
	);
	if (announced) {
		return {
			...base,
			status: announced,
			detail: "We have published an update about this area.",
			source: "announcement",
		};
	}

	const fromIncident = inputs.incidentStatusByComponent.get(registration.key);
	if (fromIncident) {
		return {
			...base,
			status: fromIncident,
			// Deliberately generic: the incident's own summary is machine-written
			// from alert payloads and carries internal topology.
			detail: "We are investigating a problem affecting this area.",
			source: "incident",
		};
	}

	const { status, detail } = resolveFromSignal(registration, inputs);
	return { ...base, status, detail, source: "signal" };
}

function resolveFromSignal(
	registration: PlatformComponentRegistration,
	inputs: HealthSignalInputs,
): { status: HealthStatus; detail: string } {
	const signal = registration.signal;

	switch (signal.kind) {
		case "tenant-server-faults": {
			if (inputs.serverFaultCount >= signal.outageAt) {
				return {
					status: "PARTIAL_OUTAGE",
					detail: `A high number of requests in your workspace failed in the last ${signal.windowMinutes} minutes.`,
				};
			}
			if (inputs.serverFaultCount >= signal.degradedAt) {
				return {
					status: "DEGRADED",
					detail: `Some requests in your workspace failed in the last ${signal.windowMinutes} minutes.`,
				};
			}
			return {
				status: "OPERATIONAL",
				detail: "No failed requests detected in your workspace recently.",
			};
		}

		case "background-work-freshness": {
			if (!inputs.lastBackgroundWorkAt) {
				return {
					status: "UNKNOWN",
					detail: "We have not been able to confirm background processing yet.",
				};
			}
			const minutesAgo =
				(inputs.now.getTime() - inputs.lastBackgroundWorkAt.getTime()) /
				60_000;
			// Staleness is checked FIRST. Past the stale threshold the signal is
			// dead, and a dead signal must resolve to UNKNOWN rather than being
			// reported as merely degraded — we genuinely do not know.
			if (minutesAgo >= signal.staleAfterMinutes) {
				return {
					status: "UNKNOWN",
					detail: "We cannot currently confirm that background work is running.",
				};
			}
			if (minutesAgo >= signal.degradedAfterMinutes) {
				return {
					status: "DEGRADED",
					detail: "Background work is running behind schedule.",
				};
			}
			return {
				status: "OPERATIONAL",
				detail: "Background work is running on schedule.",
			};
		}

		case "provider-rollup": {
			const statuses = signal.providerKeys.map(
				(key) => inputs.providerHealth.get(key) ?? "UNKNOWN",
			);
			// NOT_CONFIGURED entries are excluded rather than rolled up: a
			// capability backed by two providers where one is unconfigured in this
			// deployment still works if the other is healthy. Only when EVERY
			// backing provider is unconfigured is the capability unavailable.
			const configured = statuses.filter((s) => s !== "NOT_CONFIGURED");
			if (configured.length === 0) {
				return {
					status: "NOT_CONFIGURED",
					// Says only what is true. `NOT_CONFIGURED` means the synthetic
					// probe could not run because its credential is absent in this
					// environment — the capability itself may be working perfectly,
					// which is the normal case on any deployment that does not carry
					// probe credentials. Staging showed AI generation and file
					// storage both reading "not enabled on this deployment" while
					// both demonstrably worked, so the earlier wording asserted
					// something we do not know and that was usually false.
					detail: "We are not actively monitoring this capability in this environment, so we cannot report on it. It may be working normally.",
				};
			}
			const rolled = worstStatus(configured);
			return {
				status: rolled,
				detail:
					rolled === "OPERATIONAL"
						? "Operating normally."
						: "An upstream service this capability depends on is having problems.",
			};
		}

		case "tenant-connections": {
			if (inputs.totalConnectionCount === 0) {
				return {
					status: "OPERATIONAL",
					detail: "You have no connected tools yet.",
				};
			}
			if (inputs.unhealthyConnectionCount > 0) {
				return {
					status: "DEGRADED",
					detail: `${inputs.unhealthyConnectionCount} of your ${inputs.totalConnectionCount} connections need attention.`,
				};
			}
			if (inputs.relevantProviderIncidentCount > 0) {
				return {
					status: "DEGRADED",
					detail: "A provider you have connected is reporting a problem on their side.",
				};
			}
			return {
				status: "OPERATIONAL",
				detail: `All ${inputs.totalConnectionCount} of your connections are healthy.`,
			};
		}

		default: {
			const never: never = signal;
			throw new Error(
				`Unhandled platform component signal: ${JSON.stringify(never)}`,
			);
		}
	}
}

/**
 * Resolve every registration, in the order given.
 */
export function resolveComponents(
	registrations: PlatformComponentRegistration[],
	inputs: HealthSignalInputs,
): ResolvedComponent[] {
	return registrations.map((r) => resolveComponent(r, inputs));
}

/**
 * Headline status for the page banner — the worst of the component statuses and
 * any live announcement's own impact.
 *
 * `NOT_CONFIGURED` components are excluded: a capability that is deliberately
 * not enabled on this deployment should not make the whole platform read as
 * anything other than operational.
 *
 * **Announcement impact is folded in because components alone were not enough.**
 * `affectedComponentKeys` is optional — the authoring form only requires a title
 * and a body — so an admin can publish a MAJOR announcement that paints no
 * component. The banner then read "All systems operational" directly above
 * "Major impact", which is the one claim this surface must never make wrongly.
 * It became reachable at scale once the sweeper started notifying owners and
 * admins about exactly these announcements and sending them here to look.
 *
 * Pass the impacts of the announcements already filtered for this tenant, so a
 * provider-scoped announcement still only affects the tenants that use it.
 */
export function resolveOverallStatus(
	components: ResolvedComponent[],
	announcementStatuses: HealthStatus[] = [],
): HealthStatus {
	const relevant = components
		.map((c) => c.status)
		.filter((s) => s !== "NOT_CONFIGURED");
	// Dropping NOT_CONFIGURED is right while SOMETHING is monitored — one
	// deliberately-disabled capability must not drag the whole page down. But when
	// it empties the list, `worstStatus` seeds at OPERATIONAL and the page would
	// announce "All systems operational" on the strength of zero measurements.
	//
	// That is the one claim this surface must never make wrongly, and it is
	// reachable rather than theoretical: NOT_CONFIGURED is exactly what a component
	// reports when its probe credential is absent in an environment, so a
	// deployment with nothing wired up would show a full green all-clear.
	//
	// UNKNOWN is the honest answer — "we cannot tell you" — and it is what a single
	// stale signal already resolves to, so the vocabulary is consistent.
	if (relevant.length === 0) {
		// An announcement is a first-hand statement that something is wrong, so it
		// outranks having no measurements at all. Without this, a deployment with
		// nothing probed would answer UNKNOWN while actively announcing an outage.
		return announcementStatuses.length > 0
			? worstStatus(announcementStatuses)
			: "UNKNOWN";
	}
	return worstStatus([...relevant, ...announcementStatuses]);
}
