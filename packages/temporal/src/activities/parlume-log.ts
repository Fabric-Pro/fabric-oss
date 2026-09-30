import { logger } from "@repo/logs";

/**
 * Same structured shape as `parlumeLog` in `@repo/api` (`component: "parlume"`,
 * `event: "parlume.<name>"`, ids only), kept local because the worker does not
 * depend on the API package. A session is traced across both with
 * `Properties.event LIKE 'parlume.%'` and `Properties.sessionId`.
 */
export function parlumeActivityLog(
	level: "info" | "warn" | "error",
	event: string,
	meta: Record<string, unknown> & { sessionId?: string | null },
): void {
	logger[level](`[Parlume] ${event}`, {
		component: "parlume",
		event: `parlume.${event}`,
		...meta,
	});
}
