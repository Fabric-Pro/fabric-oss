/**
 * closeIntegrationIncident activity.
 *
 * Resolves the most recent FIRING / ACKNOWLEDGED IntegrationIncident for
 * a provider, inserts an `IncidentEvent(AUTO_RESOLVED)`, and updates the
 * IntegrationProviderRegistry row to OPERATIONAL.
 *
 * Recovery notification dispatch (admin + per-org rollup) is NOT done
 * here. The lifecycle workflow owns notification dispatch via the
 * `notifyIncident` activity. That keeps the upsert / close primitive
 * narrow and idempotent — multiple poll passes that all observe the
 * "back to operational" state can call this safely; only the first one
 * does any work, the rest no-op.
 */
import { db, recordAudit } from "@repo/database";
import { activityInfo } from "@temporalio/activity";

/** Pull workflow runId for correlation. `null` outside an activity. */
function readWorkflowRunId(): string | null {
	try {
		return activityInfo().workflowExecution.runId;
	} catch {
		return null;
	}
}

export interface CloseIntegrationIncidentInput {
	providerKey: string;
	/**
	 * Why the incident was closed:
	 *   - STATUSPAGE_RESOLVED   — Statuspage component returned to operational.
	 *   - PROBE_SUCCESS         — 3 consecutive synthetic probe successes (L14).
	 *   - BREAKER_RESET         — Cockatiel breaker closed.
	 *   - MANUAL                — Admin clicked Resolve.
	 *   - WEBHOOK_RESOLVED      — Alertmanager fired a resolve.
	 *   - NOT_CONFIGURED        — Probe transitioned to NOT_CONFIGURED
	 *                             (e.g., the credential env var was unset).
	 *                             The incident the probe opened is no longer
	 *                             meaningful — we can no longer say the
	 *                             provider is down because we cannot probe
	 *                             it at all. Closes the row and writes
	 *                             `IncidentEvent(AUTO_RESOLVED)` with
	 *                             `payload.reason = "NOT_CONFIGURED"` so the
	 *                             audit trail makes the cause explicit.
	 */
	reason:
		| "STATUSPAGE_RESOLVED"
		| "PROBE_SUCCESS"
		| "BREAKER_RESET"
		| "MANUAL"
		| "WEBHOOK_RESOLVED"
		| "NOT_CONFIGURED";
	/** Free-form note attached to the AUTO_RESOLVED event (optional). */
	note?: string;
}

export interface CloseIntegrationIncidentOutput {
	/** ID of the incident we resolved. Null when there was nothing to close. */
	incidentId: string | null;
	/** True if a row state changed (i.e., we actually resolved a live incident). */
	resolved: boolean;
}

export async function closeIntegrationIncident(
	input: CloseIntegrationIncidentInput,
): Promise<CloseIntegrationIncidentOutput> {
	const active = await db.integrationIncident.findFirst({
		where: {
			providerKey: input.providerKey,
			status: { in: ["FIRING", "ACKNOWLEDGED"] },
		},
		orderBy: { startedAt: "desc" },
		select: { id: true },
	});

	// For NOT_CONFIGURED closures, the registry row was already flipped to
	// NOT_CONFIGURED by `markProviderNotConfigured` before this activity
	// was invoked. We deliberately do NOT overwrite that with OPERATIONAL
	// here — the provider is unprobable, not healthy, and the gray badge
	// is the truthful state. For every other reason the close path means
	// "back to operational" and we update the registry accordingly.
	const targetHealth =
		input.reason === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "OPERATIONAL";

	if (!active) {
		// Still touch the registry row — keeps `lastPolledAt` fresh so the
		// admin UI doesn't show stale "last poll Xh ago" timestamps. Skip
		// the `currentHealth` write when the reason is NOT_CONFIGURED so
		// we don't fight `markProviderNotConfigured`'s prior write.
		await db.integrationProviderRegistry
			.update({
				where: { providerKey: input.providerKey },
				data:
					input.reason === "NOT_CONFIGURED"
						? { lastPolledAt: new Date() }
						: {
								currentHealth: "OPERATIONAL",
								lastPolledAt: new Date(),
							},
			})
			.catch(() => {
				/* registry row may not exist yet */
			});

		return { incidentId: null, resolved: false };
	}

	await db.integrationIncident.update({
		where: { id: active.id },
		data: {
			status: "RESOLVED",
			resolvedAt: new Date(),
			// For NOT_CONFIGURED the row's terminal `health` should reflect
			// the truth ("we can't see the provider") rather than claiming
			// it bounced back to OPERATIONAL.
			health: targetHealth,
		},
	});

	const event = await db.incidentEvent.create({
		data: {
			integrationIncidentId: active.id,
			eventType: "AUTO_RESOLVED",
			message: input.note ?? null,
			payload: {
				reason: input.reason,
			},
		},
	});

	// Fetch the resolved provider name so the viewer's resource cell renders
	// a friendly label rather than just the cuid. The lookup is cheap (PK
	// equality) and only fires when we actually resolved an incident.
	const closedIncident = await db.integrationIncident
		.findUnique({
			where: { id: active.id },
			select: { providerName: true },
		})
		.catch(() => null);

	// D17 bridge — see upsert-integration-incident.ts for rationale.
	recordAudit({
		action: "incident.auto_resolved",
		category: "incident",
		actor: { type: "system" },
		severity: "info",
		outcome: "success",
		organizationId: null,
		correlationId: readWorkflowRunId(),
		resource: {
			type: "integration_incident",
			id: active.id,
			name: closedIncident?.providerName ?? active.id,
		},
		metadata: {
			incidentEventId: event.id,
			eventType: "AUTO_RESOLVED",
			payload: { reason: input.reason },
		},
	});

	await db.integrationProviderRegistry
		.update({
			where: { providerKey: input.providerKey },
			data:
				input.reason === "NOT_CONFIGURED"
					? {
							lastPolledAt: new Date(),
							// `currentHealth` stays NOT_CONFIGURED (set by
							// markProviderNotConfigured). `lastIncidentId`
							// is preserved so the UI can deep-link.
						}
					: {
							currentHealth: "OPERATIONAL",
							lastPolledAt: new Date(),
							// lastIncidentId stays set so the UI can deep-link to
							// the recently-resolved incident from the provider
							// card.
						},
		})
		.catch(() => {
			/* registry row may not exist yet */
		});

	return { incidentId: active.id, resolved: true };
}
