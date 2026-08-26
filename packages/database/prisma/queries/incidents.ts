/**
 * Incident query helpers.
 *
 * Pure DB read/write helpers for `ErrorRateIncident`, `IntegrationIncident`,
 * `IncidentEvent`, and `IntegrationProviderRegistry`. Consumed by the new
 * oRPC procedures in `packages/api/modules/incidents/` and
 * `packages/api/modules/integration-health/`, plus the Temporal poller at
 * `packages/temporal/src/activities/monitoring/poll-prometheus-active-alerts.ts`
 * that mirrors Prometheus active alerts into these tables every 30 s.
 *
 * Tenant scope:
 *   - `ErrorRateIncident`, `IntegrationIncident`, `IncidentEvent`,
 *     `IntegrationProviderRegistry` are all GLOBAL. There is
 *     no per-org XOR filter — admins own thresholds. Per-org rollups go
 *     through the existing `Notification` RLS path (handled in
 *     `incident-notifications.ts`).
 *
 * Locked decisions reflected here:
 *   - Manual acknowledge / resolve writes an `IncidentEvent` AND lets the
 *     caller signal the lifecycle workflow. Whichever lands first wins;
 *     the other is a no-op via the `status` guard in the update.
 *   - Pagination is cursor-based (`id` as cursor) so we can scale to many
 *     rows without `offset` getting expensive.
 */
import { getCorrelationIdFromContext } from "@repo/utils/correlation-id";
import { db, type Prisma } from "../client";
import { recordAudit } from "./audit-log";

// =============================================================================
// Shared types
// =============================================================================

// =============================================================================
// IncidentEvent → audit_log bridge (D17)
// =============================================================================

/**
 * Map an `IncidentEventType` to the corresponding closed-taxonomy
 * `incident.*` audit action key + severity. Centralized so every writer
 * (manual ack/resolve/comment paths AND Alertmanager upsert paths) emits
 * an identically-shaped audit row.
 */
const INCIDENT_AUDIT_MAP: Record<
	| "FIRED"
	| "RE_FIRED"
	| "ACKNOWLEDGED"
	| "COMMENT"
	| "AUTO_RESOLVED"
	| "MANUAL_RESOLVED",
	{
		action:
			| "incident.fired"
			| "incident.re_fired"
			| "incident.acknowledged"
			| "incident.commented"
			| "incident.auto_resolved"
			| "incident.manual_resolved";
		severity: "info" | "warning" | "error" | "critical";
	}
> = {
	// FIRING = something is wrong right now → error.
	FIRED: { action: "incident.fired", severity: "error" },
	RE_FIRED: { action: "incident.re_fired", severity: "error" },
	// Acknowledgement is operator-attention, not a problem of its own.
	ACKNOWLEDGED: { action: "incident.acknowledged", severity: "warning" },
	COMMENT: { action: "incident.commented", severity: "info" },
	// Resolution removes the problem state — informational.
	AUTO_RESOLVED: { action: "incident.auto_resolved", severity: "info" },
	MANUAL_RESOLVED: { action: "incident.manual_resolved", severity: "info" },
};

interface IncidentAuditBridgeInput {
	eventType:
		| "FIRED"
		| "RE_FIRED"
		| "ACKNOWLEDGED"
		| "COMMENT"
		| "AUTO_RESOLVED"
		| "MANUAL_RESOLVED";
	errorRateIncidentId?: string | null;
	integrationIncidentId?: string | null;
	incidentEventId: string;
	actorUserId?: string | null;
	/**
	 * Optional structured payload (e.g. Alertmanager summary, free-text
	 * comment, severity context). Stored under metadata.payload after
	 * sensitive-key redaction by the audit-log layer.
	 */
	payload?: unknown;
	/**
	 * Optional human-readable resource name for the viewer (e.g.
	 * `<alertName>` or `<providerName>`). Falls back to the incident ID
	 * when absent.
	 */
	resourceName?: string | null;
}

/**
 * Emit one audit_log row mirroring an IncidentEvent (D17). Fire-and-forget
 * via `recordAudit` — failures route through the standard
 * `onAuditWriteFailure` path so an audit-bridge failure cannot break the
 * canonical IncidentEvent write that just landed.
 *
 * Idempotence: each IncidentEvent row has a unique ID; we surface that
 * under `metadata.incidentEventId` so duplicate audit rows (from a retry
 * after the IncidentEvent insert succeeded but this bridge call failed)
 * can be detected by the operator.
 *
 * D17 is "state transitions only" — raw metric crossings are NOT mirrored
 * into audit_log. The Alertmanager webhook fires a single FIRED event the
 * first time an alert transitions, then RE_FIRED on subsequent re-opens
 * after RESOLVED; that maps to exactly one audit row per state edge.
 */
