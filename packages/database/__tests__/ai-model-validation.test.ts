/**
 * AI Model Name Validation Tests
 *
 * This test suite validates that our seeded AI model names match the official
 * model IDs from each provider's documentation.
 *
 * IMPORTANT: This is a static validation - it doesn't require API keys.
 * It compares our seed data against known official model names.
 *
 * Run with: pnpm --filter @repo/database test:ai-models
 *
 * Official Documentation Sources:
 * - OpenAI: https://platform.openai.com/docs/models
 * - Anthropic: https://docs.anthropic.com/en/docs/about-claude/models
 * - Groq: https://console.groq.com/docs/models
 * - Cerebras: https://inference-docs.cerebras.ai/introduction
 * - DeepSeek: https://platform.deepseek.com/api-docs/models
 * - Vercel AI Gateway: https://sdk.vercel.ai/providers/ai-sdk-providers
 * - Together AI: https://docs.together.ai/docs/models
 * - Fireworks: https://docs.fireworks.ai/models
 * - Mistral: https://docs.mistral.ai/getting-started/models/
 * - xAI: https://docs.x.ai/docs/models
 * - Perplexity: https://docs.perplexity.ai/docs/model-cards
 * - OpenRouter: https://openrouter.ai/models
 */

import { describe, expect, it } from "vitest";
import { MODELS } from "../prisma/ai-model-catalog";
import type { AIProvider } from "../prisma/generated/client";

// ============================================================================
// Official Model Names Per Provider
// These are the canonical model IDs as documented by each provider
// Last updated: January 2026
// ============================================================================

/**
 * OpenAI Direct API Official Model IDs
 * Source: https://platform.openai.com/docs/models
 */
const OPENAI_DIRECT_OFFICIAL_MODELS = new Set([
	// GPT-5 series
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.2",
	"gpt-5-nano",
	"gpt-5-mini",

	// GPT-4o series
	"gpt-4o",
	"gpt-4o-2024-11-20",
	"gpt-4o-2024-08-06",
	"gpt-4o-2024-05-13",
	"gpt-4o-mini",
	"gpt-4o-mini-2024-07-18",

	// GPT-4 Turbo
	"gpt-4-turbo",
	"gpt-4-turbo-2024-04-09",
	"gpt-4-turbo-preview",

	// Reasoning models (o-series)
	"o1",
	"o1-2024-12-17",
	"o1-mini",
	"o1-mini-2024-09-12",
	"o3-mini",
	"o3-mini-2025-01-31",

	// Embeddings
	"text-embedding-3-small",
	"text-embedding-3-large",
	"text-embedding-ada-002",

	// Audio
	"whisper-1",
	"tts-1",
	"tts-1-hd",

	// Image
	"dall-e-3",
	"dall-e-2",
	"gpt-image-2",
]);

/**
 * Anthropic Direct API Official Model IDs
 * Source: https://docs.anthropic.com/en/docs/about-claude/models
 *
 * Note: Claude 4 models use format claude-{tier}-4-5 (e.g., claude-sonnet-4-5)
 * Claude 3.5 models were retired in late 2025
 */
const ANTHROPIC_DIRECT_OFFICIAL_MODELS = new Set([
	// Claude 4.8 series (current)
	"claude-opus-4-8",
	// Claude 4.7 series
	"claude-opus-4-7",
	// Claude 5 series
	"claude-sonnet-5",
	// Claude 4.6 series
	"claude-sonnet-4-6",
	"claude-opus-4-6",
	// Claude 4.5 series
	"claude-opus-4-5-20251101",
	"claude-sonnet-4-5-20250929",
	"claude-haiku-4-5-20251001",
	// Aliases
	"claude-opus-4-5",
	"claude-sonnet-4-5",
	"claude-haiku-4-5",
]);

/**
 * Groq Official Model IDs
 * Source: https://console.groq.com/docs/models
 *
 * Note: Groq model IDs use various formats:
 * - Standard: llama-3.3-70b-versatile
 * - With vendor prefix: meta-llama/llama-4-scout-17b-16e-instruct
 * - OpenAI models: openai/gpt-oss-120b (with slash)
 */
