import { heartbeat } from "@temporalio/activity";

const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Keep slow activity operations alive; outside an activity, heartbeats are
 * ignored. With `maxMs`, the keepalive stops once the operation has run that
 * long, so one that hangs still fails the attempt on its heartbeat timeout.
 */
export async function withHeartbeatKeepalive<T>(
	details: Record<string, unknown>,
	fn: () => Promise<T>,
	maxMs = Number.POSITIVE_INFINITY,
): Promise<T> {
	let elapsedMs = 0;
	const interval = setInterval(() => {
		elapsedMs += KEEPALIVE_INTERVAL_MS;
		if (elapsedMs > maxMs) {
			clearInterval(interval);
			return;
		}
		try {
			heartbeat({ keepalive: true, ...details });
		} catch {
			/* No activity context, or the activity has stopped. */
		}
	}, KEEPALIVE_INTERVAL_MS);
	try {
		return await fn();
	} finally {
		clearInterval(interval);
	}
}
