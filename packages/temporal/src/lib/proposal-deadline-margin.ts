/**
 * How long before its earliest timeout a proposal activity stops issuing
 * effects (`withProposalDeadline`): the time the last call's abort, the git
 * process group's kill and the failure report take, plus the gap between
 * Temporal starting the attempt and the function running. As the repository
 * poll's check does (#2540 Decision 50).
 *
 * Dependency-free, so a workflow can size an activity's timeout from it
 * without importing the activity layer.
 */
export const PROPOSAL_DEADLINE_MARGIN_MS = 10_000;