function emitIncidentAuditEvent(input: IncidentAuditBridgeInput): void {
	const mapping = INCIDENT_AUDIT_MAP[input.eventType];
	const resourceType = input.errorRateIncidentId
		? "error_rate_incident"
		: "integration_incident";
	const resourceId =
		input.errorRateIncidentId ?? input.integrationIncidentId ?? null;

	const actor = input.actorUserId
		? // Email/name will be populated by the API layer when this is called
			// from a request context. For Alertmanager webhook + Temporal poller
			// paths the actor is system, never a user.
			{ type: "user" as const, userId: input.actorUserId }
		: { type: "system" as const };

	recordAudit({
		action: mapping.action,
		category: "incident",
		actor,
		severity: mapping.severity,
		outcome: mapping.action === "incident.fired" ? "failure" : "success",
		organizationId: null,
		resource: {
			type: resourceType,
			id: resourceId,
			name: input.resourceName ?? resourceId,
		},
		correlationId: getCorrelationIdFromContext() ?? null,
		metadata: {
			incidentEventId: input.incidentEventId,
			eventType: input.eventType,
			...(input.payload !== undefined && input.payload !== null
				? { payload: input.payload }
				: {}),
		},
	});
}

export type IncidentStatusFilter = "FIRING" | "ACKNOWLEDGED" | "RESOLVED";
export type IncidentSeverityFilter = "SEV1" | "SEV2" | "SEV3";

export type ListIncidentsCursor = {
	id: string;
};

export type PaginatedIncidentResult<T> = {
	items: T[];
	nextCursor: string | null;
};

// =============================================================================
// ErrorRateIncident
// =============================================================================

export type ListErrorRateIncidentsInput = {
	status?: IncidentStatusFilter;
	severity?: IncidentSeverityFilter;
	service?: string;
	feature?: string;
	/** Default 30 days. Max 365 (matches retention window). */
	sinceDays?: number;
	cursor?: string;
	/** Max 100 per page. */
	limit?: number;
};

/**
 * List `ErrorRateIncident` rows with cursor pagination. Newest first.
 *
 * Filtering: any combination of status/severity/service/feature. `sinceDays`
 * applies to `firedAt`; defaults to 30 days.
 */
export async function listErrorRateIncidents(
	input: ListErrorRateIncidentsInput,
): Promise<
	PaginatedIncidentResult<
		Awaited<ReturnType<typeof fetchOneErrorRateIncident>>
	>
> {
	const limit = Math.min(input.limit ?? 50, 100);
	const sinceDays = Math.min(Math.max(input.sinceDays ?? 30, 1), 365);
	const firedAfter = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

	const where: Prisma.ErrorRateIncidentWhereInput = {
		firedAt: { gte: firedAfter },
		...(input.status ? { status: input.status } : {}),
		...(input.severity ? { severity: input.severity } : {}),
		...(input.service ? { service: input.service } : {}),
		...(input.feature ? { feature: input.feature } : {}),
	};

	const rows = await db.errorRateIncident.findMany({
		where,
		orderBy: [{ firedAt: "desc" }, { id: "desc" }],
		take: limit + 1,
		...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
	});

	const hasMore = rows.length > limit;
	const items = hasMore ? rows.slice(0, limit) : rows;
	const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

	return { items, nextCursor };
}

async function fetchOneErrorRateIncident(id: string) {
	return db.errorRateIncident.findUnique({ where: { id } });
}

export async function getErrorRateIncidentById(id: string) {
	return db.errorRateIncident.findUnique({
		where: { id },
		include: {
			events: {
				orderBy: { createdAt: "asc" },
				include: {
					actor: { select: { id: true, name: true, image: true } },
				},
			},
			acknowledger: { select: { id: true, name: true, image: true } },
		},
	});
}

/**
 * Acknowledge an `ErrorRateIncident` in a single transaction.
 *
 * Writes an `IncidentEvent(ACKNOWLEDGED)` row and flips `status` /
 * `acknowledgedAt` / `acknowledgedBy` on the incident. If the incident is
 * already RESOLVED, the call is a no-op (returns `null`).
 */
export async function acknowledgeErrorRateIncident(args: {
	incidentId: string;
	actorUserId: string;
	note?: string;
}) {
	// We collect the new event id INSIDE the transaction so the audit bridge
	// can reference it after commit. Emitting the bridge inside `$transaction`
	// would race with rollback — D17 mandates audit rows mirror only
	// committed state transitions.
	const result = await db.$transaction(async (tx) => {
		const incident = await tx.errorRateIncident.findUnique({
			where: { id: args.incidentId },
		});
		if (!incident) {
			return { updated: null, eventId: null, name: null };
		}
		if (incident.status === "RESOLVED") {
			return {
				updated: incident,
				eventId: null,
				name: incident.alertName,
			};
		}
		const now = new Date();
		const updated = await tx.errorRateIncident.update({
			where: { id: args.incidentId },
			data: {
				status: "ACKNOWLEDGED",
				acknowledgedAt: now,
				acknowledgedBy: args.actorUserId,
			},
		});
		const event = await tx.incidentEvent.create({
			data: {
				errorRateIncidentId: args.incidentId,
				eventType: "ACKNOWLEDGED",
				message: args.note,
				actorUserId: args.actorUserId,
			},
		});
		return { updated, eventId: event.id, name: updated.alertName };
	});

	if (result.eventId) {
		emitIncidentAuditEvent({
			eventType: "ACKNOWLEDGED",
			errorRateIncidentId: args.incidentId,
			incidentEventId: result.eventId,
			actorUserId: args.actorUserId,
			payload: args.note ? { message: args.note } : null,
			resourceName: result.name,
		});
	}
	return result.updated;
}

