import { orpc } from "@shared/lib/orpc-query-utils";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { ReportRequest } from "./report-filters";
import type { TimeReport } from "./report-table";

/**
 * Refresh every cached read of the caller's entries after a write: the week
 * and day views and any work item's section.
 *
 * The filters are derived from the procedures' own `key()` prefixes rather
 * than written out, because `invalidateQueries` with a hand-built key that
 * matches nothing succeeds silently and leaves the screen stale. One write can
 * touch both reads (an entry linked to a work item also sits in its week), so
 * both are refreshed every time.
 */
export function invalidateTimeEntries(queryClient: QueryClient) {
	return Promise.all([
		queryClient.invalidateQueries({
			queryKey: orpc.timeTracking.listEntries.key(),
		}),
		queryClient.invalidateQueries({
			queryKey: orpc.timeTracking.listForStory.key(),
		}),
	]);
}

/**
 * Refresh after a suggestion is confirmed or dismissed: the "To confirm"
 * list it leaves, and the entries a confirm adds to (the day, the week and
 * their totals).
 */
export function invalidateTimeSuggestions(queryClient: QueryClient) {
	return Promise.all([
		queryClient.invalidateQueries({
			queryKey: orpc.timeTracking.listSuggestions.key(),
		}),
		invalidateTimeEntries(queryClient),
	]);
}

/**
 * Refresh what a project's or the organization's time policy decides after it
 * changes: the rules the entry line starts from, and the reports, whose
 * project-type filter follows each project's current type.
 */
export function invalidateTimePolicy(queryClient: QueryClient) {
	return Promise.all([
		queryClient.invalidateQueries({
			queryKey: orpc.timeTracking.listLoggableProjects.key(),
		}),
		queryClient.invalidateQueries({
			queryKey: orpc.timeTracking.organizationReport.key(),
		}),
		queryClient.invalidateQueries({
			queryKey: orpc.timeTracking.projectReport.key(),
		}),
	]);
}

/** The cached read of one report, from whichever procedure serves its scope. */
export function timeReportQuery(request: ReportRequest): {
	queryKey: QueryKey;
	queryFn: () => Promise<TimeReport>;
} {
	switch (request.kind) {
		case "organization":
			return {
				queryKey: orpc.timeTracking.organizationReport.queryKey({
					input: request.input,
				}),
				queryFn: () =>
					orpc.timeTracking.organizationReport.call(request.input),
			};
		case "project":
			return {
				queryKey: orpc.timeTracking.projectReport.queryKey({
					input: request.input,
				}),
				queryFn: () =>
					orpc.timeTracking.projectReport.call(request.input),
			};
		default: {
			const unhandled: never = request;
			throw new Error(`Unhandled report request: ${String(unhandled)}`);
		}
	}
}

/** The same report as a CSV file, with the file name the server suggests. */
export function exportTimeReportCsv(
	request: ReportRequest,
): Promise<{ filename: string; csv: string }> {
	switch (request.kind) {
		case "organization":
			return orpc.timeTracking.exportOrganizationReportCsv.call(
				request.input,
			);
		case "project":
			return orpc.timeTracking.exportProjectReportCsv.call(request.input);
		default: {
			const unhandled: never = request;
			throw new Error(`Unhandled report request: ${String(unhandled)}`);
		}
	}
}