const GROQ_OFFICIAL_MODELS = new Set([
	// Llama 3.3
	"llama-3.3-70b-versatile",
	"llama-3.3-70b-specdec",

	// Llama 3.1
	"llama-3.1-70b-versatile",
	"llama-3.1-8b-instant",

	// Llama 4 Scout
	"meta-llama/llama-4-scout-17b-16e-instruct",

	// Llama Guard
	"meta-llama/llama-guard-4-12b",

	// DeepSeek R1 distilled
	"deepseek-r1-distill-llama-70b",

	// Groq Compound AI
	"compound-beta",
	"compound-beta-mini",

	// Qwen
	"qwen-qwq-32b",

	// GPT OSS models (OpenAI open-source via Groq)
	"openai/gpt-oss-120b",
	"openai/gpt-oss-20b",

	// Whisper
	"whisper-large-v3",
	"whisper-large-v3-turbo",
	"distil-whisper-large-v3-en",
]);

/**
 * Cerebras Official Model IDs
 * Source: https://inference-docs.cerebras.ai/introduction
 */
const CEREBRAS_OFFICIAL_MODELS = new Set([
	// Production models (from inference-docs.cerebras.ai/models/overview)
	"llama3.1-8b", // Llama 3.1 8B
	"llama-3.3-70b", // Llama 3.3 70B
	"gpt-oss-120b", // OpenAI GPT OSS
	"qwen-3-32b", // Qwen 3 32B

	// Preview models (may be discontinued)
	"qwen-3-235b-a22b-instruct-2507",
	"zai-glm-4.6",
	"zai-glm-4.7",
]);

/**
 * DeepSeek Official Model IDs
 * Source: https://platform.deepseek.com/api-docs/models
 */
const DEEPSEEK_OFFICIAL_MODELS = new Set([
	"deepseek-chat", // V3 general chat
	"deepseek-reasoner", // R1 reasoning model
	"deepseek-coder", // Code-specific
]);

/**
 * Vercel AI Gateway Model Format
 * Format: vendor/model-name (normalized across all backend providers)
 * Source: https://sdk.vercel.ai/providers/ai-sdk-providers
 *
 * IMPORTANT: Vercel normalizes model IDs to vendor/model format regardless of
 * which backend provider serves them. There is NO groq/ prefix.
 *
 * Examples from Vercel dashboard:
 * - openai/gpt-4o, openai/gpt-oss-120b
 * - anthropic/claude-sonnet-4.5 (hyphen before version)
 * - meta/llama-3.3-70b (NOT groq/llama-3.3-70b-versatile)
 */
const VERCEL_GATEWAY_OFFICIAL_MODELS = new Set([
	// OpenAI models (from Vercel dashboard)
	"openai/gpt-5.5",
	"openai/gpt-5.4",
	"openai/gpt-5.2",
	"openai/gpt-5-nano",
	"openai/gpt-5-mini",
	"openai/gpt-4o",
	"openai/gpt-4o-mini",
	"openai/gpt-4-turbo",
	"openai/gpt-4.1",
	"openai/gpt-4.1-mini",
	"openai/gpt-4.1-nano",
	"openai/gpt-3.5-turbo",
	"openai/gpt-3.5-turbo-instruct",
	"openai/o1",
	"openai/o1-mini",
	"openai/o3",
	"openai/o3-mini",
	"openai/o3-pro",
	"openai/o4-mini",
	"openai/text-embedding-3-small",
	"openai/text-embedding-3-large",
	"openai/text-embedding-ada-002",
	"openai/whisper-1",
	"openai/dall-e-3",
	"openai/gpt-image-2",
	"openai/gpt-oss-120b",
	"openai/gpt-oss-20b",
	"openai/codex-mini",

	// Anthropic models (from Vercel dashboard)
	"anthropic/claude-opus-4.8",
	"anthropic/claude-opus-4.7",
	"anthropic/claude-sonnet-5",
	"anthropic/claude-sonnet-4-6",
	"anthropic/claude-opus-4-6",
	"anthropic/claude-sonnet-4.5",
	"anthropic/claude-haiku-4.5",
	"anthropic/claude-opus-4.5",
	"anthropic/claude-sonnet-4",
	"anthropic/claude-opus-4",
	"anthropic/claude-opus-4.1",
	"anthropic/claude-3.7-sonnet",
	"anthropic/claude-3.5-haiku",
	"anthropic/claude-3-haiku",

	// Google models
	"google/gemini-3.1-flash-image-preview",
	"google/gemini-3-flash-preview",
	"google/gemini-3-pro-image",
	"google/gemini-3.1-pro-preview",

	// Meta Llama models (served via Groq but uses meta/ prefix)
	"meta/llama-3.3-70b",
	"meta/llama-3.1-8b",
	"meta/llama-4-scout",

	// Alibaba Qwen models
	"alibaba/qwen-3-32b",

	// DeepSeek models
	"deepseek/deepseek-chat",
	"deepseek/deepseek-reasoner",

	// Mistral models
	"mistral/mistral-large-latest",
	"mistral/mistral-small-latest",
]);