/**
 * Manually resolve an `ErrorRateIncident`.
 *
 * Writes an `IncidentEvent(MANUAL_RESOLVED)` and flips `status` / `resolvedAt`.
 * If the incident is already RESOLVED, the call is a no-op (whichever path
 * wrote first wins; signal-from-workflow + manual API call are kept in sync).
 */
export async function resolveErrorRateIncident(args: {
	incidentId: string;
	actorUserId: string;
	note?: string;
}) {
	const result = await db.$transaction(async (tx) => {
		const incident = await tx.errorRateIncident.findUnique({
			where: { id: args.incidentId },
		});
		if (!incident) {
			return { updated: null, eventId: null, name: null };
		}
		if (incident.status === "RESOLVED") {
			return {
				updated: incident,
				eventId: null,
				name: incident.alertName,
			};
		}
		const now = new Date();
		const updated = await tx.errorRateIncident.update({
			where: { id: args.incidentId },
			data: { status: "RESOLVED", resolvedAt: now },
		});
		const event = await tx.incidentEvent.create({
			data: {
				errorRateIncidentId: args.incidentId,
				eventType: "MANUAL_RESOLVED",
				message: args.note,
				actorUserId: args.actorUserId,
			},
		});
		return { updated, eventId: event.id, name: updated.alertName };
	});

	if (result.eventId) {
		emitIncidentAuditEvent({
			eventType: "MANUAL_RESOLVED",
			errorRateIncidentId: args.incidentId,
			incidentEventId: result.eventId,
			actorUserId: args.actorUserId,
			payload: args.note ? { message: args.note } : null,
			resourceName: result.name,
		});
	}
	return result.updated;
}

/**
 * Add a free-text comment to an `ErrorRateIncident`. Always permitted,
 * including after RESOLVED (post-mortem notes).
 */
export async function addErrorRateIncidentComment(args: {
	incidentId: string;
	actorUserId: string;
	message: string;
}) {
	const event = await db.incidentEvent.create({
		data: {
			errorRateIncidentId: args.incidentId,
			eventType: "COMMENT",
			message: args.message,
			actorUserId: args.actorUserId,
		},
	});
	emitIncidentAuditEvent({
		eventType: "COMMENT",
		errorRateIncidentId: args.incidentId,
		incidentEventId: event.id,
		actorUserId: args.actorUserId,
		payload: { message: args.message },
	});
	return event;
}

/**
 * List the event timeline for a single `ErrorRateIncident`.
 *
 * Ordered ascending by `createdAt` so the UI can render top-to-bottom in
 * chronological order. Returns the actor user (id/name/image) joined in.
 */
export async function listErrorRateIncidentEvents(incidentId: string) {
	return db.incidentEvent.findMany({
		where: { errorRateIncidentId: incidentId },
		orderBy: { createdAt: "asc" },
		include: {
			actor: { select: { id: true, name: true, image: true } },
		},
	});
}

// =============================================================================
// IntegrationIncident
// =============================================================================

export type ListIntegrationIncidentsInput = {
	providerKey?: string;
	status?: IncidentStatusFilter;
	severity?: IncidentSeverityFilter;
	/** Default 30 days. Max 365. */
	sinceDays?: number;
	cursor?: string;
	limit?: number;
};

export async function listIntegrationIncidents(
	input: ListIntegrationIncidentsInput,
) {
	const limit = Math.min(input.limit ?? 50, 100);
	const sinceDays = Math.min(Math.max(input.sinceDays ?? 30, 1), 365);
	const startedAfter = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

	const where: Prisma.IntegrationIncidentWhereInput = {
		startedAt: { gte: startedAfter },
		...(input.providerKey ? { providerKey: input.providerKey } : {}),
		...(input.status ? { status: input.status } : {}),
		...(input.severity ? { severity: input.severity } : {}),
	};

	const rows = await db.integrationIncident.findMany({
		where,
		orderBy: [{ startedAt: "desc" }, { id: "desc" }],
		take: limit + 1,
		...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
	});

	const hasMore = rows.length > limit;
	const items = hasMore ? rows.slice(0, limit) : rows;
	const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

	return { items, nextCursor };
}

export async function getIntegrationIncidentById(id: string) {
	return db.integrationIncident.findUnique({
		where: { id },
		include: {
			events: {
				orderBy: { createdAt: "asc" },
				include: {
					actor: { select: { id: true, name: true, image: true } },
				},
			},
			acknowledger: { select: { id: true, name: true, image: true } },
		},
	});
}

export async function acknowledgeIntegrationIncident(args: {
	incidentId: string;
	actorUserId: string;
	note?: string;
}) {
	const result = await db.$transaction(async (tx) => {
		const incident = await tx.integrationIncident.findUnique({
			where: { id: args.incidentId },
		});
		if (!incident) {
			return { updated: null, eventId: null, name: null };
		}
		if (incident.status === "RESOLVED") {
			return {
				updated: incident,
				eventId: null,
				name: incident.providerName,
			};
		}
		const now = new Date();
		const updated = await tx.integrationIncident.update({
			where: { id: args.incidentId },
			data: {
				status: "ACKNOWLEDGED",
				acknowledgedAt: now,
				acknowledgedBy: args.actorUserId,
			},
		});
		const event = await tx.incidentEvent.create({
			data: {
				integrationIncidentId: args.incidentId,
				eventType: "ACKNOWLEDGED",
				message: args.note,
				actorUserId: args.actorUserId,
			},
		});
		return { updated, eventId: event.id, name: updated.providerName };
	});

	if (result.eventId) {
		emitIncidentAuditEvent({
			eventType: "ACKNOWLEDGED",
			integrationIncidentId: args.incidentId,
			incidentEventId: result.eventId,
			actorUserId: args.actorUserId,
			payload: args.note ? { message: args.note } : null,
			resourceName: result.name,
		});
	}
	return result.updated;
}

