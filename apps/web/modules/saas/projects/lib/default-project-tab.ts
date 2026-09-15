import type { EngagementProfile } from "@repo/database";
import { getEngagementProfileConfig } from "@repo/database/src/engagement-profiles";

/**
 * The tab a project opens on when the user has not chosen one (no remembered
 * tab, no deep link). Under a profile whose intake is a conversation
 * (EXPLORE) that is the Roadmap, which hosts the backlog chat (plan Slice 6);
 * everywhere else the Overview. An explicit choice is never overridden —
 * `ProjectDetails` only consults this when the initial tab came from the
 * built-in default.
 */
const OVERVIEW_TAB = "overview";
/** The tab that hosts the backlog chat (roadmap "AI Update"). */
const BACKLOG_CHAT_TAB = "stories";

export function defaultProjectTabForProfile<TabId extends string>(
	profile: EngagementProfile | null | undefined,
	validTabIds: readonly TabId[],
): TabId {
	if (
		profile &&
		getEngagementProfileConfig(profile).intakeMode === "conversation" &&
		(validTabIds as readonly string[]).includes(BACKLOG_CHAT_TAB)
	) {
		return BACKLOG_CHAT_TAB as TabId;
	}
	return OVERVIEW_TAB as TabId;
}