/**
 * OpenRouter Official Model IDs
 * Source: https://openrouter.ai/models
 * Format: vendor/model-name
 */
const OPENROUTER_OFFICIAL_MODELS = new Set([
	// OpenAI
	"openai/gpt-5.5",
	"openai/gpt-5.4",
	"openai/gpt-5.2",
	"openai/gpt-5-nano",
	"openai/gpt-5-mini",
	"openai/gpt-4o",
	"openai/gpt-4o-mini",
	"openai/gpt-4-turbo",
	"openai/o1",
	"openai/o1-mini",
	"openai/o3-mini",

	// Anthropic
	"anthropic/claude-opus-4.8",
	"anthropic/claude-opus-4.7",
	"anthropic/claude-sonnet-5",
	"anthropic/claude-sonnet-4-6",
	"anthropic/claude-opus-4-6",
	"anthropic/claude-opus-4.5",
	"anthropic/claude-sonnet-4.5",
	"anthropic/claude-haiku-4.5",

	// Meta
	"meta-llama/llama-3.3-70b-instruct",
	"meta-llama/llama-3.1-8b-instruct",

	// DeepSeek
	"deepseek/deepseek-chat",
	"deepseek/deepseek-r1",

	// Google
	"google/gemini-2.5-pro",
	"google/gemini-2.5-flash",
	"google/gemini-3-flash-preview",
	"google/gemini-3.1-pro-preview",
	"google/gemini-2.0-flash-001",
	"google/gemini-pro-1.5",
	"google/gemini-flash-1.5",

	// Mistral
	"mistralai/mistral-large",
	"mistralai/mistral-small",
	"mistralai/codestral-latest",
	"mistralai/magistral-medium",
	"mistralai/magistral-small",
	"mistralai/ministral-8b",
	"mistralai/devstral-latest",

	// xAI Grok
	"x-ai/grok-4-1-fast-reasoning",
	"x-ai/grok-4-fast-reasoning",
	"x-ai/grok-4-0709",
	"x-ai/grok-3",
	"x-ai/grok-3-mini",
	"x-ai/grok-2-vision-1212",
	"x-ai/grok-code-fast-1",

	// Perplexity
	"perplexity/sonar",
	"perplexity/sonar-pro",
	"perplexity/sonar-reasoning",
	"perplexity/sonar-reasoning-pro",

	// Cohere
	"cohere/command-a",
	"cohere/command-r-plus",
	"cohere/command-r",
	"cohere/command-r7b",
]);

/**
 * Together AI Official Model IDs
 * Source: https://docs.together.ai/docs/models
 */
const TOGETHER_AI_OFFICIAL_MODELS = new Set([
	// Meta Llama models
	"meta-llama/Llama-3.3-70B-Instruct-Turbo",
	"meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
	"meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
	"meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
	// DeepSeek models
	"deepseek-ai/DeepSeek-V3",
	"deepseek-ai/DeepSeek-R1",
]);

/**
 * Fireworks AI Official Model IDs
 * Source: https://docs.fireworks.ai/models
 */
const FIREWORKS_OFFICIAL_MODELS = new Set([
	// Meta Llama models
	"accounts/fireworks/models/llama-v3p3-70b-instruct",
	"accounts/fireworks/models/llama-v3p1-8b-instruct",
	"accounts/fireworks/models/llama-v3p1-70b-instruct",
	// DeepSeek models
	"accounts/fireworks/models/deepseek-v3",
	"accounts/fireworks/models/deepseek-r1",
]);

/**
 * Cohere Official Model IDs
 * Source: https://docs.cohere.com/docs/models
 */
const COHERE_OFFICIAL_MODELS = new Set([
	// Command A family
	"command-a-03-2025",
	"command-a-reasoning-08-2025",
	"command-a-vision-07-2025",
	"command-a-translate-08-2025",
	// Command R family
	"command-r-plus-08-2024",
	"command-r-08-2024",
	"command-r7b-12-2024",
	// Embeddings
	"embed-v4.0",
	"embed-english-v3.0",
	"embed-english-light-v3.0",
	"embed-multilingual-v3.0",
	"embed-multilingual-light-v3.0",
	// Reranking
	"rerank-v4.0-pro",
	"rerank-v4.0-fast",
	"rerank-v3.5",
	"rerank-english-v3.0",
	"rerank-multilingual-v3.0",
]);

