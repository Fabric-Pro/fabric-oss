import { agentsProcedures } from "./procedures/agents";
import { bindProcedures } from "./procedures/bind";
import { browseProcedures } from "./procedures/browse";
import { catalogProcedures } from "./procedures/catalog";
import { createProcedure } from "./procedures/create";
import { deleteProcedure } from "./procedures/delete";
import { forkProcedures } from "./procedures/fork";
import { getProcedures } from "./procedures/get";
import {
	categoriesProcedure,
	listProcedure,
	tagsProcedure,
} from "./procedures/list";
import { nominateProcedures } from "./procedures/nominate";
import { renderProcedure } from "./procedures/render";
import { testProcedures } from "./procedures/test";
import { updateProcedure } from "./procedures/update";
import { versionProcedures } from "./procedures/version";

export const promptsRouter = {
	// Existing procedures
	browse: browseProcedures,
	fork: forkProcedures,
	version: versionProcedures,
	bind: bindProcedures,
	catalog: catalogProcedures,
	nominations: nominateProcedures,
	test: testProcedures,
	get: getProcedures,

	// New CRUD procedures
	list: listProcedure,
	categories: categoriesProcedure,
	tags: tagsProcedure,
	create: createProcedure,
	update: updateProcedure,
	delete: deleteProcedure,
	render: renderProcedure,

	// Agent-specific procedures
	agents: agentsProcedures,
};
