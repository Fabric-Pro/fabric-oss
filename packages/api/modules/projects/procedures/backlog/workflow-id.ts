import { createHash } from "node:crypto";

/**
 * Temporal workflow ids for the backlog analysis and backlog apply-changes
 * families, and the guards that keep progress reads bound to the authorized
 * project (security review of Fizzy #1234).
 *
 * Every id embeds the project it was started for, so a progress query carrying
 * a different project's id would otherwise read that project's proposal. Both
 * the minters and the readers derive their formats from here — it is
 * load-bearing. The two retry minter shapes (`backlog-apply-retry-…` and
 * `backlog-apply-retry-all-…`, see retry-failed-proposal /
 * retry-all-failed-proposals) are accepted by the apply guard but stay bespoke.
 */

const BACKLOG_ANALYSIS_WORKFLOW_PREFIX = "backlog-analysis-";

export function backlogAnalysisWorkflowId(
	projectId: string,
	operation: number | string = Date.now(),
): string {
	const suffix =
		typeof operation === "number"
			? String(operation)
			: `op-${createHash("sha256").update(operation).digest("hex")}`;
	return `${BACKLOG_ANALYSIS_WORKFLOW_PREFIX}${projectId}-${suffix}`;
}

/**
 * True only when `workflowId` names exactly this project. Malformed ids are
 * rejected rather than parsed leniently — anything that does not name this
 * project grants nothing.
 */
export function isBacklogAnalysisWorkflowIdFor(
	workflowId: string,
	projectId: string,
): boolean {
	if (!workflowId.startsWith(BACKLOG_ANALYSIS_WORKFLOW_PREFIX)) {
		return false;
	}
	const remainder = workflowId.slice(BACKLOG_ANALYSIS_WORKFLOW_PREFIX.length);
	// Accept legacy numeric timestamps and hashed operation keys. The separator keeps
	// a longer project id from matching a shorter prefix.
	return (
		remainder.startsWith(`${projectId}-`) &&
		/^(?:\d+|op-[a-f0-9]{64})$/.test(remainder.slice(projectId.length + 1))
	);
}

const BACKLOG_APPLY_WORKFLOW_PREFIXES = [
	// Longest first: `backlog-apply-` is a strict prefix of the other two, so
	// matching order decides which remainder gets compared.
	"backlog-apply-retry-all-", // -<projectId>-<proposalRowId>-<timestamp>
	"backlog-apply-retry-", // -<projectId>-<timestamp>
	"backlog-apply-", // -<projectId>-<timestamp|op-hash>
] as const;

/** The Temporal workflow id for one backlog apply-changes run. */
export function backlogApplyWorkflowId(
	projectId: string,
	operation: number | string = Date.now(),
): string {
	return `backlog-apply-${projectId}-${operation}`;
}

/**
 * True only when `workflowId` is one of the apply family's three id shapes
 * AND names this project. Same rule as the analysis guard: the project segment
 * directly follows the family prefix. Plain applies require a timestamp or
 * hashed operation suffix; retry suffixes retain their existing safe charset.
 */
export function isBacklogApplyWorkflowIdFor(
	workflowId: string,
	projectId: string,
): boolean {
	for (const prefix of BACKLOG_APPLY_WORKFLOW_PREFIXES) {
		if (!workflowId.startsWith(prefix)) {
			continue;
		}
		const remainder = workflowId.slice(prefix.length);
		const suffix = remainder.slice(projectId.length + 1);
		return (
			remainder.startsWith(`${projectId}-`) &&
			(prefix === "backlog-apply-"
				? /^(?:\d+|op-[a-f0-9]{64})$/.test(suffix)
				: /^[A-Za-z0-9-]+$/.test(suffix))
		);
	}
	return false;
}

/**
 * The Temporal workflow id for a project's roadmap-recommendation run
 * (Fizzy #2208). Deterministic per project, so a second start while one is
 * running collapses onto it, and the status read addresses it by project
 * alone.
 */
export function roadmapRecommendationWorkflowId(projectId: string): string {
	return `roadmap-recommendation-${projectId}`;
}