/**
 * Mistral AI Official Model IDs
 * Source: https://docs.mistral.ai/getting-started/models/
 */
const MISTRAL_AI_OFFICIAL_MODELS = new Set([
	// Large models
	"mistral-large-latest",
	"mistral-large-2411",
	"mistral-large-3-25-12",
	// Small models
	"mistral-small-latest",
	"mistral-small-2409",
	"mistral-small-3-2-25-06",
	// Reasoning models (Magistral)
	"magistral-medium-latest",
	"magistral-medium-2506",
	"magistral-small-2506",
	// Code models
	"codestral-latest",
	"codestral-2405",
	"codestral-25-08",
	"devstral-latest",
	"devstral-2-25-12",
	// Edge models (Ministral)
	"ministral-8b-latest",
	"ministral-3b-latest",
	"ministral-3-14b-25-12",
	"ministral-3-8b-25-12",
	"ministral-3-3b-25-12",
	// Embeddings
	"mistral-embed",
	"mistral-embed-23-12",
]);

/**
 * xAI (Grok) Official Model IDs
 * Source: https://docs.x.ai/docs/models
 */
const XAI_OFFICIAL_MODELS = new Set([
	// Grok 4.1 series (2M context)
	"grok-4-1-fast-reasoning",
	"grok-4-1-fast-non-reasoning",
	// Grok 4 series (2M context for fast, 256K for base)
	"grok-4-fast-reasoning",
	"grok-4-fast-non-reasoning",
	"grok-4-0709",
	// Grok 3 series (131K context)
	"grok-3",
	"grok-3-mini",
	// Grok 2 series
	"grok-2-vision-1212",
	"grok-2-image-1212",
	// Code model
	"grok-code-fast-1",
]);

/**
 * Perplexity Official Model IDs
 * Source: https://docs.perplexity.ai/docs/model-cards
 */
const PERPLEXITY_OFFICIAL_MODELS = new Set([
	// Search models
	"sonar",
	"sonar-pro",
	// Reasoning models
	"sonar-reasoning",
	"sonar-reasoning-pro",
	// Research models
	"sonar-deep-research",
]);

/**
 * Google Vertex AI Official Model IDs
 * Source: https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference
 */
const GOOGLE_VERTEX_AI_OFFICIAL_MODELS = new Set([
	"gemini-2.5-pro",
	"gemini-2.5-flash",
	"gemini-3-flash-preview",
	"gemini-3.1-pro-preview",
	"gemini-2.0-flash-001",
	"gemini-1.5-pro-002",
	"gemini-1.5-flash-002",
	"gemini-1.5-pro-001",
	"gemini-1.5-flash-001",
]);

/**
 * Azure AI Foundry (Azure OpenAI) Model IDs
 * Note: Azure uses deployment names, but these are typical model IDs
 * Source: https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models
 */
const AZURE_AI_FOUNDRY_OFFICIAL_MODELS = new Set([
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.2",
	"gpt-5-nano",
	"gpt-5-mini",
	"gpt-4o",
	"gpt-4o-mini",
	"gpt-4.1-mini", // Azure-specific deployment
	"gpt-4-turbo",
	"text-embedding-3-small",
	"text-embedding-3-large",
	"text-embedding-ada-002",
]);

/**
 * AWS Bedrock Model IDs
 * Source: https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html
 */
const AWS_BEDROCK_OFFICIAL_MODELS = new Set([
	// Anthropic
	"anthropic.claude-opus-4-8",
	"anthropic.claude-opus-4-7",
	"anthropic.claude-opus-4-6-v1",
	"anthropic.claude-opus-4-5-20251101-v1:0",
	"anthropic.claude-sonnet-4-5-20250929-v1:0",
	"anthropic.claude-haiku-4-5-20251001-v1:0",

	// Meta
	"meta.llama3-3-70b-instruct-v1:0",
	"meta.llama3-1-70b-instruct-v1:0",
	"meta.llama3-1-8b-instruct-v1:0",
]);

