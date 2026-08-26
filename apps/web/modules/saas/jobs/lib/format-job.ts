import type { JobListItem } from "../hooks/use-jobs";

/**
 * Counter keys the panel knows how to label, in display order.
 *
 * Job counters are an open-ended map so a new job kind can add its own without a
 * migration; anything not listed here is simply not rendered rather than shown
 * as a raw key. Keep in sync with what the activities in `@repo/temporal` write.
 */
const COUNT_ORDER = [
	"messagesScanned",
	"threadsAnalyzed",
	"groupsFlushed",
	"proposalsCreated",
	"topicsSuggested",
	"emptyThreads",
	"skippedAlreadySeen",
	"failedChannels",
	"failures",
	"filesProcessed",
	"chunksCreated",
	"summariesCreated",
	"symbols",
	"embedded",
	"errors",
] as const;

/**
 * Human-readable count summary, e.g. "12 messages scanned · 4 proposals
 * created". `filesProcessed` renders against `totalFiles` when the total is
 * known, so a long index reads as progress ("120/3,400 files") rather than a
 * number climbing toward nothing.
 */
export function formatJobCounts(
	counts: Record<string, number>,
	/**
	 * Counts go through as numbers so the ICU plural form is selected from the
	 * value ("1 thread" vs "2 threads") — a preformatted string would defeat
	 * that.
	 *
	 * The files-progress line is the exception: it is a ratio rather than a
	 * plural, and its grouping is applied here rather than with `{n, number}`.
	 * Real next-intl handles that skeleton fine (other messages in this app use
	 * it); the panel's test harness does not, and rendered the message
	 * literally. Formatting here keeps the two agreeing. Note the same gap the
	 * other way: `#` inside a plural IS grouped by real next-intl, so
	 * production shows "1,234 messages scanned" where the mock shows "1234".
	 */
	labels: (
		key: string,
		values: { count: number | string; total: number | string },
	) => string,
): string[] {
	const parts: string[] = [];
	const total = counts.totalFiles;

	for (const key of COUNT_ORDER) {
		const value = counts[key];
		if (typeof value !== "number" || value <= 0) {
			continue;
		}
		if (
			key === "filesProcessed" &&
			typeof total === "number" &&
			total > 0
		) {
			parts.push(
				labels("filesProgress", {
					count: value.toLocaleString(),
					total: total.toLocaleString(),
				}),
			);
			continue;
		}
		parts.push(labels(key, { count: value, total: 0 }));
	}

	return parts;
}

/**
 * Panel ordering: the current project's jobs first, then newest. Running vs
 * finished is handled by the panel's Active/Recent sections, not here.
 *
 * The current-project bias is what makes a workspace-wide panel usable from
 * inside a project — the jobs you just triggered are at the top, without hiding
 * what is happening elsewhere.
 */
export function sortJobsForPanel(
	jobs: JobListItem[],
	currentProjectId?: string | null,
): JobListItem[] {
	return [...jobs].sort((a, b) => {
		if (currentProjectId) {
			const aCurrent = a.projectId === currentProjectId ? 0 : 1;
			const bCurrent = b.projectId === currentProjectId ? 0 : 1;
			if (aCurrent !== bCurrent) {
				return aCurrent - bCurrent;
			}
		}
		return (
			new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
		);
	});
}

export function isJobRunning(job: JobListItem): boolean {
	return job.status === "RUNNING";
}
