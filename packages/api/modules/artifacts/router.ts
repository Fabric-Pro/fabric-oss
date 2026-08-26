/**
 * Chat Artifacts Router
 *
 * API routes for managing persisted chat artifacts
 * (research reports, code, documents, data).
 */

import { attachToProjectProcedure } from "./procedures/attach-to-project";
import { createProcedure } from "./procedures/create";
import { deleteProcedure } from "./procedures/delete";
import { getProcedure } from "./procedures/get";
import { listProcedure } from "./procedures/list";

export const artifactsRouter = {
	list: listProcedure,
	get: getProcedure,
	create: createProcedure,
	attachToProject: attachToProjectProcedure,
	delete: deleteProcedure,
};
