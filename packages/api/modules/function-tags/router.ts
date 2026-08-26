import { confirmForProjectProcedure } from "./procedures/confirm-for-project";
import { getMyDefaultProcedure } from "./procedures/get-my-default";
import { getMyProjectStatusProcedure } from "./procedures/get-my-project-status";
import { groupMemberCountsProcedure } from "./procedures/group-member-counts";
import { listForProjectProcedure } from "./procedures/list-for-project";
import { setForProjectMemberProcedure } from "./procedures/set-for-project-member";
import { setMyDefaultProcedure } from "./procedures/set-my-default";

export const functionTagsRouter = {
	getMyDefault: getMyDefaultProcedure,
	setMyDefault: setMyDefaultProcedure,
	getMyProjectStatus: getMyProjectStatusProcedure,
	confirmForProject: confirmForProjectProcedure,
	listForProject: listForProjectProcedure,
	setForProjectMember: setForProjectMemberProcedure,
	groupMemberCounts: groupMemberCountsProcedure,
};
