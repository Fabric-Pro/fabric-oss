/**
 * notifyIncident activity — inert no-op.
 *
 * In-app incident notifications have been removed. Incidents are no longer
 * written to any user's notification inbox; the durable record lives in the
 * admin monitoring "Incident history" timeline instead (active + resolved,
 * across every detection stream). Outbound Teams / Slack / email delivery is
 * unchanged — it flows via Alertmanager posting directly to the Power Automate
 * flow at ${ALERTS_WEBHOOK_URL}, never through this activity.
 *
 * The activity is kept (rather than deleted) so the incident-lifecycle workflow
 * keeps calling it at the same points in its event history — preserving replay
 * determinism for in-flight incident workflows. It now returns a `skipped`
 * result without touching the database. Once all pre-change histories drain,
 * the workflow's two `notifyIncident` calls can be removed in a cleanup pass.
 */
import type { IncidentSource } from "@repo/database/prisma/queries/incident-notifications";
import type { IncidentSeverity } from "./shared-types";

export interface NotifyIncidentInput {
	source: IncidentSource;
	incidentId: string;
	severity: IncidentSeverity;
	/** Provider key for integration incidents. */
	providerKey?: string;
	/** Free-text title (e.g., "SEV-1: api/ai_generation error budget burn"). */
	title: string;
	/** Human-readable summary. */
	summary: string;
	/** Link target. */
	link: string;
	/** ISO 8601 string — the incident's startedAt / firedAt timestamp. */
	startedAtIso: string;
	/** When true, this is the recovery (incident-resolving) path. */
	isRecovery?: boolean;
}

export interface NotifyIncidentOutput {
	adminRowsWritten: number;
	perOrgRowsWritten: number;
	skipped: boolean;
	skipReason?: string;
}

export async function notifyIncident(
	_input: NotifyIncidentInput,
): Promise<NotifyIncidentOutput> {
	// No-op: in-app incident notifications were removed (incidents live in the
	// admin monitoring "Incident history" timeline now). Return a skipped result
	// without writing any Notification rows. The workflow still records this
	// activity call, so in-flight incident histories replay deterministically.
	return {
		adminRowsWritten: 0,
		perOrgRowsWritten: 0,
		skipped: true,
		skipReason: "in-app-incident-notifications-removed",
	};
}
