/**
 * Fabric Pattern Enrichment Activity
 *
 * Enhances orchestrator prompts using Fabric AI's Strategy → Context → Pattern composition.
 * This implements the same composition model used by the Fabric CLI.
 *
 * Composition Order:
 * 1. STRATEGY - Controls reasoning methodology ("How should I think?")
 *    Examples: cot (Chain-of-Thought), tot (Tree-of-Thoughts), reflexion
 *
 * 2. CONTEXT - Controls identity/expertise ("Who am I?")
 *    Examples: security_expert, senior_dev, technical_writer
 *
 * 3. PATTERN - Controls task execution ("What should I do?")
 *    Examples: summarize, extract_wisdom, find_vulnerabilities
 *
 * Final System Message = <strategy>\n<context>\n<pattern>
 */

import {
	type ComposeResult,
	composeFabricPrompt,
	detectAndCompose,
	detectFabricComponents,
	FABRIC_CONTEXTS,
	FABRIC_PATTERNS,
	FABRIC_STRATEGIES,
	type FabricStrategy,
	isFabricAvailable,
	listContexts,
	listPatterns,
	listStrategies,
} from "@repo/agent-core";
import { logger } from "@repo/logs";

export interface FabricPatternEnrichmentInput {
	/** User message to analyze for auto-detection */
	message: string;
	userId: string;
	organizationId?: string;
	/** Force specific strategy (skips auto-detection) */
	strategy?: string;
	/** Force specific context/persona (skips auto-detection) */
	context?: string;
	/** Force specific pattern (skips auto-detection) */
	pattern?: string;
	/** Base system prompt to prepend */
	basePrompt?: string;
	/** Variables to inject into the pattern */
	variables?: Record<string, string>;
	/** Whether to enable auto-detection based on message (default: true) */
	enableAutoDetection?: boolean;
}

export interface FabricPatternEnrichmentOutput {
	/** Composed system prompt (strategy + context + pattern) */
	composedPrompt: string;
	/** Components that were used */
	components: {
		strategy: string | null;
		context: string | null;
		pattern: string | null;
	};
	/** Whether Fabric AI was available */
	fabricAvailable: boolean;
	/** Cache hit information for performance tracking */
	cacheHits: {
		strategy: boolean;
		context: boolean;
		pattern: boolean;
	};
	/** Error message if any */
	error?: string;
}

/**
 * Enriches orchestrator prompts with Fabric AI's Strategy → Context → Pattern composition.
 *
 * This activity can be called during the initialization phase to enhance
 * system prompts based on the user's request.
 *
 * Auto-detection rules:
 * - Security keywords → security_expert context + find_vulnerabilities pattern + cot strategy
 * - Code review keywords → senior_dev context + review_code pattern
 * - Analysis keywords → analyze_claims pattern + cot strategy
 * - etc.
 */
