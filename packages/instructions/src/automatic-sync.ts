/**
 * Automatic repository sync eligibility (spec §6.1, §6.2).
 *
 * The poll (a Temporal activity) and the GitHub push webhook (an API route)
 * both decide through this one function, so the two entry points cannot
 * drift. It is pure: the caller loads the sync row and passes the head commit
 * it observed, if it has one.
 *
 * The two cursors are bound to the configuration generation. A changed
 * configuration (branch, folder or ignore rules) bumps the generation, so a
 * head evaluated or suppressed under the old configuration is checked again.
 */
export interface AutomaticSyncRow {
	automatic: boolean;
	/** `ProjectInstructionSyncPause` or null. Any non-null value pauses. */
	automaticPausedReason: string | null;
	generation: number;
	lastEvaluatedCommitSha: string | null;
	lastEvaluatedGeneration: number | null;
	suppressedCommitSha: string | null;
	suppressedGeneration: number | null;
}

export type AutomaticSyncSkipReason =
	| "disabled"
	| "paused"
	| "evaluated"
	| "suppressed";

export type AutomaticSyncDecision =
	| { start: true }
	| { start: false; reason: AutomaticSyncSkipReason };

/**
 * Whether an automatic run should start for `row`, given the branch head the
 * caller observed.
 *
 * - `disabled` and `paused` always win.
 * - `evaluated`: the head was already processed under this configuration
 *   (published, or found unchanged).
 * - `suppressed`: the head failed permanently under this configuration
 *   (for example, rejected by the checks) and must not be retried until
 *   the branch moves or the configuration changes.
 * - Without a head (a caller that could not observe one) neither cursor
 *   applies and the run starts; the run itself decides whether anything
 *   changed.
 */
export function shouldStartAutomaticSync(
	row: AutomaticSyncRow,
	headSha?: string | null,
): AutomaticSyncDecision {
	if (!row.automatic) {
		return { start: false, reason: "disabled" };
	}
	if (row.automaticPausedReason !== null) {
		return { start: false, reason: "paused" };
	}
	if (!headSha) {
		return { start: true };
	}
	if (
		row.lastEvaluatedCommitSha === headSha &&
		row.lastEvaluatedGeneration === row.generation
	) {
		return { start: false, reason: "evaluated" };
	}
	if (
		row.suppressedCommitSha === headSha &&
		row.suppressedGeneration === row.generation
	) {
		return { start: false, reason: "suppressed" };
	}
	return { start: true };
}
