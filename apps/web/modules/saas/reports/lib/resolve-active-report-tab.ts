export type ReportInstanceTab = "overview" | "history";

/**
 * Resolve the active report-instance tab from the `?tab` query param.
 *
 * The URL is authoritative for the tab so a notification deep link lands on the
 * right pane: a failure notification links to `?tab=history`, a
 * success notification to `?tab=overview`. Both carry an explicit `?tab` so
 * navigating between them on the SAME instance always changes the param and
 * resets the tab (same-route navigation does not remount the page, so a tab-less
 * link could leave the user stranded on Execution History).
 *
 * Anything other than `history` falls back to `overview`, which also validates
 * the param (e.g. a direct visit with no `?tab`, or a stray value).
 */
export function resolveActiveReportTab(
	tabParam: string | null | undefined,
): ReportInstanceTab {
	return tabParam === "history" ? "history" : "overview";
}
