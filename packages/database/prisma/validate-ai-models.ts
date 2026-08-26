/**
 * AI Model Validation Script
 *
 * Validates that seeded model IDs are still valid with their providers.
 * This is a hybrid approach:
 * - Database seed is the source of truth for model catalog
 * - This script validates models are still available
 * - Can optionally sync pricing from provider APIs
 *
 * Run with: pnpm --filter @repo/database validate:ai-models
 */

import { logger } from "@repo/logs";
import { db } from "./client";
import type { AIProvider } from "./generated/client";

// ============================================================================
// Provider API Configurations
// ============================================================================

interface ProviderModelInfo {
	id: string;
	name?: string;
	contextWindow?: number;
	inputCostPer1M?: number;
	outputCostPer1M?: number;
}

interface ValidationResult {
	provider: AIProvider;
	modelId: string;
	canonicalName: string;
	status: "valid" | "invalid" | "unknown" | "skipped";
	message?: string;
}

// Providers that have model listing APIs
const _PROVIDERS_WITH_LISTING_API: AIProvider[] = [
	"OPENAI_DIRECT",
	"ANTHROPIC_DIRECT",
	"GROQ",
	"OPENROUTER",
	// Note: VERCEL_GATEWAY doesn't have a listing API - it's a proxy
];

// ============================================================================
// Provider-Specific Model Fetchers
// ============================================================================

