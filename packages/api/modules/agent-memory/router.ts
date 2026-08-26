/**
 * Agent Memory Router
 *
 * Virtual filesystem API for agent memory (COALA framework).
 * Supports procedural, semantic, and episodic memory operations.
 */

import { approveEditProcedure } from "./procedures/approve-edit";
import { deleteFileProcedure } from "./procedures/delete-file";
import { exportMemoryProcedure } from "./procedures/export-memory";
import { importMemoryProcedure } from "./procedures/import-memory";
import { initializeMemoryProcedure } from "./procedures/initialize-memory";
import { listEditsProcedure } from "./procedures/list-edits";
import { listFilesProcedure } from "./procedures/list-files";
import { loadContextProcedure } from "./procedures/load-context";
import { readFileProcedure } from "./procedures/read-file";
import { rejectEditProcedure } from "./procedures/reject-edit";
import { searchFilesProcedure } from "./procedures/search-files";
import { writeFileProcedure } from "./procedures/write-file";

export const agentMemoryRouter = {
	// File operations
	files: {
		list: listFilesProcedure,
		read: readFileProcedure,
		write: writeFileProcedure,
		delete: deleteFileProcedure,
		search: searchFilesProcedure,
	},

	// Edit/approval operations (HITL)
	edits: {
		list: listEditsProcedure,
		approve: approveEditProcedure,
		reject: rejectEditProcedure,
	},

	// Batch operations
	initialize: initializeMemoryProcedure,
	export: exportMemoryProcedure,
	import: importMemoryProcedure,

	// Context loading (for execution)
	loadContext: loadContextProcedure,
};
