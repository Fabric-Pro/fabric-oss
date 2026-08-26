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
	now: number = Date.now(),
): string {
	return `${BACKLOG_ANALYSIS_WORKFLOW_PREFIX}${projectId}-${now}`;
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
	// `<this project id>-<timestamp>`, timestamp numeric. The separator keeps
	// a longer project id from matching a shorter prefix.
	return (
		remainder.startsWith(`${projectId}-`) &&
		/^\d+$/.test(remainder.slice(projectId.length + 1))
	);
}

const BACKLOG_APPLY_WORKFLOW_PREFIXES = [
	// Longest first: `backlog-apply-` is a strict prefix of the other two, so
	// matching order decides which remainder gets compared.
	"backlog-apply-retry-all-", // -<projectId>-<proposalRowId>-<timestamp>
	"backlog-apply-retry-", // -<projectId>-<timestamp>
	"backlog-apply-", // -<projectId>-<timestamp>
] as const;

/** The Temporal workflow id for one backlog apply-changes run. */
export function backlogApplyWorkflowId(
	projectId: string,
	now: number = Date.now(),
): string {
	return `backlog-apply-${projectId}-${now}`;
}

/**
 * True only when `workflowId` is one of the apply family's three id shapes
 * AND names this project. Same rule as the analysis guard: the project segment
 * directly follows the family prefix, everything after it is safe charset.
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
		return (
			remainder.startsWith(`${projectId}-`) &&
			/^[A-Za-z0-9-]+$/.test(remainder.slice(projectId.length + 1))
		);
	}
	return false;
}