// Databricks Foundation Model API serving-endpoint names (stable across
// workspaces). Custom per-workspace endpoints are discovered dynamically at
// runtime and intentionally not enumerated here.
// Unity AI Gateway model-service names (system.ai schema). Custom per-workspace
// services are discovered dynamically and intentionally not enumerated here.
const DATABRICKS_OFFICIAL_MODELS = new Set([
	// Chat
	"system.ai.claude-sonnet-5",
	"system.ai.claude-sonnet-4-6",
	"system.ai.claude-sonnet-4-5",
	"system.ai.claude-opus-4-8",
	"system.ai.claude-opus-4-7",
	"system.ai.claude-opus-4-6",
	"system.ai.claude-opus-4-5",
	"system.ai.claude-haiku-4-5",
	"system.ai.meta-llama-3-3-70b-instruct",
	// Embeddings
	"system.ai.gte-large-en",
	"system.ai.bge-large-en",
]);

// ============================================================================
// Provider to Official Models Mapping
// ============================================================================

const OFFICIAL_MODELS_BY_PROVIDER: Record<AIProvider, Set<string>> = {
	OPENAI_DIRECT: OPENAI_DIRECT_OFFICIAL_MODELS,
	ANTHROPIC_DIRECT: ANTHROPIC_DIRECT_OFFICIAL_MODELS,
	GROQ: GROQ_OFFICIAL_MODELS,
	CEREBRAS: CEREBRAS_OFFICIAL_MODELS,
	DEEPSEEK: DEEPSEEK_OFFICIAL_MODELS,
	VERCEL_GATEWAY: VERCEL_GATEWAY_OFFICIAL_MODELS,
	OPENROUTER: OPENROUTER_OFFICIAL_MODELS,
	TOGETHER_AI: TOGETHER_AI_OFFICIAL_MODELS,
	FIREWORKS: FIREWORKS_OFFICIAL_MODELS,
	MISTRAL_AI: MISTRAL_AI_OFFICIAL_MODELS,
	XAI: XAI_OFFICIAL_MODELS,
	PERPLEXITY: PERPLEXITY_OFFICIAL_MODELS,
	GOOGLE_VERTEX_AI: GOOGLE_VERTEX_AI_OFFICIAL_MODELS,
	AZURE_AI_FOUNDRY: AZURE_AI_FOUNDRY_OFFICIAL_MODELS,
	AWS_BEDROCK: AWS_BEDROCK_OFFICIAL_MODELS,
	DATABRICKS: DATABRICKS_OFFICIAL_MODELS,
	COHERE: COHERE_OFFICIAL_MODELS,
	// Providers without static validation (need API or custom setup)
	CLOUDFLARE_AI: new Set(),
	REPLICATE: new Set(),
	HUGGINGFACE: new Set(),
	HYBRID: new Set(),
	CUSTOM: new Set(),
	// Legacy providers (exist in enum but not actively used)
	AZURE_OPENAI: new Set(),
	NETLIFY: new Set(),
};

// ============================================================================
// Test Utilities
// ============================================================================

interface SeedModelMapping {
	canonicalName: string;
	provider: AIProvider;
	providerModelId: string;
}

/**
 * Extract all provider mappings from the seed file
 * This is imported from the seed file structure
 */
function getSeedProviderMappings(): SeedModelMapping[] {
	const mappings: SeedModelMapping[] = [];

	for (const model of MODELS) {
		for (const mapping of model.providerMappings || []) {
			mappings.push({
				canonicalName: model.canonicalName,
				provider: mapping.provider as AIProvider,
				providerModelId: mapping.providerModelId,
			});
		}
	}

	return mappings;
}

/**
 * Validate a single provider's model mappings
 */
function validateProviderModels(
	provider: AIProvider,
	mappings: SeedModelMapping[],
): { valid: string[]; invalid: string[]; details: Record<string, string> } {
	const officialModels = OFFICIAL_MODELS_BY_PROVIDER[provider];
	const valid: string[] = [];
	const invalid: string[] = [];
	const details: Record<string, string> = {};

	// Skip providers without validation data
	if (officialModels.size === 0) {
		return { valid: [], invalid: [], details: {} };
	}

	for (const mapping of mappings) {
		const modelId = mapping.providerModelId;

		// Check if model ID exists in official list
		if (officialModels.has(modelId)) {
			valid.push(modelId);
		} else {
			invalid.push(modelId);
			// Find closest match for helpful error message
			const closest = findClosestMatch(modelId, officialModels);
			details[modelId] = closest
				? `Not found. Did you mean: "${closest}"?`
				: `Not found in official ${provider} models list`;
		}
	}

	return { valid, invalid, details };
}

/**
 * Find closest string match using Levenshtein distance
 */
