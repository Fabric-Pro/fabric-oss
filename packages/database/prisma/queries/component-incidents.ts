/**
 * ComponentIncident query helpers.
 *
 * Mirrors the IntegrationIncident query surface in `incidents.ts` so the
 * admin monitoring dashboard can render all three incident types
 * (errorRate / integration / component) side-by-side without rewriting the
 * read layer.
 *
 * Tenant scope: GLOBAL. A Fabric subsystem outage affects every tenant;
 * the canonical record is global. Per-org notifications are NOT emitted
 * (v3 admin-incidents pass routes incident-related rows to admins only).
 */
import { db } from "../client";

export type ListComponentIncidentsInput = {
	status?: "FIRING" | "ACKNOWLEDGED" | "RESOLVED";
	severity?: "SEV1" | "SEV2" | "SEV3";
	componentKey?: string;
	sinceDays?: number;
	cursor?: string;
	limit?: number;
};

export async function listComponentIncidents(
	input: ListComponentIncidentsInput,
) {
	const limit = Math.min(input.limit ?? 50, 100);
	const sinceDays = Math.min(Math.max(input.sinceDays ?? 30, 1), 365);
	const firedAfter = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

	const rows = await db.componentIncident.findMany({
		where: {
			firedAt: { gte: firedAfter },
			...(input.status ? { status: input.status } : {}),
			...(input.severity ? { severity: input.severity } : {}),
			...(input.componentKey ? { componentKey: input.componentKey } : {}),
		},
		orderBy: [{ firedAt: "desc" }, { id: "desc" }],
		take: limit + 1,
		...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
	});

	const hasMore = rows.length > limit;
	const items = hasMore ? rows.slice(0, limit) : rows;
	const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

	return { items, nextCursor };
}

export async function getComponentIncidentById(id: string) {
	return db.componentIncident.findUnique({
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
 * List FIRING/ACKNOWLEDGED SEV1/SEV2 component incidents — the same shape
 * the admin dashboard uses for its "Open Incidents" card list.
 */
export async function listActiveComponentIncidents() {
	return db.componentIncident.findMany({
		where: {
			status: { in: ["FIRING", "ACKNOWLEDGED"] },
			severity: { in: ["SEV1", "SEV2"] },
		},
		orderBy: [{ severity: "asc" }, { firedAt: "desc" }],
	});
}

export interface UpsertComponentIncidentInput {
	componentKey: string;
	componentName: string;
	severity: "SEV1" | "SEV2" | "SEV3";
	summary?: string | null;
	/** Alertmanager fingerprint for dedupe. */
	alertmanagerFingerprint?: string | null;
}

export interface UpsertComponentIncidentOutput {
	incidentId: string;
	wasNew: boolean;
}

/**
 * Idempotent upsert: if a FIRING/ACKNOWLEDGED ComponentIncident exists for
 * the same componentKey (and, when provided, the same Alertmanager
 * fingerprint), this is treated as a continuation.
 */
export async function upsertComponentIncident(
	input: UpsertComponentIncidentInput,
): Promise<UpsertComponentIncidentOutput> {
	// Fingerprint match first.
	if (input.alertmanagerFingerprint) {
		const byFingerprint = await db.componentIncident.findUnique({
			where: {
				alertmanagerFingerprint: input.alertmanagerFingerprint,
			},
		});
		if (byFingerprint && byFingerprint.status !== "RESOLVED") {
			return { incidentId: byFingerprint.id, wasNew: false };
		}
	}

	// Fall back to most-recent open incident for this component.
	const existing = await db.componentIncident.findFirst({
		where: {
			componentKey: input.componentKey,
			status: { in: ["FIRING", "ACKNOWLEDGED"] },
		},
		orderBy: { firedAt: "desc" },
	});
	if (existing) {
		// Update severity if the new fire is higher (severity escalation).
		if (severityRank(input.severity) < severityRank(existing.severity)) {
			await db.componentIncident.update({
				where: { id: existing.id },
				data: { severity: input.severity, summary: input.summary },
			});
		}
		return { incidentId: existing.id, wasNew: false };
	}

	const created = await db.componentIncident.create({
		data: {
			componentKey: input.componentKey,
			componentName: input.componentName,
			severity: input.severity,
			summary: input.summary ?? null,
			alertmanagerFingerprint: input.alertmanagerFingerprint ?? null,
		},
	});

	// Record FIRED event in the shared IncidentEvent ledger.
	await db.incidentEvent.create({
		data: {
			componentIncidentId: created.id,
			eventType: "FIRED",
		},
	});

	return { incidentId: created.id, wasNew: true };
}

/**
 * Mark a ComponentIncident as RESOLVED. Idempotent — already-resolved
 * incidents are no-ops.
 */
export async function closeComponentIncident(args: {
	incidentId: string;
	autoResolved?: boolean;
	actorUserId?: string;
}) {
	return db.$transaction(async (tx) => {
		const incident = await tx.componentIncident.findUnique({
			where: { id: args.incidentId },
		});
		if (!incident) {
			return null;
		}
		if (incident.status === "RESOLVED") {
			return incident;
		}

		const now = new Date();
		const updated = await tx.componentIncident.update({
			where: { id: args.incidentId },
			data: {
				status: "RESOLVED",
				resolvedAt: now,
				autoResolved: args.autoResolved ?? false,
			},
		});

		await tx.incidentEvent.create({
			data: {
				componentIncidentId: args.incidentId,
				eventType: args.autoResolved
					? "AUTO_RESOLVED"
					: "MANUAL_RESOLVED",
				actorUserId: args.actorUserId,
			},
		});

		return updated;
	});
}

function severityRank(s: string): number {
	if (s === "SEV1") {
		return 0;
	}
	if (s === "SEV2") {
		return 1;
	}
	return 2;
}
