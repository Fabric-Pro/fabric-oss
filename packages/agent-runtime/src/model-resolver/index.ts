/**
 * Model Resolver Module
 *
 * Provides multi-tenant model resolution utilities.
 *
 * NOTE: LangChain model *creation* for agents lives in
 * `@repo/agent-core` (`createProviderModel` / `getAgentModelAsync`).
 * That single factory covers every provider (incl. Databricks, Azure,
 * gateways, reasoning models); do not reintroduce a parallel factory here.
 */

// API key resolution
export {
	hasAnyScope,
	hasScope,
	resolveApiKeyToTenant,
} from "./api-key-resolver";

// Model configuration resolution
export { clearConfigCache, resolveModelConfig } from "./model-config-resolver";
