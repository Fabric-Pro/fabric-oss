/**
 * upsertIntegrationIncident activity.
 *
 * Idempotent. If a `FIRING` or `ACKNOWLEDGED` `IntegrationIncident` already
 * exists for the same `providerKey` (and, when provided, matching
 * `statusPageIncidentId`), this is treated as a continuation — we update
 * the existing row's `health` and `severity` if they changed and emit an
 * `IncidentEvent(RE_FIRED)` event when the most recent event for that
 * incident is `AUTO_RESOLVED` within the last hour.
 *
 * If no active incident matches, a new row is inserted and an
 * `IncidentEvent(FIRED)` is recorded.
 *
 * The `IntegrationProviderRegistry` row for this provider is updated with
 * the latest `currentHealth`, `lastPolledAt`, and `lastIncidentId`.
 *
 * Returns the resolved incident id + a `wasNew` flag the workflow uses to
 * decide whether to start an `incidentLifecycleWorkflow`.
 */
import { db, recordAudit } from "@repo/database";
import { activityInfo } from "@temporalio/activity";
import type {
	IncidentDetectionMethod,
	IncidentSeverity,
	ProviderHealthStatus,
} from "./shared-types";

/**
 * Pull workflow runId for correlation. Falls back to `null` outside of an
 * activity context (unit tests).
 */
function readWorkflowRunId(): string | null {
	try {
		return activityInfo().workflowExecution.runId;
	} catch {
		return null;
	}
}

const RE_FIRE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface UpsertIntegrationIncidentInput {
	providerKey: string;
	providerName: string;
	health: ProviderHealthStatus;
	severity: IncidentSeverity;
	detectionMethod: IncidentDetectionMethod;
	statusPageUrl?: string | null;
	/**
	 * Provider-side incident id (e.g., from `summary.json#incidents[0].id`).
	 * When provided, the column has a unique constraint — a re-poll of the
	 * same incident hits the unique key and updates instead of duplicating.
	 */
	statusPageIncidentId?: string | null;
	affectedComponents?: string[];
	summary?: string | null;
}

export interface UpsertIntegrationIncidentOutput {
	incidentId: string;
	/** True when a brand-new incident row was inserted. */
	wasNew: boolean;
	/** True when an AUTO_RESOLVED→FIRED transition was recorded as RE_FIRED. */
	reFired: boolean;
}

interface IncidentMatch {
	incident: Awaited<
		ReturnType<typeof db.integrationIncident.findFirst>
	> extends infer T
		? NonNullable<T>
		: never;
	/** The row is RESOLVED and the provider is reporting it again. */
	reopen: boolean;
}

/**
 * Resolve the incident row this poll belongs to.
 *
 * `statusPageIncidentId` is unique, so a row already holding this provider's
 * incident id is the ONLY row that may ever carry it. It is returned whatever
 * its status: a RESOLVED match means the provider is reporting the same
 * incident again, and the caller reopens it.
 *
 * Returning it only while it was still active is what produced roughly 3,300
 * `P2002` unique-constraint failures a week in production. A resolved match
 * fell through to the provider-wide lookup, which found nothing active, so the
 * insert below ran with an id the resolved row already owned — and failed, on
 * every poll, for as long as the provider kept reporting it.
 */
async function findIncidentToReuse(
	input: UpsertIntegrationIncidentInput,
): Promise<IncidentMatch | null> {
	if (input.statusPageIncidentId) {
		const byStatusPageId = await db.integrationIncident.findUnique({
			where: { statusPageIncidentId: input.statusPageIncidentId },
		});
		if (byStatusPageId) {
			return {
				incident: byStatusPageId,
				reopen: byStatusPageId.status === "RESOLVED",
			};
		}
	}

	const active = await db.integrationIncident.findFirst({
		where: {
			providerKey: input.providerKey,
			status: { in: ["FIRING", "ACKNOWLEDGED"] },
		},
		orderBy: { startedAt: "desc" },
	});
	return active ? { incident: active, reopen: false } : null;
}

/**
 * Detect AUTO_RESOLVED→FIRED transition within the RE_FIRE_WINDOW_MS. The
 * lookup walks the latest event for the provider's *last* resolved
 * incident: if it's AUTO_RESOLVED less than 1h ago, the new fire counts
 * as a RE_FIRED of the conceptual same outage. We persist the new
 * incident as a fresh row (so the timeline is clean) but log RE_FIRED on
 * the new row so admins see the correlation in the audit log.
 */
async function isRecentReFire(providerKey: string): Promise<boolean> {
	const lastResolved = await db.integrationIncident.findFirst({
		where: { providerKey, status: "RESOLVED" },
		orderBy: { resolvedAt: "desc" },
		select: { id: true, resolvedAt: true },
	});
	if (!lastResolved?.resolvedAt) {
		return false;
	}
	const age = Date.now() - lastResolved.resolvedAt.getTime();
	return age <= RE_FIRE_WINDOW_MS;
}

/**
 * Record the FIRED/RE_FIRED event, mirror it into the audit trail, and point
 * the provider registry at the incident. Shared by the insert path and the
 * reopen path so a reopened incident is bookkept exactly like a fresh one.
 */
