/**
 * Ceiling for a single MCP `tool.execute` call. Sits under the 5-minute
 * activity `startToCloseTimeout` so a hung server surfaces as a tool error the
 * assistant can talk about, rather than as an activity that dies silently and
 * leaves the chat spinning on `Running` with nothing to show.
 */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000;

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
