/**
 * Whether "Change to bug / feature" is refused for this work item.
 *
 * A conversion snaps the drafting stage to DRAFT, and the stage-transition
 * choke point lets a DEFER-track item move only to DECLINED, CLOSED or
 * PLACEHOLDER — so the server refuses a deferred item that is not already in
 * DRAFT. Mirrors the guard in `convert-kind.ts`; every surface offering the
 * conversion reads this one predicate so none of them offers a dead action.
 */
export function isConvertKindBlockedByDefer(story: {
	deliveryTrack?: string | null;
	draftingStage?: string | null;
}): boolean {
	return story.deliveryTrack === "DEFER" && story.draftingStage !== "DRAFT";
}