export async function applyFabricPatternEnrichment(
	input: FabricPatternEnrichmentInput,
): Promise<FabricPatternEnrichmentOutput> {
	logger.debug("[FabricPattern] Checking for Fabric composition", {
		userId: input.userId,
		strategy: input.strategy,
		context: input.context,
		pattern: input.pattern,
		enableAutoDetection: input.enableAutoDetection ?? true,
	});

	try {
		// Check availability first
		const available = await isFabricAvailable();
		if (!available) {
			logger.warn("[FabricPattern] Fabric AI server is not available");
			return {
				composedPrompt: input.basePrompt || "",
				components: { strategy: null, context: null, pattern: null },
				fabricAvailable: false,
				cacheHits: { strategy: false, context: false, pattern: false },
				error: "Fabric AI server is not available",
			};
		}

		let result: ComposeResult;

		if (
			input.enableAutoDetection !== false &&
			!input.strategy &&
			!input.context &&
			!input.pattern
		) {
			// Auto-detect components from message
			result = await detectAndCompose({
				userMessage: input.message,
				basePrompt: input.basePrompt,
			});

			const detected = detectFabricComponents(input.message);
			const hasDetection =
				detected.strategy || detected.context || detected.pattern;
			logger[hasDetection ? "info" : "debug"](
				"[FabricPattern] Auto-detection result",
				{
					detected,
					used: result.components,
				},
			);
		} else {
			// Use explicit components (with auto-detection for missing ones if enabled)
			if (input.enableAutoDetection !== false) {
				const detected = detectFabricComponents(input.message);
				result = await composeFabricPrompt({
					basePrompt: input.basePrompt,
					strategy: input.strategy || detected.strategy,
					context: input.context || detected.context,
					pattern: input.pattern || detected.pattern,
					variables: input.variables,
				});
			} else {
				result = await composeFabricPrompt({
					basePrompt: input.basePrompt,
					strategy: input.strategy,
					context: input.context,
					pattern: input.pattern,
					variables: input.variables,
				});
			}
		}

		const hasComposition =
			result.components.strategy ||
			result.components.context ||
			result.components.pattern;
		logger[hasComposition ? "info" : "debug"](
			"[FabricPattern] Composition complete",
			{
				components: result.components,
				cacheHits: result.cacheHits,
				promptLength: result.prompt.length,
			},
		);

		return {
			composedPrompt: result.prompt,
			components: result.components,
			fabricAvailable: result.fabricAvailable,
			cacheHits: result.cacheHits,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		logger.error("[FabricPattern] Failed to apply composition", {
			error: errorMessage,
		});

		return {
			composedPrompt: input.basePrompt || "",
			components: { strategy: null, context: null, pattern: null },
			fabricAvailable: false,
			cacheHits: { strategy: false, context: false, pattern: false },
			error: errorMessage,
		};
	}
}

/**
 * Lists available Fabric components for UI display.
 */
export async function listFabricComponents(): Promise<{
	available: boolean;
	patterns: string[];
	contexts: string[];
	strategies: FabricStrategy[];
}> {
	try {
		const available = await isFabricAvailable();
		if (!available) {
			return {
				available: false,
				patterns: [],
				contexts: [],
				strategies: [],
			};
		}

		const [patterns, contexts, strategies] = await Promise.all([
			listPatterns(),
			listContexts(),
			listStrategies(),
		]);

		return { available: true, patterns, contexts, strategies };
	} catch {
		return { available: false, patterns: [], contexts: [], strategies: [] };
	}
}

/**
 * Pre-defined enrichment presets for common orchestrator scenarios.
 */
export const ORCHESTRATOR_ENRICHMENT_PRESETS = {
	/** Security analysis with expert persona and step-by-step reasoning */
	securityAnalysis: {
		strategy: FABRIC_STRATEGIES.COT,
		context: FABRIC_CONTEXTS.SECURITY_EXPERT,
		pattern: FABRIC_PATTERNS.FIND_VULNERABILITIES,
	},

	/** Code review with senior developer perspective */
	codeReview: {
		context: FABRIC_CONTEXTS.SENIOR_DEV,
		pattern: FABRIC_PATTERNS.REVIEW_CODE,
	},

	/** Complex planning with tree-of-thoughts reasoning */
	complexPlanning: {
		strategy: FABRIC_STRATEGIES.TOT,
		pattern: FABRIC_PATTERNS.CREATE_DESIGN_DOCUMENT,
	},

	/** Simple summarization */
	summarize: {
		pattern: FABRIC_PATTERNS.SUMMARIZE,
	},

	/** Deep analysis with chain-of-thought */
	deepAnalysis: {
		strategy: FABRIC_STRATEGIES.COT,
		pattern: FABRIC_PATTERNS.ANALYZE_CLAIMS,
	},

	/** Feature breakdown */
	storyBreakdown: {
		context: FABRIC_CONTEXTS.PRODUCT_MANAGER,
		pattern: FABRIC_PATTERNS.AGILITY_STORY,
	},
} as const;

// Re-export constants for convenience
export { FABRIC_PATTERNS, FABRIC_CONTEXTS, FABRIC_STRATEGIES };
