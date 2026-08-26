/**
 * User Activity dashboard router.
 *  - `userActivity.listMembers` — member list w/ last login + count.
 *  - `userActivity.memberHistory` — per-member daily buckets + events.
 * Wired into the main router as `userActivity: userActivityRouter`.
 */
import { listMemberActivityProcedure } from "./procedures/list-members";
import { getMemberLoginHistoryProcedure } from "./procedures/member-history";

export const userActivityRouter = {
	listMembers: listMemberActivityProcedure,
	memberHistory: getMemberLoginHistoryProcedure,
};
