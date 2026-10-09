/**
 * Ceiling for a single MCP `tool.execute` call. Sits under the 5-minute
 * activity `startToCloseTimeout` so a hung server surfaces as a tool error the
 * assistant can talk about, rather than as an activity that dies silently and
 * leaves the chat spinning on `Running` with nothing to show.
 */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000;

/**
 * Ceiling for Fabric's own tools — the `fabric_*` tools and the catalog tools
 * that run in this activity (Fizzy #2770 D8). Several run a model step, and on
 * a ChatGPT plan such a step was seen taking 63s, past the 60s ceiling meant
 * to catch a hung external server. Fabric's tools are bounded by their own
 * model calls instead, so they get a longer ceiling, still under the activity
 * timeout; every external server keeps the 60s one.
 */
export const FIRST_PARTY_MCP_TOOL_TIMEOUT_MS = 180_000;

/**
 * The ceiling a call actually runs under: the caller's, raised to
 * {@link FIRST_PARTY_MCP_TOOL_TIMEOUT_MS} for Fabric's own tools. No ceiling
 * requested stays none — the activity timeout bounds the call then.
 */
export function effectiveMcpToolTimeoutMs(
	requestedMs: number | undefined,
	firstParty: boolean,
): number | undefined {
	if (requestedMs === undefined || !firstParty) {
		return requestedMs;
	}
	return Math.max(requestedMs, FIRST_PARTY_MCP_TOOL_TIMEOUT_MS);
}

/**
 * Bounded-time wrapper for a single async unit of work.
 *
 * Races `work` against a timer that resolves to `onTimeout()` after
 * `timeoutMs`. Used by `executeMcpTool` so a hung MCP `tool.execute` (which may
 * never settle) cannot keep the caller — and its heartbeat interval — alive
 * forever: the race resolves on timeout, the caller returns, and the caller's
 * own `finally` cleans up.
 *
 * The loser of the race keeps running (an AI-SDK tool call has no cancellation
 * plumbed through here); the defensive `.catch` prevents a late rejection of
 * `work` from surfacing as an unhandled rejection after the timeout has won.
 */
export async function runWithTimeout<T>(
	work: Promise<T>,
	timeoutMs: number,
	onTimeout: () => T,
): Promise<T> {
	work.catch(() => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race<T>([
			work,
			new Promise<T>((resolve) => {
				timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}
