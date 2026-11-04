/** Visible run views pause after five minutes; Refresh starts a new observation window. */
export const AGENT_RUN_POLL_WINDOW_MS = 5 * 60 * 1000;
export function canPollAgentRun(
	status: string | undefined,
	since: number,
	now = Date.now(),
) {
	return (
		(status === "PENDING" || status === "RUNNING") &&
		now - since < AGENT_RUN_POLL_WINDOW_MS
	);
}