async function fetchOpenAIModels(apiKey: string): Promise<ProviderModelInfo[]> {
	try {
		const response = await fetch("https://api.openai.com/v1/models", {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (!response.ok) {
			throw new Error(`OpenAI API error: ${response.status}`);
		}
		const data = await response.json();
		return data.data.map((m: any) => ({
			id: m.id,
			name: m.id,
		}));
	} catch (error) {
		logger.error("Failed to fetch OpenAI models:", error);
		return [];
	}
}

async function fetchAnthropicModels(
	_apiKey: string,
): Promise<ProviderModelInfo[]> {
	// Anthropic doesn't have a public model listing API
	// Return known models based on their documentation
	return [
		{ id: "claude-3-5-sonnet-latest" },
		{ id: "claude-3-5-sonnet-20241022" },
		{ id: "claude-3-5-haiku-latest" },
		{ id: "claude-3-5-haiku-20241022" },
		{ id: "claude-3-opus-latest" },
		{ id: "claude-3-opus-20240229" },
		{ id: "claude-3-sonnet-20240229" },
		{ id: "claude-3-haiku-20240307" },
	];
}

async function fetchGroqModels(apiKey: string): Promise<ProviderModelInfo[]> {
	try {
		const response = await fetch("https://api.groq.com/openai/v1/models", {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (!response.ok) {
			throw new Error(`Groq API error: ${response.status}`);
		}
		const data = await response.json();
		return data.data.map((m: any) => ({
			id: m.id,
			name: m.id,
			contextWindow: m.context_window,
		}));
	} catch (error) {
		logger.error("Failed to fetch Groq models:", error);
		return [];
	}
}

async function fetchOpenRouterModels(): Promise<ProviderModelInfo[]> {
	try {
		// OpenRouter has a public models API (no auth required)
		const response = await fetch("https://openrouter.ai/api/v1/models");
		if (!response.ok) {
			throw new Error(`OpenRouter API error: ${response.status}`);
		}
		const data = await response.json();
		return data.data.map((m: any) => ({
			id: m.id,
			name: m.name,
			contextWindow: m.context_length,
			inputCostPer1M: m.pricing?.prompt
				? Number.parseFloat(m.pricing.prompt) * 1000000
				: undefined,
			outputCostPer1M: m.pricing?.completion
				? Number.parseFloat(m.pricing.completion) * 1000000
				: undefined,
		}));
	} catch (error) {
		logger.error("Failed to fetch OpenRouter models:", error);
		return [];
	}
}

// ============================================================================
// Validation Logic
// ============================================================================

async function validateModelsForProvider(
	provider: AIProvider,
	mappings: Array<{
		providerModelId: string;
		model: { canonicalName: string };
	}>,
	availableModels: ProviderModelInfo[],
): Promise<ValidationResult[]> {
	const results: ValidationResult[] = [];
	const availableIds = new Set(
		availableModels.map((m) => m.id.toLowerCase()),
	);

	for (const mapping of mappings) {
		const modelIdLower = mapping.providerModelId.toLowerCase();
		const isValid = availableIds.has(modelIdLower);

		results.push({
			provider,
			modelId: mapping.providerModelId,
			canonicalName: mapping.model.canonicalName,
			status: isValid ? "valid" : "invalid",
			message: isValid
				? undefined
				: `Model "${mapping.providerModelId}" not found in provider's model list`,
		});
	}

	return results;
}

// ============================================================================
// Main Validation Function
// ============================================================================

export async function validateAiModels(options?: {
	updateAvailability?: boolean;
	syncPricing?: boolean;
}) {
	logger.info("=".repeat(60));
	logger.info("AI Model Validation");
	logger.info("=".repeat(60));

	const results: ValidationResult[] = [];

	// Get all provider mappings from database
	const allMappings = await db.aiModelProviderMapping.findMany({
		include: { model: true },
	});

	// Group by provider
	const mappingsByProvider = allMappings.reduce(
		(acc, mapping) => {
			if (!acc[mapping.provider]) {
				acc[mapping.provider] = [];
			}
			acc[mapping.provider].push(mapping);
			return acc;
		},
		{} as Record<AIProvider, typeof allMappings>,
	);

	// Fetch models from providers and validate
	for (const [provider, mappings] of Object.entries(mappingsByProvider)) {
		const providerKey = provider as AIProvider;
		logger.info(`\nValidating ${provider} (${mappings.length} models)...`);

		let availableModels: ProviderModelInfo[] = [];
		let skipReason: string | undefined;

		switch (providerKey) {
			case "OPENAI_DIRECT": {
				const apiKey = process.env.OPENAI_API_KEY;
				if (apiKey) {
					availableModels = await fetchOpenAIModels(apiKey);
				} else {
					skipReason = "OPENAI_API_KEY not set";
				}
				break;
			}
			case "ANTHROPIC_DIRECT": {
				// Use hardcoded list since Anthropic doesn't have listing API
				availableModels = await fetchAnthropicModels("");
				break;
			}
			case "GROQ": {
				const apiKey = process.env.GROQ_API_KEY;
				if (apiKey) {
					availableModels = await fetchGroqModels(apiKey);
				} else {
					skipReason = "GROQ_API_KEY not set";
				}
				break;
			}
			case "OPENROUTER": {
				// OpenRouter has public API
				availableModels = await fetchOpenRouterModels();
				break;
			}
			case "VERCEL_GATEWAY": {
				// Vercel AI Gateway is a proxy - no model listing API
				// Models are validated through underlying providers
				skipReason =
					"Gateway proxy - validated through underlying providers";
				break;
			}
			default: {
				skipReason = "No validation API available";
			}
		}

		if (skipReason) {
			logger.info(`  Skipped: ${skipReason}`);
			for (const mapping of mappings) {
				results.push({
					provider: providerKey,
					modelId: mapping.providerModelId,
					canonicalName: mapping.model.canonicalName,
					status: "skipped",
					message: skipReason,
				});
			}
			continue;
		}

		logger.info(
			`  Found ${availableModels.length} models from provider API`,
		);

		const providerResults = await validateModelsForProvider(
			providerKey,
			mappings.map((m) => ({
				providerModelId: m.providerModelId,
				model: m.model,
			})),
			availableModels,
		);

		results.push(...providerResults);

		// Log results
		const valid = providerResults.filter((r) => r.status === "valid");
		const invalid = providerResults.filter((r) => r.status === "invalid");

		logger.info(`  ✓ ${valid.length} valid, ✗ ${invalid.length} invalid`);

		for (const inv of invalid) {
			logger.warn(`    ✗ ${inv.canonicalName}: ${inv.message}`);
		}

		// Optionally update availability in database
		if (options?.updateAvailability) {
			for (const result of providerResults) {
				const mapping = mappings.find(
					(m) => m.providerModelId === result.modelId,
				);
				if (mapping) {
					await db.aiModelProviderMapping.update({
						where: { id: mapping.id },
						data: { isAvailable: result.status === "valid" },
					});
				}
			}
		}

		// Optionally sync pricing from OpenRouter
		if (options?.syncPricing && providerKey === "OPENROUTER") {
			logger.info("  Syncing pricing from OpenRouter...");
			for (const mapping of mappings) {
				const modelInfo = availableModels.find(
					(m) =>
						m.id.toLowerCase() ===
						mapping.providerModelId.toLowerCase(),
				);
				if (modelInfo?.inputCostPer1M !== undefined) {
					await db.aiModelProviderMapping.update({
						where: { id: mapping.id },
						data: {
							inputCostPer1M: modelInfo.inputCostPer1M,
							outputCostPer1M: modelInfo.outputCostPer1M,
						},
					});
				}
			}
		}
	}

	// Summary
	logger.info(`\n${"=".repeat(60)}`);
	logger.info("Validation Summary");
	logger.info("=".repeat(60));

	const valid = results.filter((r) => r.status === "valid").length;
	const invalid = results.filter((r) => r.status === "invalid").length;
	const skipped = results.filter((r) => r.status === "skipped").length;

	logger.info(`Total: ${results.length} mappings`);
	logger.info(`  ✓ Valid: ${valid}`);
	logger.info(`  ✗ Invalid: ${invalid}`);
	logger.info(`  ⊘ Skipped: ${skipped}`);

	if (invalid > 0) {
		logger.warn("\nInvalid models that need attention:");
		for (const result of results.filter((r) => r.status === "invalid")) {
			logger.warn(
				`  - ${result.canonicalName} (${result.provider}): ${result.modelId}`,
			);
		}
	}

	return results;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (require.main === module) {
	const args = process.argv.slice(2);
	const updateAvailability = args.includes("--update-availability");
	const syncPricing = args.includes("--sync-pricing");

	validateAiModels({ updateAvailability, syncPricing })
		.then((results) => {
			const hasInvalid = results.some((r) => r.status === "invalid");
			process.exit(hasInvalid ? 1 : 0);
		})
		.catch((error) => {
			logger.error("Validation failed:", error);
			process.exit(1);
		});
}
