/**
 * Policy Module
 *
 * Handles policy enforcement, validation, and output reflection.
 */

export { applyPolicyEnrichment } from "./apply-policy-enrichment";
// Fabric AI composition integration (Strategy → Context → Pattern)
export {
	applyFabricPatternEnrichment,
	FABRIC_CONTEXTS,
	FABRIC_PATTERNS,
	FABRIC_STRATEGIES,
	type FabricPatternEnrichmentInput,
	type FabricPatternEnrichmentOutput,
	listFabricComponents,
	ORCHESTRATOR_ENRICHMENT_PRESETS,
} from "./fabric-pattern-enrichment";
export { reflectOnOutput } from "./reflect-on-output";
export { validateWithALTK } from "./validate-with-altk";
