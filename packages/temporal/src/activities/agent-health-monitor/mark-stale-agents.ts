import {
	markStaleAgentsInactive,
	reactivateNonProbeableAgents,
} from "@repo/database";

export interface MarkStaleAgentsInput {
	staleThresholdMinutes: number;
}

export interface MarkStaleAgentsOutput {
	updatedCount: number;
	/** Non-probeable agents (FABRIC_NATIVE / inline) self-healed back to ACTIVE. */
	reactivatedCount: number;
}

export async function markStaleAgents(
	input: MarkStaleAgentsInput,
): Promise<MarkStaleAgentsOutput> {
	// Reactivate non-probeable agents first so a status they should never hold
	// (STALE/ERROR) is cleared every cycle, then mark genuinely stale ones. The
	// two operate on disjoint sets, so order is not load-bearing. See #1685.
	const reactivatedCount = await reactivateNonProbeableAgents();
	const updatedCount = await markStaleAgentsInactive(
		input.staleThresholdMinutes,
	);
	return { updatedCount, reactivatedCount };
}
