import { agentsProcedures } from "./procedures/agents";
import { bindProcedures } from "./procedures/bind";
import { browseProcedures } from "./procedures/browse";
import { catalogProcedures } from "./procedures/catalog";
import { createProcedure } from "./procedures/create";
import { deleteProcedure } from "./procedures/delete";
import { deletionImpactProcedure } from "./procedures/deletion-impact";
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
	// Not `bind`. oRPC 1.15 added RECURSIVE_CLIENT_UNWRAP_KEYS to the recursive
	// proxy client, so `client.prompts.bind` now returns `Function.prototype.bind`
	// instead of descending into the router — every call under it would throw at
	// runtime. `valueOf`, `toString` and `toJSON` are reserved the same way.
	// TypeScript cannot catch this: to tsc the key is still a valid router key.
	// The REST paths in `procedures/bind.ts` are declared explicitly and are
	// unaffected, so the public HTTP surface still reads `/prompts/bind`.
	bindings: bindProcedures,
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
	// Platform-wide, tenant-unscoped preview of what `delete` would remove.
	// Gated by the deletion's own authority and SYSTEM-only — see the procedure.
	deletionImpact: deletionImpactProcedure,
	render: renderProcedure,

	// Agent-specific procedures
	agents: agentsProcedures,
};
