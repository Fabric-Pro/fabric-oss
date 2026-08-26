/**
 * Automation Templates Router
 *
 * API routes for managing and executing automation templates.
 */

import { createTemplateProcedure } from "./procedures/create-template";
import { createTemplateFromTaskProcedure } from "./procedures/create-template-from-task";
import { deleteTemplateProcedure } from "./procedures/delete-template";
import { executeTemplateProcedure } from "./procedures/execute-template";
import { getTemplateProcedure } from "./procedures/get-template";
import { listTemplatesProcedure } from "./procedures/list-templates";
import { updateTemplateProcedure } from "./procedures/update-template";

export const automationTemplatesRouter = {
	// Template CRUD operations
	list: listTemplatesProcedure,
	get: getTemplateProcedure,
	create: createTemplateProcedure,
	createFromTask: createTemplateFromTaskProcedure,
	update: updateTemplateProcedure,
	delete: deleteTemplateProcedure,

	// Template execution
	execute: executeTemplateProcedure,
};