function findClosestMatch(
	target: string,
	candidates: Set<string>,
): string | null {
	let closest: string | null = null;
	let minDistance = Number.POSITIVE_INFINITY;

	for (const candidate of candidates) {
		const distance = levenshteinDistance(
			target.toLowerCase(),
			candidate.toLowerCase(),
		);
		if (distance < minDistance && distance < target.length / 2) {
			minDistance = distance;
			closest = candidate;
		}
	}

	return closest;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
	const matrix: number[][] = [];

	for (let i = 0; i <= b.length; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= a.length; j++) {
		matrix[0][j] = j;
	}

	for (let i = 1; i <= b.length; i++) {
		for (let j = 1; j <= a.length; j++) {
			if (b.charAt(i - 1) === a.charAt(j - 1)) {
				matrix[i][j] = matrix[i - 1][j - 1];
			} else {
				matrix[i][j] = Math.min(
					matrix[i - 1][j - 1] + 1,
					matrix[i][j - 1] + 1,
					matrix[i - 1][j] + 1,
				);
			}
		}
	}

	return matrix[b.length][a.length];
}

// ============================================================================
// Tests
// ============================================================================

describe("AI Model Name Validation", () => {
	describe("OpenAI Direct", () => {
		it("should have valid model IDs for OpenAI Direct", () => {
			const mappings = getSeedProviderMappings().filter(
				(m) => m.provider === "OPENAI_DIRECT",
			);
			const result = validateProviderModels("OPENAI_DIRECT", mappings);

			if (result.invalid.length > 0) {
				console.error("\n❌ Invalid OpenAI Direct model IDs:");
				for (const modelId of result.invalid) {
					console.error(`  - ${modelId}: ${result.details[modelId]}`);
				}
			}

			expect(result.invalid).toEqual([]);
		});
	});

	describe("Anthropic Direct", () => {
		it("should have valid model IDs for Anthropic Direct", () => {
			const mappings = getSeedProviderMappings().filter(
				(m) => m.provider === "ANTHROPIC_DIRECT",
			);
			const result = validateProviderModels("ANTHROPIC_DIRECT", mappings);

			if (result.invalid.length > 0) {
				console.error("\n❌ Invalid Anthropic Direct model IDs:");
				for (const modelId of result.invalid) {
					console.error(`  - ${modelId}: ${result.details[modelId]}`);
				}
			}

			expect(result.invalid).toEqual([]);
		});
	});

	describe("Vercel AI Gateway", () => {
		it("should have valid model IDs for Vercel Gateway", () => {
			const mappings = getSeedProviderMappings().filter(
				(m) => m.provider === "VERCEL_GATEWAY",
			);
			const result = validateProviderModels("VERCEL_GATEWAY", mappings);

			if (result.invalid.length > 0) {
				console.error("\n❌ Invalid Vercel Gateway model IDs:");
				for (const modelId of result.invalid) {
					console.error(`  - ${modelId}: ${result.details[modelId]}`);
				}
			}

			expect(result.invalid).toEqual([]);
		});
	});

	describe("Groq", () => {
		it("should have valid model IDs for Groq", () => {
			const mappings = getSeedProviderMappings().filter(
				(m) => m.provider === "GROQ",
			);
			const result = validateProviderModels("GROQ", mappings);

			if (result.invalid.length > 0) {
				console.error("\n❌ Invalid Groq model IDs:");
				for (const modelId of result.invalid) {
					console.error(`  - ${modelId}: ${result.details[modelId]}`);
				}
			}

			expect(result.invalid).toEqual([]);
		});
	});

	describe("Cerebras", () => {
		it("should have valid model IDs for Cerebras", () => {
			const mappings = getSeedProviderMappings().filter(
				(m) => m.provider === "CEREBRAS",
			);
			const result = validateProviderModels("CEREBRAS", mappings);

			if (result.invalid.length > 0) {
				console.error("\n❌ Invalid Cerebras model IDs:");
				for (const modelId of result.invalid) {
					console.error(`  - ${modelId}: ${result.details[modelId]}`);
				}
			}

			expect(result.invalid).toEqual([]);
		});
	});

	describe("DeepSeek", () => {
		it("should have valid model IDs for DeepSeek", () => {
			const mappings = getSeedProviderMappings().filter(
				(m) => m.provider === "DEEPSEEK",
			);
			const result = validateProviderModels("DEEPSEEK", mappings);

			if (result.invalid.length > 0) {
				console.error("\n❌ Invalid DeepSeek model IDs:");
				for (const modelId of result.invalid) {
					console.error(`  - ${modelId}: ${result.details[modelId]}`);
				}
			}

			expect(result.invalid).toEqual([]);
		});
	});

	describe("OpenRouter", () => {
		it("should have valid model IDs for OpenRouter", () => {
			const mappings = getSeedProviderMappings().filter(
				(m) => m.provider === "OPENROUTER",
			);
			const result = validateProviderModels("OPENROUTER", mappings);

			if (result.invalid.length > 0) {
				console.error("\n❌ Invalid OpenRouter model IDs:");
				for (const modelId of result.invalid) {
					console.error(`  - ${modelId}: ${result.details[modelId]}`);
				}
			}

			expect(result.invalid).toEqual([]);
		});
	});

	describe("Together AI", () => {
		it("should have valid model IDs for Together AI", () => {
			const mappings = getSeedProviderMappings().filter(
				(m) => m.provider === "TOGETHER_AI",
			);
			const result = validateProviderModels("TOGETHER_AI", mappings);

			if (result.invalid.length > 0) {
				console.error("\n❌ Invalid Together AI model IDs:");
				for (const modelId of result.invalid) {
					console.error(`  - ${modelId}: ${result.details[modelId]}`);
				}
			}

			expect(result.invalid).toEqual([]);
		});
	});

	describe("Fireworks", () => {
		it("should have valid model IDs for Fireworks", () => {
			const mappings = getSeedProviderMappings().filter(
				(m) => m.provider === "FIREWORKS",
			);
			const result = validateProviderModels("FIREWORKS", mappings);

			if (result.invalid.length > 0) {
				console.error("\n❌ Invalid Fireworks model IDs:");
				for (const modelId of result.invalid) {
					console.error(`  - ${modelId}: ${result.details[modelId]}`);
				}
			}

			expect(result.invalid).toEqual([]);
		});
	});

	describe("Mistral AI", () => {
		it("should have valid model IDs for Mistral AI", () => {
			const mappings = getSeedProviderMappings().filter(
				(m) => m.provider === "MISTRAL_AI",
			);
			const result = validateProviderModels("MISTRAL_AI", mappings);

			if (result.invalid.length > 0) {
				console.error("\n❌ Invalid Mistral AI model IDs:");
				for (const modelId of result.invalid) {
					console.error(`  - ${modelId}: ${result.details[modelId]}`);
				}
			}

			expect(result.invalid).toEqual([]);
		});
	});

	describe("xAI (Grok)", () => {
		it("should have valid model IDs for xAI", () => {
			const mappings = getSeedProviderMappings().filter(
				(m) => m.provider === "XAI",
			);
			const result = validateProviderModels("XAI", mappings);

			if (result.invalid.length > 0) {
				console.error("\n❌ Invalid xAI model IDs:");
				for (const modelId of result.invalid) {
					console.error(`  - ${modelId}: ${result.details[modelId]}`);
				}
			}

			expect(result.invalid).toEqual([]);
		});
	});

	describe("Perplexity", () => {
		it("should have valid model IDs for Perplexity", () => {
			const mappings = getSeedProviderMappings().filter(
				(m) => m.provider === "PERPLEXITY",
			);
			const result = validateProviderModels("PERPLEXITY", mappings);

			if (result.invalid.length > 0) {
				console.error("\n❌ Invalid Perplexity model IDs:");
				for (const modelId of result.invalid) {
					console.error(`  - ${modelId}: ${result.details[modelId]}`);
				}
			}

			expect(result.invalid).toEqual([]);
		});
	});

	describe("Google Vertex AI", () => {
		it("should have valid model IDs for Google Vertex AI", () => {
			const mappings = getSeedProviderMappings().filter(
				(m) => m.provider === "GOOGLE_VERTEX_AI",
			);
			const result = validateProviderModels("GOOGLE_VERTEX_AI", mappings);

			if (result.invalid.length > 0) {
				console.error("\n❌ Invalid Google Vertex AI model IDs:");
				for (const modelId of result.invalid) {
					console.error(`  - ${modelId}: ${result.details[modelId]}`);
				}
			}

			expect(result.invalid).toEqual([]);
		});
	});

	describe("Azure AI Foundry", () => {
		it("should have valid model IDs for Azure AI Foundry", () => {
			const mappings = getSeedProviderMappings().filter(
				(m) => m.provider === "AZURE_AI_FOUNDRY",
			);
			const result = validateProviderModels("AZURE_AI_FOUNDRY", mappings);

			if (result.invalid.length > 0) {
				console.error("\n❌ Invalid Azure AI Foundry model IDs:");
				for (const modelId of result.invalid) {
					console.error(`  - ${modelId}: ${result.details[modelId]}`);
				}
			}

			expect(result.invalid).toEqual([]);
		});
	});

	describe("AWS Bedrock", () => {
		it("should have valid model IDs for AWS Bedrock", () => {
			const mappings = getSeedProviderMappings().filter(
				(m) => m.provider === "AWS_BEDROCK",
			);
			const result = validateProviderModels("AWS_BEDROCK", mappings);

			if (result.invalid.length > 0) {
				console.error("\n❌ Invalid AWS Bedrock model IDs:");
				for (const modelId of result.invalid) {
					console.error(`  - ${modelId}: ${result.details[modelId]}`);
				}
			}

			expect(result.invalid).toEqual([]);
		});
	});

	// ========================================================================
	// Per-model provider-routing regressions (Fallback A pins)
	// ========================================================================
	// These tests guard against accidentally re-adding a provider mapping that
	// was deliberately removed because the wire shape doesn't carry the data
	// we need. See PR 5 staging Smoke #2 for the o3-mini investigation.

	describe("o3-mini Fallback A pin", () => {
		it("does NOT route via Vercel Gateway (no reasoning summary on wire)", () => {
			const o3Mini = MODELS.find((m) => m.canonicalName === "o3-mini");
			expect(o3Mini, "o3-mini model must exist in catalog").toBeDefined();
			const providers = (o3Mini?.providerMappings ?? []).map(
				(m) => m.provider,
			);
			// Per Smoke #2 (PR 5): o3-mini via Vercel Gateway works on the wire
			// (30+ s latency, tool calls, quality output) but the gateway response
			// never carries reasoning summary text in either
			// `choices[0].message.reasoning` or `choices[0].delta.reasoning`.
			// Until Vercel exposes summary text on this path we restrict o3-mini
			// to providers that DO surface reasoning (OPENAI_DIRECT) plus
			// OPENROUTER for redundancy. Re-adding VERCEL_GATEWAY here would
			// regress the user-visible "Thinking" affordance.
			expect(providers).not.toContain("VERCEL_GATEWAY");
			expect(providers).toContain("OPENAI_DIRECT");
		});
	});
});