export async function resolveIntegrationIncident(args: {
	incidentId: string;
	actorUserId: string;
	note?: string;
}) {
	const result = await db.$transaction(async (tx) => {
		const incident = await tx.integrationIncident.findUnique({
			where: { id: args.incidentId },
		});
		if (!incident) {
			return { updated: null, eventId: null, name: null };
		}
		if (incident.status === "RESOLVED") {
			return {
				updated: incident,
				eventId: null,
				name: incident.providerName,
			};
		}
		const now = new Date();
		const updated = await tx.integrationIncident.update({
			where: { id: args.incidentId },
			data: { status: "RESOLVED", resolvedAt: now },
		});
		const event = await tx.incidentEvent.create({
			data: {
				integrationIncidentId: args.incidentId,
				eventType: "MANUAL_RESOLVED",
				message: args.note,
				actorUserId: args.actorUserId,
			},
		});
		return { updated, eventId: event.id, name: updated.providerName };
	});

	if (result.eventId) {
		emitIncidentAuditEvent({
			eventType: "MANUAL_RESOLVED",
			integrationIncidentId: args.incidentId,
			incidentEventId: result.eventId,
			actorUserId: args.actorUserId,
			payload: args.note ? { message: args.note } : null,
			resourceName: result.name,
		});
	}
	return result.updated;
}

export async function addIntegrationIncidentComment(args: {
	incidentId: string;
	actorUserId: string;
	message: string;
}) {
	const event = await db.incidentEvent.create({
		data: {
			integrationIncidentId: args.incidentId,
			eventType: "COMMENT",
			message: args.message,
			actorUserId: args.actorUserId,
		},
	});
	emitIncidentAuditEvent({
		eventType: "COMMENT",
		integrationIncidentId: args.incidentId,
		incidentEventId: event.id,
		actorUserId: args.actorUserId,
		payload: { message: args.message },
	});
	return event;
}

export async function listIntegrationIncidentEvents(incidentId: string) {
	return db.incidentEvent.findMany({
		where: { integrationIncidentId: incidentId },
		orderBy: { createdAt: "asc" },
		include: {
			actor: { select: { id: true, name: true, image: true } },
		},
	});
}

// =============================================================================
// IntegrationProviderRegistry
// =============================================================================

/**
 * Bulk fetch every registered provider's current health. Used by the
 * Settings → Integrations page. Joins
 * the most-recent active incident if any so the UI can render the tooltip
 * without a second round-trip.
 *
 * Performance: ordered first by health (worst first, so DEGRADED/OUTAGE
 * surface at the top) then alphabetically. The `IntegrationProviderRegistry`
 * table holds at most ~30 rows (DataConnectionProvider enum + MVP-5 platform
 * providers), so this is a single index scan.
 */
export async function listProviderHealth(input: { providerKeys?: string[] }) {
	const where: Prisma.IntegrationProviderRegistryWhereInput = input
		.providerKeys?.length
		? { providerKey: { in: input.providerKeys } }
		: {};

	const rows = await db.integrationProviderRegistry.findMany({
		where,
		orderBy: [{ currentHealth: "desc" }, { displayName: "asc" }],
	});

	// One query for all open incidents across the providers — cheaper than N
	// per-row queries even with the orderBy. We cap at the FIRING/ACKNOWLEDGED
	// set since the UI only needs the currently active incident.
	const providerKeys = rows.map((r) => r.providerKey);
	const activeIncidents = providerKeys.length
		? await db.integrationIncident.findMany({
				where: {
					providerKey: { in: providerKeys },
					status: { in: ["FIRING", "ACKNOWLEDGED"] },
				},
				orderBy: { startedAt: "desc" },
			})
		: [];

	// Index by providerKey, taking the most recent active incident per provider.
	const incidentByProvider = new Map<
		string,
		(typeof activeIncidents)[number]
	>();
	for (const incident of activeIncidents) {
		if (!incidentByProvider.has(incident.providerKey)) {
			incidentByProvider.set(incident.providerKey, incident);
		}
	}

	return rows.map((row) => ({
		...row,
		activeIncident: incidentByProvider.get(row.providerKey) ?? null,
	}));
}

/**
 * Fetch a single provider's current health row. Used by the per-provider
 * drawer.
 */
export async function getProviderHealth(providerKey: string) {
	const row = await db.integrationProviderRegistry.findUnique({
		where: { providerKey },
	});
	if (!row) {
		return null;
	}
	const activeIncident = await db.integrationIncident.findFirst({
		where: {
			providerKey,
			status: { in: ["FIRING", "ACKNOWLEDGED"] },
		},
		orderBy: { startedAt: "desc" },
	});
	return { ...row, activeIncident };
}

