/**
 * Shared shape + helpers for CI pipeline runs, so the QA tab (feature editor)
 * and the project QA tab render identical rows from one definition
 * instead of each growing its own copy.
 */

/** One ingested CI run, as `pipelineResults.listRuns` / `listRunsPage` return it. */
export type PipelineRun = {
	id: string;
	/** Provider tag: "github-actions" | "gitlab-ci" | "azure-devops" | "jira-xray". */
	provider: string;
	externalRunId: string;
	pipelineName?: string | null;
	branch?: string | null;
	commitSha?: string | null;
	runUrl?: string | null;
	status?: string | null;
	startedAt?: string | Date | null;
	finishedAt?: string | Date | null;
	durationMs?: number | null;
	/** Who triggered the run on the provider — the human "run by". */
	triggeredByActor?: string | null;
	triggeredByActorAvatarUrl?: string | null;
	totalCount: number;
	passedCount: number;
	failedCount: number;
	skippedCount: number;
	otherCount: number;
	createdAt?: string | Date | null;
};

/** Human "N minutes/hours/days ago" — small + dependency-free. */
export function timeAgo(
	value: string | Date | null | undefined,
): string | null {
	if (!value) {
		return null;
	}
	const then = new Date(value).getTime();
	if (Number.isNaN(then)) {
		return null;
	}
	const min = Math.round((Date.now() - then) / 60000);
	// A run dated in the FUTURE is not "just now": CI runners drift, and a
	// negative delta used to fall through `min < 1` and report a run from
	// tomorrow as having happened moments ago.
	if (min < 0) {
		return "just now (clock skew)";
	}
	if (min < 1) {
		return "just now";
	}
	if (min < 60) {
		return `${min}m ago`;
	}
	const hrs = Math.round(min / 60);
	if (hrs < 24) {
		return `${hrs}h ago`;
	}
	const days = Math.round(hrs / 24);
	if (days < 365) {
		return `${days}d ago`;
	}
	// Without this a year-old run read as "412d ago", which nobody parses.
	const years = Math.floor(days / 365);
	return years === 1 ? "over a year ago" : `over ${years}y ago`;
}

/** `3m 12s` — run duration, or null when the provider didn't report one. */
/** Local date/time with an explicit UTC offset for audit-friendly history. */
export function formatAbsoluteTime(
	value: string | Date | null | undefined,
): string | null {
	if (!value) {
		return null;
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		timeZoneName: "shortOffset",
	}).format(date);
}

export function formatDuration(ms: number | null | undefined): string | null {
	if (ms == null || !Number.isFinite(ms) || ms <= 0) {
		return null;
	}
	const total = Math.round(ms / 1000);
	const mins = Math.floor(total / 60);
	const secs = total % 60;
	return mins > 0
		? `${mins}m ${secs.toString().padStart(2, "0")}s`
		: `${secs}s`;
}
