import { heartbeat } from "@temporalio/activity";

/** Keep slow activity operations alive; outside an activity, heartbeats are ignored. */
export async function withHeartbeatKeepalive<T>(
	details: Record<string, unknown>,
	fn: () => Promise<T>,
): Promise<T> {
	const interval = setInterval(() => {
		try {
			heartbeat({ keepalive: true, ...details });
		} catch {
			/* No activity context, or the activity has stopped. */
		}
	}, 15_000);
	try {
		return await fn();
	} finally {
		clearInterval(interval);
	}
}
