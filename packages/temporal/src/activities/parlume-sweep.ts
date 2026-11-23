/**
 * Parlume's stranded-session sweep, for every project. The web app owns the
 * sweep, because finalizing a session needs the API package the worker
 * cannot reach; this asks it to run. The list procedure still runs the same
 * sweep for one project when its Parlume page is opened.
 */

import { ApplicationFailure } from "@temporalio/common";
import { parlumeActivityLog } from "./parlume-log";
import { getFabricInternalBaseUrl } from "./shared/fabric-internal-url";

/** Below the route's 90 seconds, plus the time to reach it. */
const SWEEP_REQUEST_TIMEOUT_MS = 120_000;

/** How many sessions the web app finalized, when it says. */
function sweptCount(body: unknown): number | null {
	return typeof body === "object" &&
		body !== null &&
		"swept" in body &&
		typeof body.swept === "number"
		? body.swept
		: null;
}

export async function requestParlumeSessionSweep(): Promise<{
	swept: number | null;
}> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		throw ApplicationFailure.nonRetryable(
			"AGENT_SERVICE_SECRET is not configured on the worker.",
		);
	}
	const response = await fetch(
		`${getFabricInternalBaseUrl()}/api/internal/parlume/sweep`,
		{
			method: "POST",
			headers: { "X-Agent-Service-Token": secret },
			signal: AbortSignal.timeout(SWEEP_REQUEST_TIMEOUT_MS),
		},
	);
	if (!response.ok) {
		throw new Error(
			`Parlume session sweep request failed (HTTP ${response.status}).`,
		);
	}
	const swept = sweptCount(await response.json());
	parlumeActivityLog("info", "sweep.requested", { swept });
	return { swept };
}
