/**
 * Skills Router
 *
 * API routes for the skill catalog CRUD operations.
 */

import { createSkillProcedure } from "./procedures/create";
import { deleteSkillProcedure } from "./procedures/delete";
import { executeSkillProcedure } from "./procedures/execute";
import { getSkillProcedure } from "./procedures/get";
import { listSkillsProcedure } from "./procedures/list";
import { updateSkillProcedure } from "./procedures/update";

export const skillsRouter = {
	list: listSkillsProcedure,
	get: getSkillProcedure,
	execute: executeSkillProcedure,
	create: createSkillProcedure,
	update: updateSkillProcedure,
	delete: deleteSkillProcedure,
};
