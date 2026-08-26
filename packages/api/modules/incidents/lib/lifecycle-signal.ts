/**
 * Helpers to signal the `incidentLifecycleWorkflow`.
 *
 * The lifecycle workflow has the deterministic ID `incident-{incidentId}`.
 * When a human acknowledges or resolves an incident via the admin UI, the
 * procedure writes an `IncidentEvent` AND signals the workflow. Whichever
 * write lands first wins (the DB call is idempotent via the `status`
 * guard); the signal then short-circuits the workflow's wait condition.
 *
 * Signal delivery is best-effort: if Temporal is unavailable, the DB
 * write still stands and the workflow will reconcile on its next
 * heartbeat. We log + swallow rather than fail the admin's API call.
 */
import { getTemporalClient } from "@repo/temporal";

const ACKNOWLEDGED_SIGNAL = "acknowledged";
const RESOLVED_SIGNAL = "resolved";

function workflowIdFor(incidentId: string): string {
	return `incident-${incidentId}`;
}

export async function signalIncidentAcknowledged(args: {
	incidentId: string;
	userId: string;
	note?: string;
}): Promise<void> {
	try {
		const client = await getTemporalClient();
		const handle = client.workflow.getHandle(
			workflowIdFor(args.incidentId),
		);
		await handle.signal(ACKNOWLEDGED_SIGNAL, {
			userId: args.userId,
			note: args.note,
		});
	} catch (error) {
		// Best-effort. The DB row already reflects ACKNOWLEDGED; the workflow
		// will reconcile via its periodic readModel check on the next tick.
		console.warn("[incidents] Failed to signal acknowledged", {
			incidentId: args.incidentId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function signalIncidentResolved(args: {
	incidentId: string;
	userId?: string;
	reason: string;
}): Promise<void> {
	try {
		const client = await getTemporalClient();
		const handle = client.workflow.getHandle(
			workflowIdFor(args.incidentId),
		);
		await handle.signal(RESOLVED_SIGNAL, {
			userId: args.userId,
			reason: args.reason,
		});
	} catch (error) {
		console.warn("[incidents] Failed to signal resolved", {
			incidentId: args.incidentId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
