/**
 * incidentLifecycleWorkflow.
 *
 * One workflow instance per incident. Spawned by:
 *   - `statusPagePollerWorkflow` when a new IntegrationIncident is opened.
 *   - `syntheticProbeWorkflow` when 3 consecutive probe failures open a row.
 *   - Alertmanager webhook handler when a burn-rate alert fires.
 *
 * Workflow ID is deterministic: `incident-${incidentId}`. The webhook
 * handler signals this workflow by ID on Alertmanager `resolved` events.
 *
 * Lifecycle:
 *   1. Emit the FIRED notification (admin + per-org rollup).
 *   2. Wait up to 7 days for either an `acknowledged` or `resolved`
 *      signal. On timeout, force-resolve.
 *   3. On resolve: emit the RECOVERY notification (same payload shape,
 *      `isRecovery=true`).
 *
 * Cross-system Container App `ReplicaCountZero` inhibit: resolved in
 * Alertmanager static inhibit rules (`alertmanager.yml`). No runtime
 * inhibit check needed in this workflow.
 */
import {
	condition,
	defineSignal,
	log,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type * as activities from "../../activities/monitoring";
import type {
	IncidentKind,
	IncidentSeverity,
} from "../../activities/monitoring";

const { notifyIncident } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30s",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

/**
 * Signal payload for `acknowledged`. Sent by the admin monitoring UI
 * oRPC procedure when an admin clicks "Acknowledge".
 */
export const acknowledgedSignal =
	defineSignal<[{ userId: string; note?: string }]>("acknowledged");

/**
 * Signal payload for `resolved`. Sent by:
 *   - Alertmanager webhook on `status: resolved` payload.
 *   - The admin monitoring UI manual-resolve action.
 *   - The status-page / synthetic-probe pollers when hysteresis is met
 *     and they close the incident in the DB.
 */
export const resolvedSignal =
	defineSignal<[{ userId?: string; reason: string }]>("resolved");

export interface IncidentLifecycleInput {
	kind: IncidentKind;
	incidentId: string;
	severity: IncidentSeverity;
	/** Free-text title for the notification. */
	summary: string;
	/** Link for the in-app notification. */
	link: string;
	/** ISO-8601 timestamp of when the incident fired. */
	startedAtIso: string;
	/** For integration incidents: registry key (drives per-org routing). */
	providerKey?: string;
	/** For integration incidents: display name (e.g., "OpenAI"). */
	providerName?: string;
}

const MAX_WAIT = "7d";

/**
 * Compose the FIRED notification title. Examples:
 *   - SEV-1 error rate:  "SEV-1: api/ai_generation error budget burn"
 *   - SEV-2 integration: "AI generation may be affected: OpenAI reports a partial outage"
 */
function firedTitle(input: IncidentLifecycleInput): string {
	const sevTag = input.severity.replace("SEV", "SEV-");
	if (input.kind === "integration") {
		const provider = input.providerName ?? input.providerKey ?? "provider";
		return `${sevTag}: ${provider} integration alert`;
	}
	return `${sevTag}: ${input.summary}`;
}

/**
 * Compose the RECOVERY notification title.
 */
function recoveryTitle(input: IncidentLifecycleInput): string {
	if (input.kind === "integration") {
		const provider = input.providerName ?? input.providerKey ?? "provider";
		return `Resolved: ${provider} integration recovered`;
	}
	return `Resolved: ${input.summary}`;
}

export async function incidentLifecycleWorkflow(
	input: IncidentLifecycleInput,
): Promise<void> {
	let acknowledged = false;
	let resolved = false;
	let resolveReason = "timeout";

	setHandler(acknowledgedSignal, (payload) => {
		acknowledged = true;
		log.info("Incident acknowledged", {
			incidentId: input.incidentId,
			userId: payload.userId,
		});
	});

	setHandler(resolvedSignal, (payload) => {
		resolved = true;
		resolveReason = payload.reason;
		log.info("Incident resolved", {
			incidentId: input.incidentId,
			reason: payload.reason,
		});
	});

	// 1. Emit the FIRED notification. Best-effort: a failure to write
	//    notifications must not block the lifecycle workflow.
	try {
		await notifyIncident({
			source: input.kind === "integration" ? "integration" : "errorRate",
			incidentId: input.incidentId,
			severity: input.severity,
			providerKey: input.providerKey,
			title: firedTitle(input),
			summary: input.summary,
			link: input.link,
			startedAtIso: input.startedAtIso,
			isRecovery: false,
		});
	} catch (err) {
		log.warn("notifyIncident (fired) failed", {
			incidentId: input.incidentId,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// 2. Wait for resolution (or force-resolve after MAX_WAIT).
	const gotResolved = await condition(() => resolved, MAX_WAIT);
	if (!gotResolved) {
		log.warn("Incident lifecycle force-resolved after timeout", {
			incidentId: input.incidentId,
			timeout: MAX_WAIT,
		});
		resolveReason = "timeout";
		// We do NOT touch the DB here — the lifecycle workflow's
		// responsibility ends at notifications. The DB-side
		// closeIntegrationIncident activity is invoked from the cron
		// pollers when they observe operational health, not from this
		// workflow.
	}

	// 3. Emit the RECOVERY notification. Use isRecovery=true so the
	//    dedupe key is distinct from the FIRED row.
	try {
		await notifyIncident({
			source: input.kind === "integration" ? "integration" : "errorRate",
			incidentId: input.incidentId,
			severity: input.severity,
			providerKey: input.providerKey,
			title: recoveryTitle(input),
			summary: `Resolved (${resolveReason})`,
			link: input.link,
			startedAtIso: input.startedAtIso,
			isRecovery: true,
		});
	} catch (err) {
		log.warn("notifyIncident (recovery) failed", {
			incidentId: input.incidentId,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	log.info("Incident lifecycle complete", {
		incidentId: input.incidentId,
		acknowledged,
		resolveReason,
	});
}