/**
 * List integration incidents for a single provider over a sliding window.
 * Used by the per-provider timeline drawer.
 */
export async function listProviderIncidentsForTimeline(args: {
	providerKey: string;
	windowDays?: number;
}) {
	const windowDays = Math.min(Math.max(args.windowDays ?? 30, 1), 365);
	const after = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

	return db.integrationIncident.findMany({
		where: {
			providerKey: args.providerKey,
			startedAt: { gte: after },
		},
		orderBy: { startedAt: "desc" },
		include: {
			events: {
				orderBy: { createdAt: "asc" },
				select: {
					id: true,
					eventType: true,
					message: true,
					createdAt: true,
					actorUserId: true,
				},
			},
		},
	});
}

// =============================================================================
// Active incidents (banner)
// =============================================================================

/**
 * Active SEV-1 / SEV-2 incidents across BOTH error-rate and integration
 * streams. Drives the app-shell banner.
 *
 * Capped to 10 per stream — the UI only needs the most recent for the
 * banner; the admin dashboard handles the long tail.
 */
export async function listActiveSevHighIncidents() {
	const [errorRate, integration, component] = await Promise.all([
		db.errorRateIncident.findMany({
			where: {
				status: { in: ["FIRING", "ACKNOWLEDGED"] },
				severity: { in: ["SEV1", "SEV2"] },
			},
			orderBy: { firedAt: "desc" },
			take: 10,
		}),
		db.integrationIncident.findMany({
			where: {
				status: { in: ["FIRING", "ACKNOWLEDGED"] },
				severity: { in: ["SEV1", "SEV2"] },
				// Defensive: NOT_CONFIGURED rows should never reach
				// FIRING (the synthetic-probe workflow short-circuits
				// before creating an incident), but if one slipped in
				// historically we don't want it lighting up the app-
				// shell banner. Filter at the query layer so the rest
				// of the UI doesn't have to special-case it.
				health: {
					notIn: ["NOT_CONFIGURED"],
				},
			},
			orderBy: { startedAt: "desc" },
			take: 10,
		}),
		// v3 admin-incidents pass: Fabric subsystem outages (Temporal
		// worker stalled, Prisma drift, RAG indexer queue backed up,
		// agent rail down). Wired into the same active-incidents
		// stream so the chip + admin dashboard surface them with the
		// other two kinds.
		db.componentIncident.findMany({
			where: {
				status: { in: ["FIRING", "ACKNOWLEDGED"] },
				severity: { in: ["SEV1", "SEV2"] },
			},
			orderBy: { firedAt: "desc" },
			take: 10,
		}),
	]);
	return { errorRate, integration, component };
}

// =============================================================================
// Incident history (admin monitoring timeline)
// =============================================================================

/** Source facet for the history timeline. "all" selects every stream; the
 * `statuspage`/`synthetic`/`breaker`/`alertmanager` values narrow the
 * integration stream by `detectionMethod`. */
export type IncidentHistorySource =
	| "all"
	| "error-rate"
	| "statuspage"
	| "synthetic"
	| "breaker"
	| "alertmanager"
	| "component";

/** Lifecycle facet for the history timeline. "active" = FIRING/ACKNOWLEDGED;
 * "hidden" = RESOLVED; "all" = no status filter. */
export type IncidentHistoryStatus = "all" | "active" | "hidden";

/** Allowed page sizes. The procedure gate restricts the wire value to this
 * set; the helper clamps any out-of-set value to the nearest legal page. */
export type IncidentHistoryPageSize = 25 | 50 | 100;

const PAGE_SIZES: readonly IncidentHistoryPageSize[] = [25, 50, 100] as const;

/**
 * Map the UI's integration `source` facet to the schema's
 * `IncidentDetectionMethod` enum value. Kept as a string literal (not a
 * value import of the enum) so test files that `vi.mock("@repo/database")`
 * don't have to provide the enum runtime.
 */
const DETECTION_METHOD_BY_SOURCE: Record<
	"statuspage" | "synthetic" | "breaker" | "alertmanager",
	"STATUSPAGE_POLL" | "SYNTHETIC_PROBE" | "BREAKER_OPEN" | "ALERT_MANAGER"
> = {
	statuspage: "STATUSPAGE_POLL",
	synthetic: "SYNTHETIC_PROBE",
	breaker: "BREAKER_OPEN",
	alertmanager: "ALERT_MANAGER",
};

export type ListIncidentHistoryInput = {
	/** Sliding window applied to firedAt/startedAt. Clamped to 1..365. */
	sinceDays?: number;
	/** Lifecycle facet. Default "all". */
	status?: IncidentHistoryStatus;
	/** Source facet. Default "all". */
	source?: IncidentHistorySource;
	/** 1-based page number. Clamped to >= 1. */
	page?: number;
	/** Rows per page. One of 25/50/100; clamped to the nearest legal size. */
	pageSize?: IncidentHistoryPageSize;
};

/** One normalized timeline row. The `kind` discriminator tells the UI which
 * stream it came from; the remaining fields are the minimal set the timeline
 * renders (label/summary + lifecycle + the stream's start/resolve times). */