async function recordIncidentFiring(
	input: UpsertIntegrationIncidentInput,
	incidentId: string,
	reFire: boolean,
): Promise<void> {
	const event = await db.incidentEvent.create({
		data: {
			integrationIncidentId: incidentId,
			eventType: reFire ? "RE_FIRED" : "FIRED",
			message: input.summary ?? null,
			payload: {
				providerKey: input.providerKey,
				health: input.health,
				severity: input.severity,
				detectionMethod: input.detectionMethod,
			},
		},
	});

	// D17: bridge into audit_log so the org-admin trail surfaces the
	// integration firing alongside user actions. System actor — this is a
	// Temporal poller path, not a user-driven mutation.
	recordAudit({
		action: reFire ? "incident.re_fired" : "incident.fired",
		category: "incident",
		actor: { type: "system" },
		severity: "error",
		outcome: "failure",
		organizationId: null,
		correlationId: readWorkflowRunId(),
		resource: {
			type: "integration_incident",
			id: incidentId,
			name: input.providerName,
		},
		metadata: {
			incidentEventId: event.id,
			eventType: reFire ? "RE_FIRED" : "FIRED",
			payload: {
				providerKey: input.providerKey,
				health: input.health,
				severity: input.severity,
				detectionMethod: input.detectionMethod,
			},
		},
	});

	await db.integrationProviderRegistry
		.update({
			where: { providerKey: input.providerKey },
			data: {
				currentHealth: input.health,
				lastPolledAt: new Date(),
				lastIncidentId: incidentId,
			},
		})
		.catch(() => {
			/* registry row may not exist yet — best-effort */
		});
}

export async function upsertIntegrationIncident(
	input: UpsertIntegrationIncidentInput,
): Promise<UpsertIntegrationIncidentOutput> {
	const match = await findIncidentToReuse(input);

	// The provider is reporting an incident whose row we already closed. The
	// id is unique, so there is no second row to create — reopen this one and
	// let it run a fresh lifecycle.
	if (match?.reopen) {
		const trimmed = input.summary?.trim();
		await db.integrationIncident.update({
			where: { id: match.incident.id },
			data: {
				status: "FIRING",
				resolvedAt: null,
				health: input.health,
				severity: input.severity,
				affectedComponents: input.affectedComponents ?? [],
				summary:
					trimmed && trimmed.length > 0
						? trimmed
						: match.incident.summary,
			},
		});

		await recordIncidentFiring(input, match.incident.id, true);

		// `wasNew` drives the lifecycle workflow, which a reopened incident
		// needs as much as a fresh one. The child is started with
		// ALLOW_DUPLICATE under a try/catch, so reusing the deterministic
		// workflow id after the previous run finished is safe.
		return {
			incidentId: match.incident.id,
			wasNew: true,
			reFired: true,
		};
	}

	if (match) {
		const existing = match.incident;
		// Continuation — update changed fields. We deliberately do NOT
		// re-insert a FIRED event; one FIRED per incident-lifetime per the
		// IncidentEvent semantics. Health-flip is logged as a COMMENT for
		// visibility but we keep it minimal in v1.
		const dataChanged =
			existing.health !== input.health ||
			existing.severity !== input.severity ||
			existing.affectedComponents.join(",") !==
				(input.affectedComponents ?? []).join(",");

		// Refresh `summary` independently of `dataChanged`: when a row
		// was opened by a buggy parser (e.g. the pre-#1021 Google
		// markdown-heading regression that wrote literal `**Summary**`
		// into the column), the health/severity/components can hold
		// steady across polls so `dataChanged` stays false and the
		// stale string never clears. Force the column to track the
		// latest parsed value on every poll — there is no audit value in
		// retaining a prior bad summary when a fresh good one is in
		// hand. This is independently safe because a null/empty incoming
		// summary preserves the existing value rather than blanking it.
		// `incomingSummary` is non-null and non-empty after trim, OR null
		// when the poll did not supply a usable summary. A whitespace-
		// only summary collapses to null so it cannot blank a previously-
		// good description.
		const trimmedInput = input.summary?.trim();
		const incomingSummary =
			trimmedInput && trimmedInput.length > 0 ? trimmedInput : null;
		const summaryChanged =
			incomingSummary !== null && incomingSummary !== existing.summary;

		if (dataChanged || summaryChanged) {
			await db.integrationIncident.update({
				where: { id: existing.id },
				data: {
					health: input.health,
					severity: input.severity,
					affectedComponents: input.affectedComponents ?? [],
					// On a summary-only change, keep the existing
					// health/severity/components — the .update is just a
					// summary refresh.
					summary: incomingSummary ?? existing.summary,
				},
			});
		}

		await db.integrationProviderRegistry
			.update({
				where: { providerKey: input.providerKey },
				data: {
					currentHealth: input.health,
					lastPolledAt: new Date(),
					lastIncidentId: existing.id,
				},
			})
			.catch(() => {
				/* registry row may not exist yet — best-effort */
			});

		return {
			incidentId: existing.id,
			wasNew: false,
			reFired: false,
		};
	}

	// New incident — record FIRED, or RE_FIRED if the previous incident
	// auto-resolved within the past hour.
	const reFire = await isRecentReFire(input.providerKey);

	const created = await db.integrationIncident.create({
		data: {
			providerKey: input.providerKey,
			providerName: input.providerName,
			status: "FIRING",
			severity: input.severity,
			health: input.health,
			detectionMethod: input.detectionMethod,
			statusPageUrl: input.statusPageUrl ?? null,
			statusPageIncidentId: input.statusPageIncidentId ?? null,
			affectedComponents: input.affectedComponents ?? [],
			summary: input.summary ?? null,
		},
		select: { id: true },
	});

	await recordIncidentFiring(input, created.id, reFire);

	return {
		incidentId: created.id,
		wasNew: true,
		reFired: reFire,
	};
}
