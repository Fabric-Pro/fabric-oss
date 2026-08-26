/**
 * Data Connections Router
 *
 * Routes for managing external data connections for RAG integration.
 */

import { createProcedure } from "./procedures/create";
import { credentialsProcedures } from "./procedures/credentials";
import { deleteProcedure } from "./procedures/delete";
import { getProcedure } from "./procedures/get";
import { linkFromWorkflowIntegrationProcedure } from "./procedures/link-workflow-integration";
import { listProcedure } from "./procedures/list";
import { notionProcedures } from "./procedures/notion";
import { resourcesProcedures } from "./procedures/resources";
import { scheduleProcedures } from "./procedures/schedule";
import { syncProcedures } from "./procedures/sync";
import { updateProcedure } from "./procedures/update";

export const dataConnectionsRouter = {
	// Core CRUD
	list: listProcedure,
	get: getProcedure,
	create: createProcedure,
	update: updateProcedure,
	delete: deleteProcedure,
	linkWorkflow: linkFromWorkflowIntegrationProcedure,

	// Sync operations
	sync: syncProcedures,

	// Resource management
	resources: resourcesProcedures,

	// Schedule management
	schedule: scheduleProcedures,

	// Reusable connector credentials
	credentials: credentialsProcedures,

	// Notion-specific operations
	notion: notionProcedures,
};