export type IncidentHistoryItem = {
	id: string;
	kind: "errorRate" | "integration" | "component";
	severity: "SEV1" | "SEV2" | "SEV3";
	status: "FIRING" | "ACKNOWLEDGED" | "RESOLVED";
	/** ISO start time (errorRate/component firedAt, integration startedAt). */
	startedAt: string;
	/** ISO resolve time, or null while still active. */
	resolvedAt: string | null;
	// --- stream-specific label/summary source fields (only the relevant
	// stream's are populated) ---
	alertName?: string;
	service?: string;
	feature?: string;
	errorClass?: string | null;
	providerName?: string;
	summary?: string | null;
	detectionMethod?: string | null;
	componentName?: string;
};

export type ListIncidentHistoryResult = {
	items: IncidentHistoryItem[];
	total: number;
};

/** Translate the status facet into the set of `IncidentStatus` values the
 * stream queries should match. Returns `undefined` for "all" (no filter). */
function statusInFor(
	status: IncidentHistoryStatus,
): ("FIRING" | "ACKNOWLEDGED" | "RESOLVED")[] | undefined {
	if (status === "active") {
		return ["FIRING", "ACKNOWLEDGED"];
	}
	if (status === "hidden") {
		return ["RESOLVED"];
	}
	return undefined;
}

/**
 * Full incident history across the three streams — every status (incl.
 * RESOLVED) and every severity (incl. SEV-3) by default, windowed over the
 * last `sinceDays` days, with SERVER-SIDE status + source filtering and
 * pagination. Drives the admin monitoring dashboard's "Incident history"
 * timeline.
 *
 * Distinct from {@link listActiveSevHighIncidents} (which feeds the app-shell
 * banner and is intentionally narrowed to active SEV-1/2): the timeline must
 * show resolved + low-severity incidents so SREs can scan what *happened*,
 * not just what's on fire right now.
 *
 * Pagination strategy ("take page*pageSize per stream, merge, slice"): for
 * each RELEVANT stream we fetch the first `page * pageSize` rows ordered by
 * that stream's time column DESC, merge the streams into one array, sort by
 * start time DESC, then slice the requested page. `total` is the summed
 * per-stream `count()`. This over-fetches at most `page * pageSize` per
 * stream (≤ 3 × pageSize on page 1) — acceptable for the low incident volume
 * this table sees; it keeps the merge correct without a cross-stream cursor.
 * For a single-stream source (`error-rate`/`component`/`statuspage`/…) only
 * that one stream is queried, so there is no over-fetch at all.
 *
 * `Date.now()` is fine here — this is an API-side read, not a Temporal
 * workflow (where wall-clock reads break determinism).
 *
 * NOT_CONFIGURED integration rows (synthetic probe disabled because an env
 * var is missing) are filtered out: they represent "we can't probe" rather
 * than a real provider incident and would otherwise clutter the history.
 */
export async function listIncidentHistory(
	input: ListIncidentHistoryInput,
): Promise<ListIncidentHistoryResult> {
	const sinceDays = Math.min(Math.max(input.sinceDays ?? 30, 1), 365);
	const page = Math.max(Math.floor(input.page ?? 1), 1);
	const pageSize = PAGE_SIZES.includes(
		input.pageSize as IncidentHistoryPageSize,
	)
		? (input.pageSize as IncidentHistoryPageSize)
		: 25;
	const source: IncidentHistorySource = input.source ?? "all";
	const status: IncidentHistoryStatus = input.status ?? "all";
	const after = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

	const statusIn = statusInFor(status);
	// Fetch enough from each relevant stream to cover the requested page after
	// the cross-stream merge.
	const take = page * pageSize;

	const wantErrorRate = source === "all" || source === "error-rate";
	const wantComponent = source === "all" || source === "component";
	const wantIntegration =
		source === "all" ||
		source === "statuspage" ||
		source === "synthetic" ||
		source === "breaker" ||
		source === "alertmanager";

	const errorRateWhere: Prisma.ErrorRateIncidentWhereInput = {
		firedAt: { gte: after },
		...(statusIn ? { status: { in: statusIn } } : {}),
	};
	const componentWhere: Prisma.ComponentIncidentWhereInput = {
		firedAt: { gte: after },
		...(statusIn ? { status: { in: statusIn } } : {}),
	};
	const integrationWhere: Prisma.IntegrationIncidentWhereInput = {
		startedAt: { gte: after },
		health: { notIn: ["NOT_CONFIGURED"] },
		...(statusIn ? { status: { in: statusIn } } : {}),
		...(source === "statuspage" ||
		source === "synthetic" ||
		source === "breaker" ||
		source === "alertmanager"
			? { detectionMethod: DETECTION_METHOD_BY_SOURCE[source] }
			: {}),
	};

	const [errorRateRows, integrationRows, componentRows] = await Promise.all([
		wantErrorRate
			? db.errorRateIncident.findMany({
					where: errorRateWhere,
					orderBy: { firedAt: "desc" },
					take,
				})
			: Promise.resolve([]),
		wantIntegration
			? db.integrationIncident.findMany({
					where: integrationWhere,
					orderBy: { startedAt: "desc" },
					take,
				})
			: Promise.resolve([]),
		wantComponent
			? db.componentIncident.findMany({
					where: componentWhere,
					orderBy: { firedAt: "desc" },
					take,
				})
			: Promise.resolve([]),
	]);

	const [errorRateTotal, integrationTotal, componentTotal] =
		await Promise.all([
			wantErrorRate
				? db.errorRateIncident.count({ where: errorRateWhere })
				: Promise.resolve(0),
			wantIntegration
				? db.integrationIncident.count({ where: integrationWhere })
				: Promise.resolve(0),
			wantComponent
				? db.componentIncident.count({ where: componentWhere })
				: Promise.resolve(0),
		]);

	const merged: IncidentHistoryItem[] = [];
	for (const row of errorRateRows) {
		merged.push({
			id: row.id,
			kind: "errorRate",
			severity: row.severity as IncidentHistoryItem["severity"],
			status: row.status as IncidentHistoryItem["status"],
			startedAt: row.firedAt.toISOString(),
			resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
			alertName: row.alertName,
			service: row.service,
			feature: row.feature,
			errorClass: row.errorClass,
		});
	}
	for (const row of integrationRows) {
		merged.push({
			id: row.id,
			kind: "integration",
			severity: row.severity as IncidentHistoryItem["severity"],
			status: row.status as IncidentHistoryItem["status"],
			startedAt: row.startedAt.toISOString(),
			resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
			providerName: row.providerName,
			summary: row.summary,
			detectionMethod: row.detectionMethod,
		});
	}
	for (const row of componentRows) {
		merged.push({
			id: row.id,
			kind: "component",
			severity: row.severity as IncidentHistoryItem["severity"],
			status: row.status as IncidentHistoryItem["status"],
			startedAt: row.firedAt.toISOString(),
			resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
			componentName: row.componentName,
			summary: row.summary,
		});
	}

	// Newest-first across all streams, then slice the requested page.
	merged.sort(
		(a, b) =>
			new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
	);
	const start = (page - 1) * pageSize;
	const items = merged.slice(start, start + pageSize);
	const total = errorRateTotal + integrationTotal + componentTotal;

	return { items, total };
}

