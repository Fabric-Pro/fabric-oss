/**
 * Workspace Router
 *
 * API routes for managing agent workspace files.
 */

import {
	createFileProcedure,
	deleteFileProcedure,
	getFileProcedure,
	getFileTreeProcedure,
	updateFileProcedure,
} from "./procedures";

export const workspaceRouter = {
	getFileTree: getFileTreeProcedure,
	getFile: getFileProcedure,
	createFile: createFileProcedure,
	updateFile: updateFileProcedure,
	deleteFile: deleteFileProcedure,
};
