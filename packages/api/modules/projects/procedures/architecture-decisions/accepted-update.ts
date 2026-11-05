/**
 * Accepting a decision created with "Create as update" retires the decision it
 * updates: the reviewer already chose "update", and leaving both active would
 * keep two conflicting decisions in force.
 *
 * Only the transition to ACCEPTED counts, so saving an accepted decision again
 * does nothing. A target that is no longer in force is left as it is, so a link
 * to a newer decision is never overwritten.
 */
import {
	getArchitectureDecision,
	livingMemoryUpdateTargetId,
} from "@repo/database";

const IN_FORCE_STATUSES: ReadonlySet<string> = new Set([
	"ACCEPTED",
	"PROPOSED",
]);

export async function acceptedUpdateTargetIds(input: {
	projectId: string;
	previousStatus: string;
	newStatus: string;
	sourceKind: string | null;
	sourceMetadata: Parameters<
		typeof livingMemoryUpdateTargetId
	>[0]["sourceMetadata"];
}): Promise<string[]> {
	if (input.previousStatus === "ACCEPTED" || input.newStatus !== "ACCEPTED") {
		return [];
	}
	const targetId = livingMemoryUpdateTargetId(input);
	if (!targetId) {
		return [];
	}
	const target = await getArchitectureDecision({
		id: targetId,
		projectId: input.projectId,
	});
	return target && IN_FORCE_STATUSES.has(target.status) ? [targetId] : [];
}
