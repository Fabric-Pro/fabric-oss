type CodingRunLifecycleStatus =
	| "QUEUED"
	| "STARTING"
	| "RUNNING"
	| "AWAITING_REVIEW"
	| "PR_OPENED"
	| "DEMO_READY"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED"
	| "TERMINATED_STALE";

export const ACTIVE_CODING_RUN_STATUSES: ReadonlySet<string> =
	new Set<CodingRunLifecycleStatus>([
		"QUEUED",
		"STARTING",
		"RUNNING",
		"AWAITING_REVIEW",
		"PR_OPENED",
		"DEMO_READY",
	]);

export function isCodingRunActive(
	run: { status?: string | null } | null | undefined,
): boolean {
	if (!run?.status) {
		return false;
	}
	return ACTIVE_CODING_RUN_STATUSES.has(run.status);
}

export function hasActiveStoryLevelCodingRun(
	story:
		| {
				latestCodingRun?: {
					status?: string | null;
					storyTask?: { id?: string | null } | null;
				} | null;
		  }
		| null
		| undefined,
): boolean {
	if (!story?.latestCodingRun) {
		return false;
	}
	if (story.latestCodingRun.storyTask?.id) {
		return false;
	}
	return isCodingRunActive(story.latestCodingRun);
}

export function hasActiveCodingRunOnStory(
	story:
		| {
				latestCodingRun?: { status?: string | null } | null;
				tasks?: Array<{
					latestCodingRun?: { status?: string | null } | null;
				}> | null;
		  }
		| null
		| undefined,
): boolean {
	if (!story) {
		return false;
	}
	if (isCodingRunActive(story.latestCodingRun)) {
		return true;
	}
	if (Array.isArray(story.tasks)) {
		return story.tasks.some((task) =>
			isCodingRunActive(task?.latestCodingRun),
		);
	}
	return false;
}