/**
 * List the event timeline for a single `ComponentIncident`.
 *
 * Mirrors {@link listErrorRateIncidentEvents} /
 * {@link listIntegrationIncidentEvents}: ascending by `createdAt` so the UI
 * renders top-to-bottom chronologically, with the actor (id/name/image)
 * joined in for the expand drill-down.
 */
export async function listComponentIncidentEvents(componentIncidentId: string) {
	return db.incidentEvent.findMany({
		where: { componentIncidentId },
		orderBy: { createdAt: "asc" },
		include: {
			actor: { select: { id: true, name: true, image: true } },
		},
	});
}

// =============================================================================
// Alertmanager webhook helpers
// =============================================================================

export type AlertmanagerUpsertInput = {
	fingerprint: string;
	alertName: string;
	severity: IncidentSeverityFilter;
	startsAt: Date;
	endsAt: Date | null;
	/** Lowercase alert labels (Alertmanager wire format). */
	labels: Record<string, string>;
	annotations: Record<string, string>;
};

export type AlertmanagerUpsertResult = {
	kind: "errorRate" | "integration";
	incidentId: string;
	created: boolean;
};

/**
 * Upsert an Alertmanager-driven incident row keyed by `fingerprint`.
 *
 * Maps alert labels to either an `ErrorRateIncident` or an `IntegrationIncident`
 * row based on `labels.alertname_family`:
 *   - "provider_outage" → IntegrationIncident
 *   - everything else   → ErrorRateIncident
 *
 * Returns the kind + incident ID so the caller can start the lifecycle
 * workflow with workflow ID `incident-{incidentId}`.
 */
