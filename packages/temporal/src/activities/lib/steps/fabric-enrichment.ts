/**
 * Fabric AI Enrichment Utility for Workflow Steps
 *
 * Provides Fabric AI Server integration for workflow nodes.
 * Uses Strategy → Context → Pattern composition to enhance prompts.
 *
 * This is the shared primitive used by:
 * - Workflow ai-generate-text nodes
 * - Workflow ai-generate-image nodes (for prompt enhancement)
 * - Template instance execution
 * - Orchestrator
 */

import {
	type ComposeResult,
	composeFabricPrompt,
	detectAndCompose,
	detectFabricComponents,
	isFabricAvailable,
} from "@repo/agent-core";

export interface FabricEnrichmentConfig {
	/** Strategy for reasoning methodology (cot, tot, reflexion) */
	fabricStrategy?: string;
	/** Context for identity/expertise (security_expert, senior_dev) */
	fabricContext?: string;
	/** Pattern for task execution (summarize, review_code) */
	fabricPattern?: string;
	/** Variables to inject into patterns */
	fabricVariables?: Record<string, string>;
	/** Enable auto-detection from prompt content (default: true) */
	fabricAutoDetect?: boolean;
}

export interface EnrichedPromptResult {
	/** The enriched system prompt (may include strategy, context, pattern) */
	systemPrompt: string;
	/** Components that were applied */
	components: {
		strategy: string | null;
		context: string | null;
		pattern: string | null;
	};
	/** Whether Fabric AI was used */
	fabricUsed: boolean;
	/** Original base prompt if enrichment failed */
	fallbackUsed: boolean;
}

/**
 * Apply Fabric AI enrichment to a prompt.
 *
 * This function:
 * 1. Checks if Fabric AI Server is available
 * 2. Either uses explicit components or auto-detects from the prompt
 * 3. Composes the final system prompt with Strategy → Context → Pattern
 * 4. Falls back to basePrompt if Fabric AI is unavailable
 *
 * @param userPrompt - The user's prompt (used for auto-detection)
 * @param config - Fabric enrichment configuration from node config
 * @param baseSystemPrompt - Optional base system prompt to prepend
 */
export async function applyFabricEnrichment(
	userPrompt: string,
	config: FabricEnrichmentConfig,
	baseSystemPrompt?: string,
): Promise<EnrichedPromptResult> {
	const {
		fabricStrategy,
		fabricContext,
		fabricPattern,
		fabricVariables,
		fabricAutoDetect = true,
	} = config;

	// Check if any Fabric config is specified or auto-detect is enabled
	const hasExplicitConfig = fabricStrategy || fabricContext || fabricPattern;
	const shouldEnrich = hasExplicitConfig || fabricAutoDetect;

	if (!shouldEnrich) {
		return {
			systemPrompt: baseSystemPrompt || "",
			components: { strategy: null, context: null, pattern: null },
			fabricUsed: false,
			fallbackUsed: false,
		};
	}

	try {
		// Check Fabric AI availability
		const available = await isFabricAvailable();
		if (!available) {
			console.log(
				"[FabricEnrichment] Fabric AI Server not available, using fallback",
			);
			return {
				systemPrompt: baseSystemPrompt || "",
				components: { strategy: null, context: null, pattern: null },
				fabricUsed: false,
				fallbackUsed: true,
			};
		}

		let result: ComposeResult;

		if (hasExplicitConfig) {
			// Use explicitly specified components, with auto-detection filling gaps
			let strategy = fabricStrategy;
			let context = fabricContext;
			let pattern = fabricPattern;

			if (fabricAutoDetect) {
				const detected = detectFabricComponents(userPrompt);
				strategy = strategy || detected.strategy;
				context = context || detected.context;
				pattern = pattern || detected.pattern;
			}

			result = await composeFabricPrompt({
				basePrompt: baseSystemPrompt,
				strategy,
				context,
				pattern,
				variables: fabricVariables,
			});
		} else {
			// Pure auto-detection from user prompt
			result = await detectAndCompose({
				userMessage: userPrompt,
				basePrompt: baseSystemPrompt,
			});
		}

		console.log("[FabricEnrichment] Applied composition", {
			components: result.components,
			promptLength: result.prompt.length,
		});

		return {
			systemPrompt: result.prompt,
			components: result.components,
			fabricUsed: result.fabricAvailable,
			fallbackUsed: !result.fabricAvailable,
		};
	} catch (error) {
		console.error("[FabricEnrichment] Error applying enrichment:", error);
		return {
			systemPrompt: baseSystemPrompt || "",
			components: { strategy: null, context: null, pattern: null },
			fabricUsed: false,
			fallbackUsed: true,
		};
	}
}

/**
 * Normalize a Fabric config value - treat "auto", "", null as undefined
 * This allows auto-detection to kick in when user selects "Auto-detect" in UI
 */
function normalizeFabricValue(value: unknown): string | undefined {
	if (
		value === "auto" ||
		value === "" ||
		value === null ||
		value === undefined
	) {
		return undefined;
	}
	return value as string;
}

/**
 * Extract Fabric enrichment config from node configuration.
 * This normalizes different config formats that might be used.
 * Values of "auto", "", null are treated as undefined to enable auto-detection.
 */
export function extractFabricConfig(
	nodeConfig: Record<string, unknown>,
): FabricEnrichmentConfig {
	// Check for nested fabricConfig object
	const fabricConfig = nodeConfig.fabricConfig as
		| Record<string, unknown>
		| undefined;
	if (fabricConfig) {
		return {
			fabricStrategy: normalizeFabricValue(fabricConfig.strategy),
			fabricContext: normalizeFabricValue(fabricConfig.context),
			fabricPattern: normalizeFabricValue(fabricConfig.pattern),
			fabricVariables: fabricConfig.variables as
				| Record<string, string>
				| undefined,
			fabricAutoDetect: fabricConfig.autoDetect as boolean | undefined,
		};
	}

	// Check for flat config properties
	return {
		fabricStrategy: normalizeFabricValue(nodeConfig.fabricStrategy),
		fabricContext: normalizeFabricValue(nodeConfig.fabricContext),
		fabricPattern: normalizeFabricValue(nodeConfig.fabricPattern),
		fabricVariables: nodeConfig.fabricVariables as
			| Record<string, string>
			| undefined,
		fabricAutoDetect: nodeConfig.fabricAutoDetect as boolean | undefined,
	};
}
