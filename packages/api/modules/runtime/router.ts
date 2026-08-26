/**
 * Runtime API Router
 *
 * Provides endpoints for agents to:
 * - Authenticate via API key
 * - Resolve model configuration
 * - Load agent configuration
 *
 * These endpoints replace direct database access in agents,
 * keeping agents stateless and self-contained.
 */

import { getAgentProcedure } from "./procedures/get-agent";
import { resolveModelProcedure } from "./procedures/resolve-model";
import { resolveTenantProcedure } from "./procedures/resolve-tenant";

export const runtimeRouter = {
	// Tenant resolution (API key validation)
	resolveTenant: resolveTenantProcedure,

	// Model resolution (get model config with API key)
	resolveModel: resolveModelProcedure,

	// Agent configuration
	getAgent: getAgentProcedure,
};