export async function upsertAlertmanagerIncident(
	input: AlertmanagerUpsertInput,
): Promise<AlertmanagerUpsertResult> {
	const family = input.labels.alertname_family ?? "error_rate";
	const isIntegration = family === "provider_outage";

	if (isIntegration) {
		const providerKey = input.labels.provider ?? "unknown";
		const providerName = input.annotations.provider_name ?? providerKey;
		const existing = await db.integrationIncident.findUnique({
			where: { alertmanagerFingerprint: input.fingerprint },
		});
		if (existing) {
			// Reopen if previously resolved; otherwise no-op.
			if (existing.status === "RESOLVED") {
				const reopened = await db.integrationIncident.update({
					where: { id: existing.id },
					data: { status: "FIRING", resolvedAt: null },
				});
				const event = await db.incidentEvent.create({
					data: {
						integrationIncidentId: existing.id,
						eventType: "RE_FIRED",
						message: input.annotations.summary,
					},
				});
				emitIncidentAuditEvent({
					eventType: "RE_FIRED",
					integrationIncidentId: existing.id,
					incidentEventId: event.id,
					payload: {
						summary: input.annotations.summary,
						severity: input.severity,
					},
					resourceName: existing.providerName,
				});
				return {
					kind: "integration",
					incidentId: reopened.id,
					created: false,
				};
			}
			return {
				kind: "integration",
				incidentId: existing.id,
				created: false,
			};
		}
		const created = await db.integrationIncident.create({
			data: {
				providerKey,
				providerName,
				severity: input.severity,
				health: "MAJOR_OUTAGE",
				detectionMethod: "ALERT_MANAGER",
				summary: input.annotations.summary,
				alertmanagerFingerprint: input.fingerprint,
				startedAt: input.startsAt,
			},
		});
		const event = await db.incidentEvent.create({
			data: {
				integrationIncidentId: created.id,
				eventType: "FIRED",
				message: input.annotations.summary,
			},
		});
		emitIncidentAuditEvent({
			eventType: "FIRED",
			integrationIncidentId: created.id,
			incidentEventId: event.id,
			payload: {
				summary: input.annotations.summary,
				severity: input.severity,
				providerKey,
			},
			resourceName: providerName,
		});
		return { kind: "integration", incidentId: created.id, created: true };
	}

	// Error-rate path
	const existing = await db.errorRateIncident.findUnique({
		where: { alertmanagerFingerprint: input.fingerprint },
	});
	if (existing) {
		if (existing.status === "RESOLVED") {
			const reopened = await db.errorRateIncident.update({
				where: { id: existing.id },
				data: { status: "FIRING", resolvedAt: null },
			});
			const event = await db.incidentEvent.create({
				data: {
					errorRateIncidentId: existing.id,
					eventType: "RE_FIRED",
					message: input.annotations.summary,
				},
			});
			emitIncidentAuditEvent({
				eventType: "RE_FIRED",
				errorRateIncidentId: existing.id,
				incidentEventId: event.id,
				payload: {
					summary: input.annotations.summary,
					severity: input.severity,
				},
				resourceName: existing.alertName,
			});
			return {
				kind: "errorRate",
				incidentId: reopened.id,
				created: false,
			};
		}
		return { kind: "errorRate", incidentId: existing.id, created: false };
	}
	const errorCount =
		Number.parseInt(input.labels.error_count ?? "0", 10) || 0;
	const created = await db.errorRateIncident.create({
		data: {
			alertName: input.labels.alertname ?? input.alertName,
			severity: input.severity,
			service: input.labels.service ?? "unknown",
			feature: input.labels.feature ?? "unknown",
			errorClass: input.labels.error_class ?? null,
			errorCount,
			burnRate1h:
				Number.parseFloat(input.labels.burn_rate_1h ?? "") || null,
			burnRate5m:
				Number.parseFloat(input.labels.burn_rate_5m ?? "") || null,
			alertmanagerFingerprint: input.fingerprint,
			firedAt: input.startsAt,
		},
	});
	const event = await db.incidentEvent.create({
		data: {
			errorRateIncidentId: created.id,
			eventType: "FIRED",
			message: input.annotations.summary,
		},
	});
	emitIncidentAuditEvent({
		eventType: "FIRED",
		errorRateIncidentId: created.id,
		incidentEventId: event.id,
		payload: {
			summary: input.annotations.summary,
			severity: input.severity,
			service: input.labels.service,
			feature: input.labels.feature,
		},
		resourceName: created.alertName,
	});
	return { kind: "errorRate", incidentId: created.id, created: true };
}

/**
 * Mark an Alertmanager-driven incident as auto-resolved, keyed by fingerprint.
 *
 * Idempotent: if no row exists for the fingerprint, returns null. If already
 * resolved, returns the row unchanged.
 */
export async function autoResolveAlertmanagerIncident(args: {
	fingerprint: string;
	endsAt: Date;
}): Promise<AlertmanagerUpsertResult | null> {
	// Try error_rate first; fall back to integration.
	const errorRate = await db.errorRateIncident.findUnique({
		where: { alertmanagerFingerprint: args.fingerprint },
	});
	if (errorRate) {
		if (errorRate.status === "RESOLVED") {
			return {
				kind: "errorRate",
				incidentId: errorRate.id,
				created: false,
			};
		}
		const updated = await db.errorRateIncident.update({
			where: { id: errorRate.id },
			data: { status: "RESOLVED", resolvedAt: args.endsAt },
		});
		const event = await db.incidentEvent.create({
			data: {
				errorRateIncidentId: errorRate.id,
				eventType: "AUTO_RESOLVED",
			},
		});
		emitIncidentAuditEvent({
			eventType: "AUTO_RESOLVED",
			errorRateIncidentId: errorRate.id,
			incidentEventId: event.id,
			payload: { resolvedAt: args.endsAt.toISOString() },
			resourceName: errorRate.alertName,
		});
		return { kind: "errorRate", incidentId: updated.id, created: false };
	}
	const integration = await db.integrationIncident.findUnique({
		where: { alertmanagerFingerprint: args.fingerprint },
	});
	if (integration) {
		if (integration.status === "RESOLVED") {
			return {
				kind: "integration",
				incidentId: integration.id,
				created: false,
			};
		}
		const updated = await db.integrationIncident.update({
			where: { id: integration.id },
			data: { status: "RESOLVED", resolvedAt: args.endsAt },
		});
		const event = await db.incidentEvent.create({
			data: {
				integrationIncidentId: integration.id,
				eventType: "AUTO_RESOLVED",
			},
		});
		emitIncidentAuditEvent({
			eventType: "AUTO_RESOLVED",
			integrationIncidentId: integration.id,
			incidentEventId: event.id,
			payload: { resolvedAt: args.endsAt.toISOString() },
			resourceName: integration.providerName,
		});
		return { kind: "integration", incidentId: updated.id, created: false };
	}
	return null;
}
