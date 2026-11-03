/**
 * Strip system-owned fields from a UserStory before it crosses a user- or
 * agent-facing boundary.
 *
 * This includes private remote coding bindings and `labels`. The latter is state for
 * the GitLab label↔status sync pipeline (see
 * `@repo/integrations/pm/label-status-map`), the PM push funnel
 * (`pmLabelValues` in @repo/temporal), and internal provenance markers such as
 * `supersedes:<identifier>`, which `analyze-context` queries with
 * `labels: { has: ... }`. The column is written by sync/automation and read by
 * sync; no UI renders it and no API input accepts it.
 *
 * Use this at the PROCEDURE boundary — every procedure that returns a story to
 * a client. Never strip `labels` in the Prisma query itself: `getStoryById` is
 * the PM push's label source (`gitlab-rest-story-sync.ts` reads
 * `story.labels ?? []` to compute the label delta and full-sets it on create),
 * so narrowing the query makes that read `[]` and silently wipes every issue's
 * labels on the next push — while still type-checking.
 */
// The constraint is `object`, not `{ labels?: unknown }`: an all-optional
// constraint is a *weak type*, and TS then rejects any argument with no `labels`
// key at all ("has no properties in common"). Several callers pass story shapes
// typed without it. The cast below is what lets the destructure see the field.
//
// Takes a non-null story by design. `getStoryById` and friends return `T | null`
// — handle the not-found branch at the call site, where the 404 semantics live,
// rather than teaching this helper to swallow null.
export function stripInternalStoryFields<T extends object>(
	story: T,
): Omit<T, "labels"> {
	const { labels: _labels, ...rest } = story as T & { labels?: unknown };
	stripRemoteCodingSummaryDetails(rest);
	return rest as Omit<T, "labels">;
}

/** Runtime bindings belong to the authorized session endpoint, not shared story cards. */
function stripRemoteCodingSummaryDetails(value: object): void {
	const record = value as Record<string, unknown>;
	if (Array.isArray(record.codingRuns)) {
		record.codingRuns = record.codingRuns.map(stripRemoteCodingRunSummary);
	}
	if (Array.isArray(record.tasks)) {
		record.tasks = record.tasks.map((task: object) => {
			const result = { ...task };
			stripRemoteCodingSummaryDetails(result);
			return result;
		});
	}
}

/** Array convenience wrapper — same contract as stripInternalStoryFields. */
export function stripInternalStoryFieldsFromMany<T extends object>(
	stories: T[],
): Omit<T, "labels">[] {
	return stories.map((story) => stripInternalStoryFields(story));
}

/** Shared feeds and AI context expose progress/PRs, never registered host bindings.
 * Owners can inspect runtime details through the authorized Coding Run endpoint.
 */
export function stripRemoteCodingRunSummary<T extends object>(run: T): T {
	const record = run as T & { providerMetadata?: unknown };
	const metadata = record.providerMetadata as {
		executionRuntime?: unknown;
		executionTarget?: { connectionId?: unknown } | null;
		llmConnection?: unknown;
		model?: unknown;
		fallbackPolicy?: unknown;
		serverName?: unknown;
	} | null;
	if (typeof metadata?.executionTarget?.connectionId === "string") {
		return {
			...run,
			providerSessionId: null,
			externalUrl: null,
			externalStatus: null,
			workingDirectory: null,
			events: [],
			providerMetadata: { executionRuntime: "fabric-agent-server" },
		};
	}
	if (metadata && "executionTarget" in metadata) {
		const { executionTarget: _executionTarget, ...safeMetadata } =
			metadata as Record<string, unknown>;
		return {
			...run,
			providerMetadata:
				Object.keys(safeMetadata).length > 0 ? safeMetadata : null,
		};
	}
	return run;
}
