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
 *
 * Every line opts in to the log sinks (`forward: true`, see `LogSinkRecord`
 * in `@repo/logs`), info lines included, so Application Insights holds the
 * whole session and the Parlume alert rules can read the lifecycle and
 * speech-health events. The App Insights sink caps each event at 20 records
 * a minute per instance, and the lines carry only ids and counts.
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
		forward: true,
	});
}