// ============================================================================
// Summary Report Test
// ============================================================================

describe("AI Model Validation Summary", () => {
	it("should generate a complete validation report", () => {
		const allMappings = getSeedProviderMappings();
		const report: Record<
			string,
			{
				valid: number;
				invalid: number;
				skipped: boolean;
				errors: string[];
			}
		> = {};

		let totalValid = 0;
		let totalInvalid = 0;

		for (const provider of Object.keys(OFFICIAL_MODELS_BY_PROVIDER)) {
			const providerKey = provider as AIProvider;
			const officialModels = OFFICIAL_MODELS_BY_PROVIDER[providerKey];
			const mappings = allMappings.filter(
				(m) => m.provider === providerKey,
			);

			if (officialModels.size === 0 || mappings.length === 0) {
				report[provider] = {
					valid: 0,
					invalid: 0,
					skipped: true,
					errors: [],
				};
				continue;
			}

			const result = validateProviderModels(providerKey, mappings);
			report[provider] = {
				valid: result.valid.length,
				invalid: result.invalid.length,
				skipped: false,
				errors: result.invalid.map(
					(id) => `${id}: ${result.details[id]}`,
				),
			};

			totalValid += result.valid.length;
			totalInvalid += result.invalid.length;
		}

		// Print summary
		console.log(`\n${"=".repeat(70)}`);
		console.log("AI MODEL VALIDATION SUMMARY");
		console.log("=".repeat(70));

		for (const [provider, data] of Object.entries(report)) {
			if (data.skipped) {
				console.log(`\n${provider}: SKIPPED (no validation data)`);
			} else if (data.invalid === 0) {
				console.log(`\n✅ ${provider}: ${data.valid} models valid`);
			} else {
				console.log(
					`\n❌ ${provider}: ${data.valid} valid, ${data.invalid} INVALID`,
				);
				for (const error of data.errors) {
					console.log(`   - ${error}`);
				}
			}
		}

		console.log(`\n${"=".repeat(70)}`);
		console.log(`TOTAL: ${totalValid} valid, ${totalInvalid} invalid`);
		console.log(`${"=".repeat(70)}\n`);

		// This test always passes but prints the report
		// Individual provider tests will fail on invalid models
		expect(true).toBe(true);
	});
});
