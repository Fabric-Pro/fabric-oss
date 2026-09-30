import { logger } from "@repo/logs";

type ParlumeLogMeta = Record<string, unknown> & {
	sessionId?: string | null;
	botId?: string | null;
};

/**
 * One structured shape for every Parlume log line, so a session can be traced
 * from invitation to finalization across the web routes, the API procedures,
 * and the Temporal activities with `Properties.event LIKE 'parlume.%'` and
 * `Properties.sessionId`. Ids and counts only: never the meeting URL, stream
 * tokens, callback secrets, or transcript text.
 */
export function parlumeLog(
	level: "info" | "warn" | "error",
	event: string,
	meta: ParlumeLogMeta,
): void {
	logger[level](`[Parlume] ${event}`, {
		component: "parlume",
		event: `parlume.${event}`,
		...meta,
	});
}
