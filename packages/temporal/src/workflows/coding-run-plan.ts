/**
 * Coding run plan selection (plan Slice 3).
 *
 * Pure helper shared by `codingRunWorkflow` and its tests: decides which
 * prompt builder, artifact sync and terminal status a run uses from its
 * `kind`. Old histories carry no `kind` and must replay through the
 * implement path unchanged, so anything other than an explicit "SPIKE"
 * resolves to implement.
 */

export type CodingRunKind = "IMPLEMENT" | "SPIKE";

export interface CodingRunPlan {
	kind: CodingRunKind;
	/** Which prompt builder activity to schedule. */
	prompt: "implement" | "spike";
	/** Which artifact sync to run after the provider finishes. */
	sync: "pr" | "spike";
	/** Whether the sync is critical (failure => FAILED) or best effort. */
	syncCritical: boolean;
	/** Status written after a successful sync. */
	terminalStatus: "COMPLETED" | "DEMO_READY";
	/** Whether pull requests reported by the provider drive PR_OPENED. */
	trackPullRequests: boolean;
}

const IMPLEMENT_PLAN: CodingRunPlan = {
	kind: "IMPLEMENT",
	prompt: "implement",
	sync: "pr",
	syncCritical: false,
	terminalStatus: "COMPLETED",
	trackPullRequests: true,
};

const SPIKE_PLAN: CodingRunPlan = {
	kind: "SPIKE",
	prompt: "spike",
	sync: "spike",
	syncCritical: true,
	terminalStatus: "DEMO_READY",
	trackPullRequests: false,
};

export function selectCodingRunPlan(input: {
	kind?: string | null;
}): CodingRunPlan {
	return input.kind === "SPIKE" ? SPIKE_PLAN : IMPLEMENT_PLAN;
}
