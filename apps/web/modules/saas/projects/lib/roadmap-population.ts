/**
 * Whether a Roadmap counts as populated (Fizzy #2204, FR39–FR43).
 *
 * The "Start Building Your Roadmap" state shows until at least one work item
 * counts. A pure module, like `report-readiness.ts`, so the rule is one table
 * with a named test per case rather than a condition spread across the page.
 *
 * A work item counts unless a row below excludes it. Parked work does not
 * count: declined and hidden (archived) items, items still sitting in the
 * project's default status, and items already in a final status. The default
 * and final rules were a product decision — a Roadmap of only Backlog or only
 * Done items still needs building.
 *
 * Maturation V2 boards edit the maturation stage, never the status, so every
 * item there stays in the default status. With V2 on, an item in the default
 * status still counts once its stage is past the first one ("To Do").
 */

import {
	getMaturationStatus,
	type StoryStatus,
	type UserStory,
} from "./stories/types";

type PopulationStory = Pick<
	UserStory,
	"draftingStage" | "statusId" | "maturationStatus"
>;

interface PopulationContext {
	status: StoryStatus | undefined;
	maturationV2Enabled: boolean;
}

interface PopulationRule {
	id: "declined" | "hidden-archived" | "backlog" | "completed";
	fr: string;
	reason: string;
	/** `status` is undefined when the item's status is not (yet) known. */
	excludes: (story: PopulationStory, context: PopulationContext) => boolean;
}

export const ROADMAP_POPULATION_POLICY: readonly PopulationRule[] = [
	{
		id: "declined",
		fr: "FR39",
		reason: "A declined item was rejected, not planned.",
		excludes: (story) => story.draftingStage === "DECLINED",
	},
	{
		id: "hidden-archived",
		fr: "FR40",
		reason: "A hidden item is archived and off the board.",
		excludes: (story) => story.draftingStage === "CLOSED",
	},
	{
		id: "backlog",
		fr: "FR41",
		reason: "An item still in the default status, and on a Maturation V2 board still in the first stage, has not been planned yet.",
		excludes: (story, { status, maturationV2Enabled }) =>
			status?.isDefault === true &&
			(!maturationV2Enabled || getMaturationStatus(story) === "TO_DO"),
	},
	{
		id: "completed",
		fr: "FR42",
		reason: "A finished item is history, not upcoming work.",
		excludes: (_story, { status }) => status?.isFinal === true,
	},
];

/**
 * True iff at least one item is excluded by no row (FR43).
 *
 * An item whose status is unknown — statuses still loading, or a status this
 * list does not carry — counts as populated, so the page fails toward showing
 * the board rather than flashing the empty state over real work.
 */
export function isRoadmapPopulated(
	stories: readonly PopulationStory[],
	statuses: readonly StoryStatus[],
	maturationV2Enabled: boolean,
): boolean {
	const statusById = new Map(statuses.map((s) => [s.id, s]));
	return stories.some((story) => {
		const context = {
			status: statusById.get(story.statusId),
			maturationV2Enabled,
		};
		return !ROADMAP_POPULATION_POLICY.some((rule) =>
			rule.excludes(story, context),
		);
	});
}
