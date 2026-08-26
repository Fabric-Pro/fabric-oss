/**
 * AI Model Catalog - Pure Data Definitions
 *
 * This file contains the model definitions without any database dependencies.
 * Used by both the seed script and validation tests.
 *
 * IMPORTANT: This is the source of truth for model names per provider.
 * When updating models, update this file first, then run:
 *   - pnpm --filter @repo/database seed:ai-models
 *   - pnpm --filter @repo/database test:ai-models
 */

import type {
	AIProvider,
	AiModelCapability,
	AiTaskType,
	QualityTier,
	SpeedTier,
	TaskComplexity,
} from "./generated/client";

// ============================================================================
// Types
// ============================================================================

export interface ModelSeedData {
	canonicalName: string;
	displayName: string;
	description: string;
	family: string;
	vendor: string;
	capabilities: AiModelCapability[];
	contextWindow: number;
	maxOutputTokens?: number;
	speedTier: SpeedTier;
	qualityTier: QualityTier;
	inputCostPer1M?: number;
	outputCostPer1M?: number;
	suitableForTasks: AiTaskType[];
	providerMappings: Array<{
		provider: AIProvider;
		providerModelId: string;
		inputCostPer1M?: number;
		outputCostPer1M?: number;
	}>;
}

export interface TaskDefaultSeed {
	taskType: AiTaskType;
	complexity: TaskComplexity;
	canonicalName: string;
	provider: AIProvider;
	priority: number;
	requiresToolCalling?: boolean;
}

// ============================================================================
// Model Definitions
// ============================================================================

export const MODELS: ModelSeedData[] = [
	// ============================================================================
	// OpenAI Models
	// ============================================================================
	{
		canonicalName: "gpt-4o",
		displayName: "GPT-4o",
		description:
			"OpenAI's flagship multimodal model with excellent reasoning and tool use capabilities",
		family: "gpt",
		vendor: "OpenAI",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 128000,
		maxOutputTokens: 16384,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 2.5,
		outputCostPer1M: 10,
		suitableForTasks: [
			"COMPLEX",
			"CHAT",
			"TOOL_CALLING",
			"REASONING",
			"EVAL",
		],
		providerMappings: [
			{ provider: "OPENAI_DIRECT", providerModelId: "gpt-4o" },
			{ provider: "VERCEL_GATEWAY", providerModelId: "openai/gpt-4o" },
			{ provider: "OPENROUTER", providerModelId: "openai/gpt-4o" },
			{ provider: "AZURE_AI_FOUNDRY", providerModelId: "gpt-4o" },
		],
	},
	{
		canonicalName: "gpt-4o-mini",
		displayName: "GPT-4o Mini",
		description:
			"Smaller, faster, and cheaper version of GPT-4o with vision",
		family: "gpt",
		vendor: "OpenAI",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE"],
		contextWindow: 128000,
		maxOutputTokens: 16384,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.15,
		outputCostPer1M: 0.6,
		suitableForTasks: ["SIMPLE", "CHAT", "TOOL_CALLING", "EVAL"],
		providerMappings: [
			{ provider: "OPENAI_DIRECT", providerModelId: "gpt-4o-mini" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/gpt-4o-mini",
			},
			{ provider: "OPENROUTER", providerModelId: "openai/gpt-4o-mini" },
			{ provider: "AZURE_AI_FOUNDRY", providerModelId: "gpt-4o-mini" },
		],
	},
	{
		canonicalName: "gpt-5-nano",
		displayName: "GPT-5 Nano",
		description:
			"OpenAI's smallest and fastest GPT-5 model, optimized for simple tasks and low latency",
		family: "gpt",
		vendor: "OpenAI",
		capabilities: ["TEXT", "TOOL_CALLING", "CODE"],
		contextWindow: 128000,
		maxOutputTokens: 16384,
		speedTier: "FAST",
		qualityTier: "BASIC",
		inputCostPer1M: 0.1,
		outputCostPer1M: 0.4,
		suitableForTasks: ["SIMPLE", "CHAT"],
		providerMappings: [
			{ provider: "OPENAI_DIRECT", providerModelId: "gpt-5-nano" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/gpt-5-nano",
			},
			{ provider: "OPENROUTER", providerModelId: "openai/gpt-5-nano" },
			{ provider: "AZURE_AI_FOUNDRY", providerModelId: "gpt-5-nano" },
		],
	},
	{
		canonicalName: "gpt-5-mini",
		displayName: "GPT-5 Mini",
		description:
			"OpenAI's efficient GPT-5 model, balancing speed and capability for everyday tasks",
		family: "gpt",
		vendor: "OpenAI",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE"],
		contextWindow: 128000,
		maxOutputTokens: 16384,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.15,
		outputCostPer1M: 0.6,
		suitableForTasks: ["SIMPLE", "CHAT", "TOOL_CALLING"],
		providerMappings: [
			{ provider: "OPENAI_DIRECT", providerModelId: "gpt-5-mini" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/gpt-5-mini",
			},
			{ provider: "OPENROUTER", providerModelId: "openai/gpt-5-mini" },
			{ provider: "AZURE_AI_FOUNDRY", providerModelId: "gpt-5-mini" },
		],
	},
	{
		canonicalName: "gpt-5-2",
		displayName: "GPT-5.2",
		description:
			"OpenAI's flagship model with 400K context, strong reasoning, coding, and tool-calling",
		family: "gpt",
		vendor: "OpenAI",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 400000,
		maxOutputTokens: 128000,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 1.75,
		outputCostPer1M: 14,
		suitableForTasks: [
			"COMPLEX",
			"CHAT",
			"TOOL_CALLING",
			"REASONING",
			"EVAL",
		],
		providerMappings: [
			{ provider: "OPENAI_DIRECT", providerModelId: "gpt-5.2" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/gpt-5.2",
			},
			{ provider: "OPENROUTER", providerModelId: "openai/gpt-5.2" },
			{ provider: "AZURE_AI_FOUNDRY", providerModelId: "gpt-5.2" },
		],
	},
	{
		canonicalName: "gpt-5.4",
		displayName: "GPT-5.4",
		description:
			"OpenAI's frontier model with advanced reasoning, coding, and multimodal capabilities",
		family: "gpt",
		vendor: "OpenAI",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 400000,
		maxOutputTokens: 128000,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 2.0,
		outputCostPer1M: 16,
		suitableForTasks: [
			"COMPLEX",
			"CHAT",
			"TOOL_CALLING",
			"REASONING",
			"EVAL",
		],
		providerMappings: [
			{ provider: "OPENAI_DIRECT", providerModelId: "gpt-5.4" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/gpt-5.4",
			},
			{ provider: "OPENROUTER", providerModelId: "openai/gpt-5.4" },
			{ provider: "AZURE_AI_FOUNDRY", providerModelId: "gpt-5.4" },
		],
	},
	{
		canonicalName: "gpt-5.5",
		displayName: "GPT-5.5",
		description:
			"OpenAI's most capable model with 1M context, advanced reasoning, coding, and multimodal capabilities",
		family: "gpt",
		vendor: "OpenAI",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 1000000,
		maxOutputTokens: 128000,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 5.0,
		outputCostPer1M: 30,
		suitableForTasks: [
			"COMPLEX",
			"CHAT",
			"TOOL_CALLING",
			"REASONING",
			"EVAL",
		],
		providerMappings: [
			{ provider: "OPENAI_DIRECT", providerModelId: "gpt-5.5" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/gpt-5.5",
			},
			{ provider: "OPENROUTER", providerModelId: "openai/gpt-5.5" },
			{ provider: "AZURE_AI_FOUNDRY", providerModelId: "gpt-5.5" },
		],
	},
	{
		canonicalName: "gpt-4.1-mini",
		displayName: "GPT-4.1 Mini (Azure)",
		description:
			"Azure OpenAI deployment of GPT-4.1 Mini - fast and efficient for chat and tool use",
		family: "gpt",
		vendor: "OpenAI",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE"],
		contextWindow: 128000,
		maxOutputTokens: 16384,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.15,
		outputCostPer1M: 0.6,
		suitableForTasks: ["SIMPLE", "COMPLEX", "CHAT", "TOOL_CALLING"],
		providerMappings: [
			{ provider: "AZURE_AI_FOUNDRY", providerModelId: "gpt-4.1-mini" },
		],
	},
	{
		canonicalName: "gpt-4-turbo",
		displayName: "GPT-4 Turbo",
		description: "GPT-4 Turbo with vision, large context window",
		family: "gpt",
		vendor: "OpenAI",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE"],
		contextWindow: 128000,
		maxOutputTokens: 4096,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 10,
		outputCostPer1M: 30,
		suitableForTasks: ["COMPLEX", "CHAT", "TOOL_CALLING"],
		providerMappings: [
			{ provider: "OPENAI_DIRECT", providerModelId: "gpt-4-turbo" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/gpt-4-turbo",
			},
			{ provider: "OPENROUTER", providerModelId: "openai/gpt-4-turbo" },
		],
	},
	{
		canonicalName: "o1",
		displayName: "OpenAI o1",
		description:
			"OpenAI's reasoning model with extended thinking for complex problems",
		family: "o1",
		vendor: "OpenAI",
		capabilities: ["TEXT", "REASONING", "CODE"],
		contextWindow: 200000,
		maxOutputTokens: 100000,
		speedTier: "QUALITY",
		qualityTier: "PREMIUM",
		inputCostPer1M: 15,
		outputCostPer1M: 60,
		suitableForTasks: ["REASONING", "COMPLEX", "EVAL"],
		providerMappings: [
			{ provider: "OPENAI_DIRECT", providerModelId: "o1" },
			{ provider: "VERCEL_GATEWAY", providerModelId: "openai/o1" },
			{ provider: "OPENROUTER", providerModelId: "openai/o1" },
		],
	},
	{
		canonicalName: "o1-mini",
		displayName: "OpenAI o1 Mini",
		description: "Smaller reasoning model, faster and more cost-effective",
		family: "o1",
		vendor: "OpenAI",
		capabilities: ["TEXT", "REASONING", "CODE"],
		contextWindow: 128000,
		maxOutputTokens: 65536,
		speedTier: "BALANCED",
		qualityTier: "STANDARD",
		inputCostPer1M: 3,
		outputCostPer1M: 12,
		suitableForTasks: ["REASONING", "EVAL"],
		providerMappings: [
			{ provider: "OPENAI_DIRECT", providerModelId: "o1-mini" },
			{ provider: "VERCEL_GATEWAY", providerModelId: "openai/o1-mini" },
			{ provider: "OPENROUTER", providerModelId: "openai/o1-mini" },
		],
	},
	{
		canonicalName: "o3-mini",
		displayName: "OpenAI o3 Mini",
		description: "Next-gen reasoning model, efficient and balanced",
		family: "o3",
		vendor: "OpenAI",
		capabilities: ["TEXT", "REASONING", "CODE"],
		contextWindow: 200000,
		maxOutputTokens: 100000,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 1.1,
		outputCostPer1M: 4.4,
		suitableForTasks: ["REASONING", "COMPLEX", "EVAL"],
		// Fallback A (post-PR-5 smoke #2): Vercel Gateway carries o3-mini on
		// the wire as a reasoning model — 30+ s latency, quality output, tool
		// calls all work — but the gateway response never contains reasoning
		// summary text in either `choices[0].message.reasoning` or
		// `choices[0].delta.reasoning`. The downstream UI therefore shows
		// "Tools · 1" with no "Thinking" collapsible, which is misleading.
		// Until Vercel exposes summary text on this path, restrict o3-mini to
		// OPENAI_DIRECT (where the official Responses API does surface
		// reasoning) and OPENROUTER. gpt-5-2 still routes via the gateway
		// because that hard gate passed smoke #1.
		providerMappings: [
			{ provider: "OPENAI_DIRECT", providerModelId: "o3-mini" },
			{ provider: "OPENROUTER", providerModelId: "openai/o3-mini" },
		],
	},

	// ============================================================================
	// Anthropic Models
	// ============================================================================
	{
		canonicalName: "claude-sonnet-5",
		displayName: "Claude Sonnet 5",
		description:
			"Anthropic's Claude 5-family Sonnet with frontier intelligence, excellent coding, and long-context reasoning",
		family: "claude",
		vendor: "Anthropic",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 1000000,
		maxOutputTokens: 128000,
		speedTier: "FAST",
		qualityTier: "PREMIUM",
		inputCostPer1M: 3,
		outputCostPer1M: 15,
		suitableForTasks: [
			"COMPLEX",
			"CHAT",
			"TOOL_CALLING",
			"REASONING",
			"EVAL",
		],
		providerMappings: [
			{
				provider: "ANTHROPIC_DIRECT",
				providerModelId: "claude-sonnet-5",
			},
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "anthropic/claude-sonnet-5",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "anthropic/claude-sonnet-5",
			},
			{
				provider: "DATABRICKS",
				providerModelId: "system.ai.claude-sonnet-5",
			},
		],
	},
	{
		canonicalName: "claude-sonnet-4-6",
		displayName: "Claude Sonnet 4.6",
		description:
			"Anthropic's latest Sonnet with near-Opus intelligence, excellent coding, computer use, and long-context reasoning",
		family: "claude",
		vendor: "Anthropic",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 1000000,
		maxOutputTokens: 128000,
		speedTier: "FAST",
		qualityTier: "PREMIUM",
		inputCostPer1M: 3,
		outputCostPer1M: 15,
		suitableForTasks: [
			"COMPLEX",
			"CHAT",
			"TOOL_CALLING",
			"REASONING",
			"EVAL",
		],
		providerMappings: [
			{
				provider: "ANTHROPIC_DIRECT",
				providerModelId: "claude-sonnet-4-6",
			},
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "anthropic/claude-sonnet-4-6",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "anthropic/claude-sonnet-4-6",
			},
			{
				provider: "DATABRICKS",
				providerModelId: "system.ai.claude-sonnet-4-6",
			},
		],
	},
	{
		canonicalName: "claude-opus-4-8",
		displayName: "Claude Opus 4.8",
		description:
			"Anthropic's latest flagship Opus with 1M context, 128K output, adaptive thinking, and agent teams support",
		family: "claude",
		vendor: "Anthropic",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 1000000,
		maxOutputTokens: 128000,
		speedTier: "QUALITY",
		qualityTier: "PREMIUM",
		inputCostPer1M: 5,
		outputCostPer1M: 25,
		suitableForTasks: [
			"REASONING",
			"COMPLEX",
			"CHAT",
			"TOOL_CALLING",
			"EVAL",
		],
		providerMappings: [
			{
				provider: "ANTHROPIC_DIRECT",
				providerModelId: "claude-opus-4-8",
			},
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "anthropic/claude-opus-4.8",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "anthropic/claude-opus-4.8",
			},
			{
				provider: "AWS_BEDROCK",
				providerModelId: "anthropic.claude-opus-4-8",
			},
			{
				provider: "DATABRICKS",
				providerModelId: "system.ai.claude-opus-4-8",
			},
		],
	},
	{
		canonicalName: "claude-opus-4-7",
		displayName: "Claude Opus 4.7",
		description:
			"Anthropic's previous flagship Opus with 1M context, 128K output, adaptive thinking, and agent teams support",
		family: "claude",
		vendor: "Anthropic",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 1000000,
		maxOutputTokens: 128000,
		speedTier: "QUALITY",
		qualityTier: "PREMIUM",
		inputCostPer1M: 5,
		outputCostPer1M: 25,
		suitableForTasks: [
			"REASONING",
			"COMPLEX",
			"CHAT",
			"TOOL_CALLING",
			"EVAL",
		],
		providerMappings: [
			{
				provider: "ANTHROPIC_DIRECT",
				providerModelId: "claude-opus-4-7",
			},
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "anthropic/claude-opus-4.7",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "anthropic/claude-opus-4.7",
			},
			{
				provider: "AWS_BEDROCK",
				providerModelId: "anthropic.claude-opus-4-7",
			},
			{
				provider: "DATABRICKS",
				providerModelId: "system.ai.claude-opus-4-7",
			},
		],
	},
	{
		canonicalName: "claude-opus-4-6",
		displayName: "Claude Opus 4.6",
		description:
			"Anthropic's earlier flagship Opus with 1M context, 128K output, adaptive thinking, and agent teams support",
		family: "claude",
		vendor: "Anthropic",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 1000000,
		maxOutputTokens: 128000,
		speedTier: "QUALITY",
		qualityTier: "PREMIUM",
		inputCostPer1M: 5,
		outputCostPer1M: 25,
		suitableForTasks: [
			"REASONING",
			"COMPLEX",
			"CHAT",
			"TOOL_CALLING",
			"EVAL",
		],
		providerMappings: [
			{
				provider: "ANTHROPIC_DIRECT",
				providerModelId: "claude-opus-4-6",
			},
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "anthropic/claude-opus-4-6",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "anthropic/claude-opus-4-6",
			},
			{
				provider: "AWS_BEDROCK",
				providerModelId: "anthropic.claude-opus-4-6-v1",
			},
			{
				provider: "DATABRICKS",
				providerModelId: "system.ai.claude-opus-4-6",
			},
		],
	},
	{
		canonicalName: "claude-sonnet-4-5",
		displayName: "Claude Sonnet 4.5",
		description:
			"Anthropic's previous-gen Sonnet with excellent reasoning and code generation",
		family: "claude",
		vendor: "Anthropic",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 200000,
		maxOutputTokens: 64000,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 3,
		outputCostPer1M: 15,
		suitableForTasks: [
			"COMPLEX",
			"CHAT",
			"TOOL_CALLING",
			"REASONING",
			"EVAL",
		],
		providerMappings: [
			{
				provider: "ANTHROPIC_DIRECT",
				providerModelId: "claude-sonnet-4-5-20250929",
			},
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "anthropic/claude-sonnet-4.5",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "anthropic/claude-sonnet-4.5",
			},
			{
				provider: "AWS_BEDROCK",
				providerModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
			},
			{
				provider: "DATABRICKS",
				providerModelId: "system.ai.claude-sonnet-4-5",
			},
		],
	},
	{
		canonicalName: "claude-haiku-4-5",
		displayName: "Claude Haiku 4.5",
		description:
			"Anthropic's fastest Claude model with near-frontier intelligence",
		family: "claude",
		vendor: "Anthropic",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 200000,
		maxOutputTokens: 64000,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 1,
		outputCostPer1M: 5,
		suitableForTasks: ["SIMPLE", "CHAT", "TOOL_CALLING"],
		providerMappings: [
			{
				provider: "ANTHROPIC_DIRECT",
				providerModelId: "claude-haiku-4-5-20251001",
			},
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "anthropic/claude-haiku-4.5",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "anthropic/claude-haiku-4.5",
			},
			{
				provider: "AWS_BEDROCK",
				providerModelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
			},
			{
				provider: "DATABRICKS",
				providerModelId: "system.ai.claude-haiku-4-5",
			},
		],
	},
	{
		canonicalName: "claude-opus-4-5",
		displayName: "Claude Opus 4.5",
		description:
			"Anthropic's previous-gen Opus for complex reasoning and extended thinking",
		family: "claude",
		vendor: "Anthropic",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 200000,
		maxOutputTokens: 64000,
		speedTier: "QUALITY",
		qualityTier: "PREMIUM",
		inputCostPer1M: 5,
		outputCostPer1M: 25,
		suitableForTasks: ["REASONING", "COMPLEX", "EVAL"],
		providerMappings: [
			{
				provider: "ANTHROPIC_DIRECT",
				providerModelId: "claude-opus-4-5-20251101",
			},
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "anthropic/claude-opus-4.5",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "anthropic/claude-opus-4.5",
			},
			{
				provider: "AWS_BEDROCK",
				providerModelId: "anthropic.claude-opus-4-5-20251101-v1:0",
			},
			{
				provider: "DATABRICKS",
				providerModelId: "system.ai.claude-opus-4-5",
			},
		],
	},

	// ============================================================================
	// Google Gemini Models
	// ============================================================================
	{
		canonicalName: "gemini-2-5-pro",
		displayName: "Gemini 2.5 Pro",
		description:
			"Google's most capable model with thinking, 1M context, and strong reasoning",
		family: "gemini",
		vendor: "Google",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 1000000,
		maxOutputTokens: 65536,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 1.25,
		outputCostPer1M: 10,
		suitableForTasks: [
			"COMPLEX",
			"CHAT",
			"TOOL_CALLING",
			"REASONING",
			"EVAL",
		],
		providerMappings: [
			{
				provider: "GOOGLE_VERTEX_AI",
				providerModelId: "gemini-2.5-pro",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "google/gemini-2.5-pro",
			},
		],
	},
	{
		canonicalName: "gemini-2-5-flash",
		displayName: "Gemini 2.5 Flash",
		description:
			"Google's fast model with thinking capabilities, excellent price-performance ratio",
		family: "gemini",
		vendor: "Google",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 1000000,
		maxOutputTokens: 65536,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.3,
		outputCostPer1M: 2.5,
		suitableForTasks: ["SIMPLE", "CHAT", "TOOL_CALLING"],
		providerMappings: [
			{
				provider: "GOOGLE_VERTEX_AI",
				providerModelId: "gemini-2.5-flash",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "google/gemini-2.5-flash",
			},
		],
	},
	{
		canonicalName: "gemini-3-flash",
		displayName: "Gemini 3 Flash (Preview)",
		description:
			"Google's frontier-class Flash model rivaling larger models at a fraction of the cost, with thinking levels",
		family: "gemini",
		vendor: "Google",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 1000000,
		maxOutputTokens: 65536,
		speedTier: "FAST",
		qualityTier: "PREMIUM",
		inputCostPer1M: 0.5,
		outputCostPer1M: 3,
		suitableForTasks: ["SIMPLE", "CHAT", "TOOL_CALLING", "COMPLEX"],
		providerMappings: [
			{
				provider: "GOOGLE_VERTEX_AI",
				providerModelId: "gemini-3-flash-preview",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "google/gemini-3-flash-preview",
			},
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "google/gemini-3-flash-preview",
			},
		],
	},
	{
		canonicalName: "gemini-3-1-pro",
		displayName: "Gemini 3.1 Pro (Preview)",
		description:
			"Google's latest and most capable model with advanced reasoning, agentic coding, and complex problem-solving",
		family: "gemini",
		vendor: "Google",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 1000000,
		maxOutputTokens: 65536,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 2,
		outputCostPer1M: 12,
		suitableForTasks: [
			"COMPLEX",
			"REASONING",
			"CHAT",
			"TOOL_CALLING",
			"EVAL",
		],
		providerMappings: [
			{
				provider: "GOOGLE_VERTEX_AI",
				providerModelId: "gemini-3.1-pro-preview",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "google/gemini-3.1-pro-preview",
			},
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "google/gemini-3.1-pro-preview",
			},
		],
	},
	{
		canonicalName: "gemini-2-0-flash",
		displayName: "Gemini 2.0 Flash",
		description:
			"Google's previous-gen fast multimodal model (deprecated, use 2.5 Flash)",
		family: "gemini",
		vendor: "Google",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE"],
		contextWindow: 1000000,
		maxOutputTokens: 8192,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.1,
		outputCostPer1M: 0.4,
		suitableForTasks: ["SIMPLE", "CHAT", "TOOL_CALLING"],
		providerMappings: [
			{
				provider: "GOOGLE_VERTEX_AI",
				providerModelId: "gemini-2.0-flash-001",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "google/gemini-2.0-flash-001",
			},
		],
	},
	{
		canonicalName: "gemini-1-5-pro",
		displayName: "Gemini 1.5 Pro",
		description:
			"Google's previous-gen flagship with 2M context window (use 2.5 Pro instead)",
		family: "gemini",
		vendor: "Google",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 2000000,
		maxOutputTokens: 8192,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 1.25,
		outputCostPer1M: 5,
		suitableForTasks: [
			"COMPLEX",
			"CHAT",
			"TOOL_CALLING",
			"REASONING",
			"EVAL",
		],
		providerMappings: [
			{
				provider: "GOOGLE_VERTEX_AI",
				providerModelId: "gemini-1.5-pro-002",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "google/gemini-pro-1.5",
			},
		],
	},
	{
		canonicalName: "gemini-1-5-flash",
		displayName: "Gemini 1.5 Flash",
		description:
			"Previous-gen fast multimodal model with 1M context (use 2.5 Flash instead)",
		family: "gemini",
		vendor: "Google",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE"],
		contextWindow: 1000000,
		maxOutputTokens: 8192,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.075,
		outputCostPer1M: 0.3,
		suitableForTasks: ["SIMPLE", "CHAT"],
		providerMappings: [
			{
				provider: "GOOGLE_VERTEX_AI",
				providerModelId: "gemini-1.5-flash-002",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "google/gemini-flash-1.5",
			},
		],
	},

	// ============================================================================
	// Meta Llama Models (via Groq, Together, etc.)
	// ============================================================================
	{
		canonicalName: "llama-3-3-70b",
		displayName: "Llama 3.3 70B",
		description:
			"Meta's most capable open-source model with excellent general capabilities",
		family: "llama",
		vendor: "Meta",
		capabilities: ["TEXT", "TOOL_CALLING", "CODE"],
		contextWindow: 128000,
		maxOutputTokens: 8192,
		speedTier: "FAST",
		qualityTier: "PREMIUM",
		inputCostPer1M: 0.59,
		outputCostPer1M: 0.79,
		suitableForTasks: ["COMPLEX", "CHAT", "TOOL_CALLING"],
		providerMappings: [
			{ provider: "GROQ", providerModelId: "llama-3.3-70b-versatile" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "meta/llama-3.3-70b",
			},
			{
				provider: "TOGETHER_AI",
				providerModelId: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "meta-llama/llama-3.3-70b-instruct",
			},
			{
				provider: "FIREWORKS",
				providerModelId:
					"accounts/fireworks/models/llama-v3p3-70b-instruct",
			},
			{
				provider: "AWS_BEDROCK",
				providerModelId: "meta.llama3-3-70b-instruct-v1:0",
			},
			{ provider: "CEREBRAS", providerModelId: "llama-3.3-70b" },
			{
				provider: "DATABRICKS",
				providerModelId: "system.ai.meta-llama-3-3-70b-instruct",
			},
		],
	},
	{
		canonicalName: "llama-3-1-8b",
		displayName: "Llama 3.1 8B",
		description: "Fast and efficient small model for simple tasks",
		family: "llama",
		vendor: "Meta",
		capabilities: ["TEXT", "CODE"],
		contextWindow: 128000,
		maxOutputTokens: 8192,
		speedTier: "FAST",
		qualityTier: "BASIC",
		inputCostPer1M: 0.05,
		outputCostPer1M: 0.08,
		suitableForTasks: ["SIMPLE", "CHAT"],
		providerMappings: [
			{ provider: "GROQ", providerModelId: "llama-3.1-8b-instant" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "meta/llama-3.1-8b",
			},
			{
				provider: "TOGETHER_AI",
				providerModelId: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "meta-llama/llama-3.1-8b-instruct",
			},
			{
				provider: "FIREWORKS",
				providerModelId:
					"accounts/fireworks/models/llama-v3p1-8b-instruct",
			},
			{ provider: "CEREBRAS", providerModelId: "llama3.1-8b" },
		],
	},
	{
		canonicalName: "llama-4-scout",
		displayName: "Llama 4 Scout",
		description: "Meta's next-gen Llama 4 model, fast inference on Groq",
		family: "llama",
		vendor: "Meta",
		capabilities: ["TEXT", "TOOL_CALLING", "CODE"],
		contextWindow: 131000,
		maxOutputTokens: 8192,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.11,
		outputCostPer1M: 0.34,
		suitableForTasks: ["CHAT", "TOOL_CALLING"],
		providerMappings: [
			{
				provider: "GROQ",
				providerModelId: "meta-llama/llama-4-scout-17b-16e-instruct",
			},
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "meta/llama-4-scout",
			},
		],
	},

	// ============================================================================
	// DeepSeek Models
	// ============================================================================
	{
		canonicalName: "deepseek-chat",
		displayName: "DeepSeek Chat (V3.2)",
		description:
			"DeepSeek's general-purpose chat model with strong reasoning and tool use (V3.2 non-thinking mode)",
		family: "deepseek",
		vendor: "DeepSeek",
		capabilities: ["TEXT", "CODE", "REASONING", "TOOL_CALLING"],
		contextWindow: 128000,
		maxOutputTokens: 8192,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.28,
		outputCostPer1M: 0.42,
		suitableForTasks: ["CHAT", "COMPLEX", "TOOL_CALLING"],
		providerMappings: [
			{ provider: "DEEPSEEK", providerModelId: "deepseek-chat" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "deepseek/deepseek-chat",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "deepseek/deepseek-chat",
			},
			{
				provider: "TOGETHER_AI",
				providerModelId: "deepseek-ai/DeepSeek-V3",
			},
			{
				provider: "FIREWORKS",
				providerModelId: "accounts/fireworks/models/deepseek-v3",
			},
		],
	},
	{
		canonicalName: "deepseek-r1",
		displayName: "DeepSeek R1 (V3.2 Reasoner)",
		description:
			"DeepSeek's flagship reasoning model with extended thinking capabilities (V3.2 thinking mode)",
		family: "deepseek",
		vendor: "DeepSeek",
		capabilities: ["TEXT", "REASONING", "CODE", "TOOL_CALLING"],
		contextWindow: 128000,
		maxOutputTokens: 64000,
		speedTier: "QUALITY",
		qualityTier: "PREMIUM",
		inputCostPer1M: 0.28,
		outputCostPer1M: 0.42,
		suitableForTasks: ["REASONING", "COMPLEX", "EVAL"],
		providerMappings: [
			{ provider: "DEEPSEEK", providerModelId: "deepseek-reasoner" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "deepseek/deepseek-reasoner",
			},
			{ provider: "OPENROUTER", providerModelId: "deepseek/deepseek-r1" },
			{
				provider: "GROQ",
				providerModelId: "deepseek-r1-distill-llama-70b",
				inputCostPer1M: 0.75,
				outputCostPer1M: 0.99,
			},
			{
				provider: "TOGETHER_AI",
				providerModelId: "deepseek-ai/DeepSeek-R1",
			},
			{
				provider: "FIREWORKS",
				providerModelId: "accounts/fireworks/models/deepseek-r1",
			},
		],
	},

	// ============================================================================
	// Groq-Optimized Models
	// ============================================================================
	{
		canonicalName: "groq-compound",
		displayName: "Groq Compound",
		description:
			"Groq's compound AI system with agentic capabilities including web search and code execution.",
		family: "compound",
		vendor: "Groq",
		capabilities: ["TEXT", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 131072,
		maxOutputTokens: 8192,
		speedTier: "FAST",
		qualityTier: "PREMIUM",
		inputCostPer1M: 0,
		outputCostPer1M: 0,
		suitableForTasks: [
			"COMPLEX",
			"CHAT",
			"TOOL_CALLING",
			"REASONING",
			"EVAL",
		],
		providerMappings: [
			{ provider: "GROQ", providerModelId: "compound-beta" },
		],
	},
	{
		canonicalName: "qwen-3-32b",
		displayName: "Qwen 3 32B",
		description:
			"Alibaba's Qwen 3 32B model with fast inference on Groq and Cerebras",
		family: "qwen",
		vendor: "Alibaba",
		capabilities: ["TEXT", "TOOL_CALLING", "CODE"],
		contextWindow: 131072,
		maxOutputTokens: 40960,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.29,
		outputCostPer1M: 0.59,
		suitableForTasks: ["CHAT", "TOOL_CALLING"],
		providerMappings: [
			{ provider: "GROQ", providerModelId: "qwen-qwq-32b" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "alibaba/qwen-3-32b",
			},
			{ provider: "CEREBRAS", providerModelId: "qwen-3-32b" },
		],
	},

	// ============================================================================
	// OpenAI OSS Models (on Groq/Cerebras/Vercel Gateway)
	// ============================================================================
	{
		canonicalName: "gpt-oss-120b",
		displayName: "GPT OSS 120B",
		description:
			"OpenAI's open-source 120B model with built-in web search and code execution. Excellent for tool calling.",
		family: "gpt-oss",
		vendor: "OpenAI",
		capabilities: ["TEXT", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 131072,
		maxOutputTokens: 65536,
		speedTier: "FAST",
		qualityTier: "PREMIUM",
		inputCostPer1M: 0.15,
		outputCostPer1M: 0.6,
		suitableForTasks: ["COMPLEX", "TOOL_CALLING", "REASONING"],
		providerMappings: [
			{ provider: "GROQ", providerModelId: "openai/gpt-oss-120b" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/gpt-oss-120b",
			},
			{ provider: "CEREBRAS", providerModelId: "gpt-oss-120b" },
		],
	},
	{
		canonicalName: "gpt-oss-20b",
		displayName: "GPT OSS 20B",
		description:
			"OpenAI's open-source 20B model. Fast and efficient for tool calling.",
		family: "gpt-oss",
		vendor: "OpenAI",
		capabilities: ["TEXT", "TOOL_CALLING", "CODE"],
		contextWindow: 131072,
		maxOutputTokens: 65536,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.075,
		outputCostPer1M: 0.3,
		suitableForTasks: ["SIMPLE", "TOOL_CALLING"],
		providerMappings: [
			{ provider: "GROQ", providerModelId: "openai/gpt-oss-20b" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/gpt-oss-20b",
			},
		],
	},

	// ============================================================================
	// Mistral Models
	// ============================================================================
	{
		canonicalName: "mistral-large-3",
		displayName: "Mistral Large 3",
		description:
			"Mistral's flagship multimodal MoE model (41B active, 675B total parameters) with strong multilingual support",
		family: "mistral",
		vendor: "Mistral AI",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING", "CODE"],
		contextWindow: 128000,
		maxOutputTokens: 8192,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 2,
		outputCostPer1M: 6,
		suitableForTasks: ["COMPLEX", "CHAT", "TOOL_CALLING"],
		providerMappings: [
			{ provider: "MISTRAL_AI", providerModelId: "mistral-large-latest" },
			{
				provider: "OPENROUTER",
				providerModelId: "mistralai/mistral-large",
			},
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "mistral/mistral-large-latest",
			},
		],
	},
	{
		canonicalName: "mistral-small-3",
		displayName: "Mistral Small 3",
		description:
			"Fast and efficient open-weight model for general-purpose tasks",
		family: "mistral",
		vendor: "Mistral AI",
		capabilities: ["TEXT", "TOOL_CALLING", "CODE"],
		contextWindow: 32768,
		maxOutputTokens: 8192,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.2,
		outputCostPer1M: 0.6,
		suitableForTasks: ["SIMPLE", "CHAT"],
		providerMappings: [
			{ provider: "MISTRAL_AI", providerModelId: "mistral-small-latest" },
			{
				provider: "OPENROUTER",
				providerModelId: "mistralai/mistral-small",
			},
		],
	},
	{
		canonicalName: "magistral-medium",
		displayName: "Magistral Medium",
		description:
			"Mistral's enterprise reasoning model with multi-step logic and transparent reasoning",
		family: "mistral",
		vendor: "Mistral AI",
		capabilities: ["TEXT", "REASONING", "CODE"],
		contextWindow: 40000,
		maxOutputTokens: 40000,
		speedTier: "QUALITY",
		qualityTier: "PREMIUM",
		inputCostPer1M: 2,
		outputCostPer1M: 5,
		suitableForTasks: ["REASONING", "COMPLEX", "EVAL"],
		providerMappings: [
			{
				provider: "MISTRAL_AI",
				providerModelId: "magistral-medium-latest",
			},
			{
				provider: "OPENROUTER",
				providerModelId: "mistralai/magistral-medium",
			},
		],
	},
	{
		canonicalName: "magistral-small",
		displayName: "Magistral Small",
		description:
			"Mistral's open-source reasoning model (24B parameters) under Apache 2.0 license",
		family: "mistral",
		vendor: "Mistral AI",
		capabilities: ["TEXT", "REASONING", "CODE"],
		contextWindow: 40000,
		maxOutputTokens: 40000,
		speedTier: "BALANCED",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.5,
		outputCostPer1M: 1.5,
		suitableForTasks: ["REASONING", "COMPLEX", "EVAL"],
		providerMappings: [
			{ provider: "MISTRAL_AI", providerModelId: "magistral-small-2506" },
			{
				provider: "OPENROUTER",
				providerModelId: "mistralai/magistral-small",
			},
		],
	},
	{
		canonicalName: "ministral-8b",
		displayName: "Ministral 8B",
		description:
			"Mistral's compact edge model with multimodal and multilingual capability",
		family: "mistral",
		vendor: "Mistral AI",
		capabilities: ["TEXT", "CODE"],
		contextWindow: 128000,
		maxOutputTokens: 8192,
		speedTier: "FAST",
		qualityTier: "BASIC",
		inputCostPer1M: 0.1,
		outputCostPer1M: 0.1,
		suitableForTasks: ["SIMPLE"],
		providerMappings: [
			{ provider: "MISTRAL_AI", providerModelId: "ministral-8b-latest" },
			{
				provider: "OPENROUTER",
				providerModelId: "mistralai/ministral-8b",
			},
		],
	},
	{
		canonicalName: "codestral",
		displayName: "Codestral",
		description: "Mistral's code-specialized model with FIM support",
		family: "mistral",
		vendor: "Mistral AI",
		capabilities: ["TEXT", "CODE"],
		contextWindow: 128000,
		maxOutputTokens: 8192,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.3,
		outputCostPer1M: 0.9,
		suitableForTasks: ["COMPLEX"],
		providerMappings: [
			{ provider: "MISTRAL_AI", providerModelId: "codestral-latest" },
			{
				provider: "OPENROUTER",
				providerModelId: "mistralai/codestral-latest",
			},
		],
	},
	{
		canonicalName: "devstral",
		displayName: "Devstral 2",
		description:
			"Mistral's software engineering agent model, achieved 72.2% on SWE-bench Verified",
		family: "mistral",
		vendor: "Mistral AI",
		capabilities: ["TEXT", "CODE", "TOOL_CALLING"],
		contextWindow: 128000,
		maxOutputTokens: 8192,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 0.5,
		outputCostPer1M: 1.5,
		suitableForTasks: ["COMPLEX", "TOOL_CALLING"],
		providerMappings: [
			{ provider: "MISTRAL_AI", providerModelId: "devstral-latest" },
			{
				provider: "OPENROUTER",
				providerModelId: "mistralai/devstral-latest",
			},
		],
	},
	{
		canonicalName: "mistral-embed",
		displayName: "Mistral Embed",
		description: "Mistral's text embedding model for semantic search",
		family: "embedding",
		vendor: "Mistral AI",
		capabilities: ["EMBEDDING"],
		contextWindow: 8192,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.1,
		suitableForTasks: ["EMBEDDING"],
		providerMappings: [
			{ provider: "MISTRAL_AI", providerModelId: "mistral-embed" },
		],
	},

	// ============================================================================
	// xAI Grok Models
	// ============================================================================
	{
		canonicalName: "grok-4-1-fast",
		displayName: "Grok 4.1 Fast Reasoning",
		description:
			"xAI's best tool-calling model with 2M context and reasoning capabilities",
		family: "grok",
		vendor: "xAI",
		capabilities: ["TEXT", "REASONING", "CODE", "TOOL_CALLING", "VISION"],
		contextWindow: 2000000,
		maxOutputTokens: 16384,
		speedTier: "FAST",
		qualityTier: "PREMIUM",
		inputCostPer1M: 0.2,
		outputCostPer1M: 0.5,
		suitableForTasks: [
			"COMPLEX",
			"CHAT",
			"TOOL_CALLING",
			"REASONING",
			"EVAL",
		],
		providerMappings: [
			{ provider: "XAI", providerModelId: "grok-4-1-fast-reasoning" },
			{
				provider: "OPENROUTER",
				providerModelId: "x-ai/grok-4-1-fast-reasoning",
			},
		],
	},
	{
		canonicalName: "grok-4-fast",
		displayName: "Grok 4 Fast Reasoning",
		description: "xAI's Grok 4 with fast reasoning and 2M context",
		family: "grok",
		vendor: "xAI",
		capabilities: ["TEXT", "REASONING", "CODE", "TOOL_CALLING", "VISION"],
		contextWindow: 2000000,
		maxOutputTokens: 16384,
		speedTier: "FAST",
		qualityTier: "PREMIUM",
		inputCostPer1M: 3,
		outputCostPer1M: 15,
		suitableForTasks: [
			"COMPLEX",
			"CHAT",
			"TOOL_CALLING",
			"REASONING",
			"EVAL",
		],
		providerMappings: [
			{ provider: "XAI", providerModelId: "grok-4-fast-reasoning" },
			{
				provider: "OPENROUTER",
				providerModelId: "x-ai/grok-4-fast-reasoning",
			},
		],
	},
	{
		canonicalName: "grok-4",
		displayName: "Grok 4",
		description: "xAI's flagship model with 256K context",
		family: "grok",
		vendor: "xAI",
		capabilities: ["TEXT", "REASONING", "CODE", "TOOL_CALLING", "VISION"],
		contextWindow: 256000,
		maxOutputTokens: 16384,
		speedTier: "QUALITY",
		qualityTier: "PREMIUM",
		inputCostPer1M: 3,
		outputCostPer1M: 15,
		suitableForTasks: ["REASONING", "COMPLEX", "EVAL"],
		providerMappings: [
			{ provider: "XAI", providerModelId: "grok-4-0709" },
			{ provider: "OPENROUTER", providerModelId: "x-ai/grok-4-0709" },
		],
	},
	{
		canonicalName: "grok-3",
		displayName: "Grok 3",
		description: "xAI's third generation model with strong reasoning",
		family: "grok",
		vendor: "xAI",
		capabilities: ["TEXT", "REASONING", "CODE", "TOOL_CALLING"],
		contextWindow: 131072,
		maxOutputTokens: 8192,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 3,
		outputCostPer1M: 15,
		suitableForTasks: ["COMPLEX", "CHAT", "REASONING"],
		providerMappings: [
			{ provider: "XAI", providerModelId: "grok-3" },
			{ provider: "OPENROUTER", providerModelId: "x-ai/grok-3" },
		],
	},
	{
		canonicalName: "grok-3-mini",
		displayName: "Grok 3 Mini",
		description: "xAI's lightweight Grok 3 model",
		family: "grok",
		vendor: "xAI",
		capabilities: ["TEXT", "REASONING", "CODE", "TOOL_CALLING"],
		contextWindow: 131072,
		maxOutputTokens: 8192,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.3,
		outputCostPer1M: 0.5,
		suitableForTasks: ["SIMPLE", "CHAT"],
		providerMappings: [
			{ provider: "XAI", providerModelId: "grok-3-mini" },
			{ provider: "OPENROUTER", providerModelId: "x-ai/grok-3-mini" },
		],
	},
	{
		canonicalName: "grok-2-vision",
		displayName: "Grok 2 Vision",
		description: "xAI's vision-capable Grok 2 model",
		family: "grok",
		vendor: "xAI",
		capabilities: ["TEXT", "VISION", "REASONING", "CODE"],
		contextWindow: 32768,
		maxOutputTokens: 8192,
		speedTier: "BALANCED",
		qualityTier: "STANDARD",
		inputCostPer1M: 2,
		outputCostPer1M: 10,
		suitableForTasks: ["COMPLEX", "CHAT"],
		providerMappings: [
			{ provider: "XAI", providerModelId: "grok-2-vision-1212" },
			{
				provider: "OPENROUTER",
				providerModelId: "x-ai/grok-2-vision-1212",
			},
		],
	},
	{
		canonicalName: "grok-code",
		displayName: "Grok Code Fast",
		description:
			"xAI's model optimized for agentic coding with fast reasoning",
		family: "grok",
		vendor: "xAI",
		capabilities: ["TEXT", "CODE", "TOOL_CALLING", "REASONING"],
		contextWindow: 256000,
		maxOutputTokens: 16384,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.2,
		outputCostPer1M: 1.5,
		suitableForTasks: ["COMPLEX", "TOOL_CALLING"],
		providerMappings: [
			{ provider: "XAI", providerModelId: "grok-code-fast-1" },
			{
				provider: "OPENROUTER",
				providerModelId: "x-ai/grok-code-fast-1",
			},
		],
	},

	// ============================================================================
	// Perplexity Sonar Models (with web search)
	// ============================================================================
	{
		canonicalName: "sonar-pro",
		displayName: "Perplexity Sonar Pro",
		description:
			"Perplexity's advanced search model with 2x more citations, built on Llama 3.3 70B",
		family: "sonar",
		vendor: "Perplexity",
		capabilities: ["TEXT", "REASONING"],
		contextWindow: 200000,
		maxOutputTokens: 8192,
		speedTier: "FAST",
		qualityTier: "PREMIUM",
		inputCostPer1M: 3,
		outputCostPer1M: 15,
		suitableForTasks: ["CHAT", "COMPLEX"],
		providerMappings: [
			{ provider: "PERPLEXITY", providerModelId: "sonar-pro" },
			{ provider: "OPENROUTER", providerModelId: "perplexity/sonar-pro" },
		],
	},
	{
		canonicalName: "sonar",
		displayName: "Perplexity Sonar",
		description:
			"Fast lightweight search model with web grounding, 1200 tokens/sec on Cerebras",
		family: "sonar",
		vendor: "Perplexity",
		capabilities: ["TEXT"],
		contextWindow: 128000,
		maxOutputTokens: 8192,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 1,
		outputCostPer1M: 1,
		suitableForTasks: ["SIMPLE", "CHAT"],
		providerMappings: [
			{ provider: "PERPLEXITY", providerModelId: "sonar" },
			{ provider: "OPENROUTER", providerModelId: "perplexity/sonar" },
		],
	},
	{
		canonicalName: "sonar-reasoning",
		displayName: "Perplexity Sonar Reasoning",
		description: "Real-time reasoning with search capabilities",
		family: "sonar",
		vendor: "Perplexity",
		capabilities: ["TEXT", "REASONING"],
		contextWindow: 128000,
		maxOutputTokens: 8192,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 1,
		outputCostPer1M: 5,
		suitableForTasks: ["REASONING", "COMPLEX", "EVAL"],
		providerMappings: [
			{ provider: "PERPLEXITY", providerModelId: "sonar-reasoning" },
			{
				provider: "OPENROUTER",
				providerModelId: "perplexity/sonar-reasoning",
			},
		],
	},
	{
		canonicalName: "sonar-reasoning-pro",
		displayName: "Perplexity Sonar Reasoning Pro",
		description:
			"DeepSeek-R1 powered reasoning model with visible reasoning content via API",
		family: "sonar",
		vendor: "Perplexity",
		capabilities: ["TEXT", "REASONING"],
		contextWindow: 128000,
		maxOutputTokens: 16384,
		speedTier: "QUALITY",
		qualityTier: "PREMIUM",
		inputCostPer1M: 2,
		outputCostPer1M: 8,
		suitableForTasks: ["REASONING", "COMPLEX", "EVAL"],
		providerMappings: [
			{ provider: "PERPLEXITY", providerModelId: "sonar-reasoning-pro" },
			{
				provider: "OPENROUTER",
				providerModelId: "perplexity/sonar-reasoning-pro",
			},
		],
	},
	{
		canonicalName: "sonar-deep-research",
		displayName: "Perplexity Sonar Deep Research",
		description:
			"Produces long-form, source-dense reports with adjustable reasoning depth",
		family: "sonar",
		vendor: "Perplexity",
		capabilities: ["TEXT", "REASONING"],
		contextWindow: 128000,
		maxOutputTokens: 32768,
		speedTier: "QUALITY",
		qualityTier: "PREMIUM",
		inputCostPer1M: 2,
		outputCostPer1M: 8,
		suitableForTasks: ["REASONING", "COMPLEX", "EVAL"],
		providerMappings: [
			{ provider: "PERPLEXITY", providerModelId: "sonar-deep-research" },
		],
	},

	// ============================================================================
	// Cohere Models
	// ============================================================================
	{
		canonicalName: "command-a",
		displayName: "Cohere Command A",
		description:
			"Cohere's most performant model (111B params) for tool use, RAG, agents, and multilingual tasks",
		family: "command",
		vendor: "Cohere",
		capabilities: ["TEXT", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 256000,
		maxOutputTokens: 8192,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 2.5,
		outputCostPer1M: 10,
		suitableForTasks: ["COMPLEX", "CHAT", "TOOL_CALLING"],
		providerMappings: [
			{ provider: "COHERE", providerModelId: "command-a-03-2025" },
			{ provider: "OPENROUTER", providerModelId: "cohere/command-a" },
		],
	},
	{
		canonicalName: "command-a-reasoning",
		displayName: "Cohere Command A Reasoning",
		description:
			"Cohere's hybrid reasoning model (111B params, 256K context) for complex agentic tasks in 23 languages",
		family: "command",
		vendor: "Cohere",
		capabilities: ["TEXT", "TOOL_CALLING", "CODE", "REASONING"],
		contextWindow: 256000,
		maxOutputTokens: 32000,
		speedTier: "QUALITY",
		qualityTier: "PREMIUM",
		inputCostPer1M: 2.5,
		outputCostPer1M: 10,
		suitableForTasks: ["REASONING", "COMPLEX", "TOOL_CALLING"],
		providerMappings: [
			{
				provider: "COHERE",
				providerModelId: "command-a-reasoning-08-2025",
			},
		],
	},
	{
		canonicalName: "command-a-vision",
		displayName: "Cohere Command A Vision",
		description:
			"Cohere's multimodal model capable of understanding visual data alongside text",
		family: "command",
		vendor: "Cohere",
		capabilities: ["TEXT", "VISION", "TOOL_CALLING"],
		contextWindow: 128000,
		maxOutputTokens: 8192,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 2.5,
		outputCostPer1M: 10,
		suitableForTasks: ["COMPLEX", "CHAT"],
		providerMappings: [
			{ provider: "COHERE", providerModelId: "command-a-vision-07-2025" },
		],
	},
	{
		canonicalName: "command-r-plus",
		displayName: "Cohere Command R+",
		description:
			"Optimized for conversational interaction, complex RAG workflows, and multi-step tool use",
		family: "command",
		vendor: "Cohere",
		capabilities: ["TEXT", "TOOL_CALLING", "CODE"],
		contextWindow: 128000,
		maxOutputTokens: 4096,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 2.5,
		outputCostPer1M: 10,
		suitableForTasks: ["COMPLEX", "CHAT", "TOOL_CALLING"],
		providerMappings: [
			{ provider: "COHERE", providerModelId: "command-r-plus-08-2024" },
			{
				provider: "OPENROUTER",
				providerModelId: "cohere/command-r-plus",
			},
		],
	},
	{
		canonicalName: "command-r",
		displayName: "Cohere Command R",
		description:
			"Conversational model that excels in language tasks and supports multiple languages",
		family: "command",
		vendor: "Cohere",
		capabilities: ["TEXT", "TOOL_CALLING"],
		contextWindow: 128000,
		maxOutputTokens: 4096,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.15,
		outputCostPer1M: 0.6,
		suitableForTasks: ["CHAT", "SIMPLE"],
		providerMappings: [
			{ provider: "COHERE", providerModelId: "command-r-08-2024" },
			{ provider: "OPENROUTER", providerModelId: "cohere/command-r" },
		],
	},
	{
		canonicalName: "command-r7b",
		displayName: "Cohere Command R7B",
		description:
			"Smallest and fastest Command model, excels at RAG, tool use, and agents",
		family: "command",
		vendor: "Cohere",
		capabilities: ["TEXT", "TOOL_CALLING"],
		contextWindow: 128000,
		maxOutputTokens: 4096,
		speedTier: "FAST",
		qualityTier: "BASIC",
		inputCostPer1M: 0.0375,
		outputCostPer1M: 0.15,
		suitableForTasks: ["SIMPLE", "TOOL_CALLING"],
		providerMappings: [
			{ provider: "COHERE", providerModelId: "command-r7b-12-2024" },
			{ provider: "OPENROUTER", providerModelId: "cohere/command-r7b" },
		],
	},
	{
		canonicalName: "cohere-embed-v4",
		displayName: "Cohere Embed v4",
		description:
			"Cohere's multimodal embedding model for text, images, and PDFs with 128K context",
		family: "embedding",
		vendor: "Cohere",
		capabilities: ["EMBEDDING"],
		contextWindow: 128000,
		speedTier: "FAST",
		qualityTier: "PREMIUM",
		inputCostPer1M: 0.1,
		suitableForTasks: ["EMBEDDING"],
		providerMappings: [
			{ provider: "COHERE", providerModelId: "embed-v4.0" },
		],
	},
	{
		canonicalName: "cohere-embed-english",
		displayName: "Cohere Embed English v3",
		description: "Cohere's English embedding model for semantic search",
		family: "embedding",
		vendor: "Cohere",
		capabilities: ["EMBEDDING"],
		contextWindow: 512,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.1,
		suitableForTasks: ["EMBEDDING"],
		providerMappings: [
			{ provider: "COHERE", providerModelId: "embed-english-v3.0" },
		],
	},
	{
		canonicalName: "cohere-embed-multilingual",
		displayName: "Cohere Embed Multilingual v3",
		description:
			"Cohere's multilingual embedding model supporting 100+ languages",
		family: "embedding",
		vendor: "Cohere",
		capabilities: ["EMBEDDING"],
		contextWindow: 512,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.1,
		suitableForTasks: ["EMBEDDING"],
		providerMappings: [
			{ provider: "COHERE", providerModelId: "embed-multilingual-v3.0" },
		],
	},
	{
		canonicalName: "cohere-rerank",
		displayName: "Cohere Rerank v3.5",
		description:
			"Cohere's reranking model for improving search relevance (4K context)",
		family: "rerank",
		vendor: "Cohere",
		capabilities: ["TEXT"],
		contextWindow: 4096,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 2,
		suitableForTasks: ["SIMPLE"],
		providerMappings: [
			{ provider: "COHERE", providerModelId: "rerank-v3.5" },
		],
	},
	{
		canonicalName: "cohere-rerank-pro",
		displayName: "Cohere Rerank v4 Pro",
		description:
			"Cohere's state-of-the-art multilingual reranking model for complex use-cases (32K context)",
		family: "rerank",
		vendor: "Cohere",
		capabilities: ["TEXT"],
		contextWindow: 32000,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 3,
		suitableForTasks: ["COMPLEX"],
		providerMappings: [
			{ provider: "COHERE", providerModelId: "rerank-v4.0-pro" },
		],
	},

	// ============================================================================
	// Embedding Models
	// ============================================================================
	{
		canonicalName: "text-embedding-3-small",
		displayName: "Text Embedding 3 Small",
		description: "OpenAI's small embedding model for semantic search",
		family: "embedding",
		vendor: "OpenAI",
		capabilities: ["EMBEDDING"],
		contextWindow: 8191,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.02,
		suitableForTasks: ["EMBEDDING"],
		providerMappings: [
			{
				provider: "OPENAI_DIRECT",
				providerModelId: "text-embedding-3-small",
			},
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/text-embedding-3-small",
			},
			{
				provider: "AZURE_AI_FOUNDRY",
				providerModelId: "text-embedding-3-small",
			},
		],
	},
	{
		canonicalName: "text-embedding-3-large",
		displayName: "Text Embedding 3 Large",
		description:
			"OpenAI's large embedding model for high-quality embeddings",
		family: "embedding",
		vendor: "OpenAI",
		capabilities: ["EMBEDDING"],
		contextWindow: 8191,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		inputCostPer1M: 0.13,
		suitableForTasks: ["EMBEDDING"],
		providerMappings: [
			{
				provider: "OPENAI_DIRECT",
				providerModelId: "text-embedding-3-large",
			},
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/text-embedding-3-large",
			},
			{
				provider: "AZURE_AI_FOUNDRY",
				providerModelId: "text-embedding-3-large",
			},
		],
	},
	{
		canonicalName: "text-embedding-ada-002",
		displayName: "Text Embedding Ada 002",
		description:
			"OpenAI's legacy embedding model, widely deployed on Azure",
		family: "embedding",
		vendor: "OpenAI",
		capabilities: ["EMBEDDING"],
		contextWindow: 8191,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		inputCostPer1M: 0.1,
		suitableForTasks: ["EMBEDDING"],
		providerMappings: [
			{
				provider: "OPENAI_DIRECT",
				providerModelId: "text-embedding-ada-002",
			},
			{
				provider: "AZURE_AI_FOUNDRY",
				providerModelId: "text-embedding-ada-002",
			},
		],
	},
	{
		canonicalName: "databricks-gte-large-en",
		displayName: "Databricks GTE Large (En)",
		description:
			"Databricks-hosted GTE Large English embedding model (1024-dim, 8192-token window)",
		family: "embedding",
		vendor: "Databricks",
		capabilities: ["EMBEDDING"],
		contextWindow: 8192,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		suitableForTasks: ["EMBEDDING"],
		providerMappings: [
			{
				provider: "DATABRICKS",
				providerModelId: "system.ai.gte-large-en",
			},
		],
	},
	{
		canonicalName: "databricks-bge-large-en",
		displayName: "Databricks BGE Large (En)",
		description:
			"Databricks-hosted BGE Large English embedding model (1024-dim, normalized, 512-token window)",
		family: "embedding",
		vendor: "Databricks",
		capabilities: ["EMBEDDING"],
		contextWindow: 512,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		suitableForTasks: ["EMBEDDING"],
		providerMappings: [
			{
				provider: "DATABRICKS",
				providerModelId: "system.ai.bge-large-en",
			},
		],
	},

	// ============================================================================
	// Image Models
	// ============================================================================
	{
		canonicalName: "dall-e-3",
		displayName: "DALL-E 3",
		description: "OpenAI's image generation model",
		family: "dalle",
		vendor: "OpenAI",
		capabilities: ["IMAGE"],
		contextWindow: 4000,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		suitableForTasks: ["IMAGE"],
		providerMappings: [
			{ provider: "OPENAI_DIRECT", providerModelId: "dall-e-3" },
			{ provider: "VERCEL_GATEWAY", providerModelId: "openai/dall-e-3" },
		],
	},
	{
		canonicalName: "gpt-image-2",
		displayName: "GPT Image 2",
		description:
			"OpenAI's state-of-the-art image generation and editing model. Supports flexible image sizes and high-fidelity image inputs via Vercel AI Gateway.",
		family: "gpt-image",
		vendor: "OpenAI",
		capabilities: ["IMAGE"],
		contextWindow: 4000,
		speedTier: "FAST",
		qualityTier: "PREMIUM",
		inputCostPer1M: 5,
		outputCostPer1M: 30,
		suitableForTasks: ["IMAGE"],
		providerMappings: [
			{ provider: "OPENAI_DIRECT", providerModelId: "gpt-image-2" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/gpt-image-2",
				inputCostPer1M: 5,
				outputCostPer1M: 30,
			},
		],
	},
	{
		canonicalName: "gemini-3.1-flash-image-preview",
		displayName: "Nano Banana Fast (Gemini 3.1 Flash Image)",
		description:
			"Google's fast image generation model via Vercel AI Gateway. Supports text-to-image and image editing.",
		family: "gemini",
		vendor: "Google",
		capabilities: ["IMAGE"],
		contextWindow: 8192,
		speedTier: "FAST",
		qualityTier: "STANDARD",
		suitableForTasks: ["IMAGE"],
		providerMappings: [
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "google/gemini-3.1-flash-image-preview",
			},
		],
	},
	{
		canonicalName: "gemini-3-pro-image",
		displayName: "Nano Banana Pro (Gemini 3 Pro Image)",
		description:
			"Google's high-quality image generation model via Vercel AI Gateway. Supports text-to-image and image editing.",
		family: "gemini",
		vendor: "Google",
		capabilities: ["IMAGE"],
		contextWindow: 8192,
		speedTier: "BALANCED",
		qualityTier: "PREMIUM",
		suitableForTasks: ["IMAGE"],
		providerMappings: [
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "google/gemini-3-pro-image",
			},
		],
	},

	// ============================================================================
	// Audio Models
	// ============================================================================
	{
		canonicalName: "whisper-1",
		displayName: "Whisper",
		description: "OpenAI's speech-to-text model",
		family: "whisper",
		vendor: "OpenAI",
		capabilities: ["AUDIO"],
		contextWindow: 0,
		speedTier: "BALANCED",
		qualityTier: "STANDARD",
		suitableForTasks: ["AUDIO"],
		providerMappings: [
			{ provider: "OPENAI_DIRECT", providerModelId: "whisper-1" },
			{ provider: "VERCEL_GATEWAY", providerModelId: "openai/whisper-1" },
			{ provider: "GROQ", providerModelId: "whisper-large-v3" },
		],
	},
];

// ============================================================================
// Task Default Mappings (Provider-Specific)
// ============================================================================

// Helper to create defaults for a task type across providers
function createTaskDefaults(
	taskType: AiTaskType,
	complexity: TaskComplexity,
	providerModels: Partial<Record<AIProvider, string>>,
	options?: { requiresToolCalling?: boolean },
): TaskDefaultSeed[] {
	return Object.entries(providerModels)
		.filter(([_, canonicalName]) => canonicalName !== undefined)
		.map(([provider, canonicalName]) => ({
			taskType,
			complexity,
			canonicalName: canonicalName as string,
			provider: provider as AIProvider,
			priority: 100,
			requiresToolCalling: options?.requiresToolCalling,
		}));
}

export const TASK_DEFAULTS: TaskDefaultSeed[] = [
	// ============================================================================
	// SIMPLE Tasks - Fast, cheap models
	// ============================================================================
	...createTaskDefaults("SIMPLE", "MEDIUM", {
		DATABRICKS: "llama-3-3-70b",
		VERCEL_GATEWAY: "claude-haiku-4-5",
		OPENAI_DIRECT: "gpt-4o-mini",
		ANTHROPIC_DIRECT: "claude-haiku-4-5",
		GROQ: "llama-3-1-8b",
		DEEPSEEK: "deepseek-chat",
		CEREBRAS: "llama-3-1-8b",
		AZURE_AI_FOUNDRY: "gpt-4.1-mini",
		MISTRAL_AI: "mistral-small-3",
		XAI: "grok-3-mini",
		COHERE: "command-r",
		PERPLEXITY: "sonar",
		TOGETHER_AI: "llama-3-1-8b",
		FIREWORKS: "llama-3-1-8b",
	}),

	// ============================================================================
	// COMPLEX Tasks - Capable models for detailed work
	// ============================================================================
	...createTaskDefaults("COMPLEX", "MEDIUM", {
		DATABRICKS: "claude-sonnet-5",
		VERCEL_GATEWAY: "claude-sonnet-5",
		OPENAI_DIRECT: "gpt-4o",
		ANTHROPIC_DIRECT: "claude-sonnet-5",
		GROQ: "llama-3-3-70b",
		DEEPSEEK: "deepseek-chat",
		CEREBRAS: "llama-3-3-70b",
		AZURE_AI_FOUNDRY: "gpt-4.1-mini",
		MISTRAL_AI: "mistral-large-3",
		XAI: "grok-3",
		COHERE: "command-a",
		PERPLEXITY: "sonar-pro",
		TOGETHER_AI: "llama-3-3-70b",
		FIREWORKS: "llama-3-3-70b",
	}),

	// ============================================================================
	// REASONING Tasks - Reasoning-optimized models
	// ============================================================================
	...createTaskDefaults("REASONING", "MEDIUM", {
		VERCEL_GATEWAY: "claude-opus-4-8",
		OPENAI_DIRECT: "o1",
		ANTHROPIC_DIRECT: "claude-opus-4-8",
		GROQ: "deepseek-r1",
		DEEPSEEK: "deepseek-r1",
		CEREBRAS: "gpt-oss-120b",
		AZURE_AI_FOUNDRY: "gpt-4o",
		MISTRAL_AI: "magistral-medium",
		XAI: "grok-4",
		COHERE: "command-a-reasoning",
		PERPLEXITY: "sonar-reasoning-pro",
	}),

	// ============================================================================
	// CHAT Tasks - Conversational models
	// ============================================================================
	...createTaskDefaults("CHAT", "MEDIUM", {
		DATABRICKS: "claude-sonnet-5",
		VERCEL_GATEWAY: "claude-sonnet-5",
		OPENAI_DIRECT: "gpt-4o",
		ANTHROPIC_DIRECT: "claude-sonnet-5",
		GROQ: "llama-3-3-70b",
		DEEPSEEK: "deepseek-chat",
		CEREBRAS: "llama-3-3-70b",
		AZURE_AI_FOUNDRY: "gpt-4.1-mini",
		MISTRAL_AI: "mistral-large-3",
		XAI: "grok-4-1-fast",
		COHERE: "command-a",
		PERPLEXITY: "sonar-pro",
		TOGETHER_AI: "llama-3-3-70b",
		FIREWORKS: "llama-3-3-70b",
	}),

	// ============================================================================
	// TOOL_CALLING Tasks - Models with good function calling
	// ============================================================================
	...createTaskDefaults(
		"TOOL_CALLING",
		"MEDIUM",
		{
			DATABRICKS: "claude-sonnet-5",
			VERCEL_GATEWAY: "claude-sonnet-5",
			OPENAI_DIRECT: "gpt-4o",
			ANTHROPIC_DIRECT: "claude-sonnet-5",
			GROQ: "gpt-oss-120b",
			DEEPSEEK: "deepseek-chat",
			CEREBRAS: "gpt-oss-120b",
			AZURE_AI_FOUNDRY: "gpt-4o",
			MISTRAL_AI: "mistral-large-3",
			XAI: "grok-4-1-fast",
			COHERE: "command-a",
		},
		{ requiresToolCalling: true },
	),

	// ============================================================================
	// EMBEDDING Tasks
	// ============================================================================
	...createTaskDefaults("EMBEDDING", "MEDIUM", {
		DATABRICKS: "databricks-gte-large-en",
		VERCEL_GATEWAY: "text-embedding-3-small",
		OPENAI_DIRECT: "text-embedding-3-small",
		AZURE_AI_FOUNDRY: "text-embedding-3-small",
		MISTRAL_AI: "mistral-embed",
		COHERE: "cohere-embed-english",
	}),

	// ============================================================================
	// IMAGE Tasks
	// ============================================================================
	...createTaskDefaults("IMAGE", "MEDIUM", {
		VERCEL_GATEWAY: "gemini-3.1-flash-image-preview",
		OPENAI_DIRECT: "dall-e-3",
	}),

	// ============================================================================
	// AUDIO Tasks
	// ============================================================================
	...createTaskDefaults("AUDIO", "MEDIUM", {
		VERCEL_GATEWAY: "whisper-1",
		OPENAI_DIRECT: "whisper-1",
		GROQ: "whisper-1",
	}),

	// ============================================================================
	// EVAL Tasks - Models for LLM-as-judge evaluation
	// ============================================================================
	...createTaskDefaults("EVAL", "MEDIUM", {
		VERCEL_GATEWAY: "claude-sonnet-5",
		OPENAI_DIRECT: "gpt-4o-mini",
		ANTHROPIC_DIRECT: "claude-sonnet-5",
		GROQ: "llama-3-3-70b",
		DEEPSEEK: "deepseek-chat",
		CEREBRAS: "llama-3-3-70b",
		AZURE_AI_FOUNDRY: "gpt-4o-mini",
		MISTRAL_AI: "mistral-large-3",
		XAI: "grok-4-1-fast",
		COHERE: "command-a",
		PERPLEXITY: "sonar-pro",
		TOGETHER_AI: "llama-3-3-70b",
		FIREWORKS: "llama-3-3-70b",
	}),
];

// ============================================================================
// Model Capabilities Lookup (for UI and runtime capability checking)
// ============================================================================

/**
 * Model capabilities interface for UI display and runtime checks.
 * This is derived from the catalog data above.
 */
export interface ModelCapabilities {
	/** Supports image/vision input */
	vision: boolean;
	/** Supports reasoning/thinking mode */
	reasoning: boolean;
	/** Supports PDF document input */
	pdf: boolean;
	/** Optimized for speed */
	fast: boolean;
	/** Optimized for code generation */
	code: boolean;
	/** Supports tool/function calling */
	toolCalling: boolean;
	/** Maximum output tokens */
	maxOutputTokens: number;
	/** Context window size */
	contextWindow: number;
	/** Quality tier */
	qualityTier: "basic" | "standard" | "premium";
	/** Speed tier */
	speedTier: "fast" | "balanced" | "quality";
	/** Human-readable description */
	description?: string;
	/** Is this a recently released model */
	isNew?: boolean;
}

/**
 * Default capabilities for unknown models
 */
export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
	vision: false,
	reasoning: false,
	pdf: false,
	fast: false,
	code: false,
	toolCalling: true,
	maxOutputTokens: 4096,
	contextWindow: 8192,
	qualityTier: "standard",
	speedTier: "balanced",
};

/**
 * Convert catalog capabilities to ModelCapabilities format
 */
function convertCatalogCapabilities(model: ModelSeedData): ModelCapabilities {
	const caps = model.capabilities;
	return {
		vision: caps.includes("VISION"),
		reasoning: caps.includes("REASONING"),
		pdf: caps.includes("VISION"), // PDF support typically comes with vision
		fast: model.speedTier === "FAST",
		code: caps.includes("CODE"),
		toolCalling: caps.includes("TOOL_CALLING"),
		maxOutputTokens: model.maxOutputTokens ?? 4096,
		contextWindow: model.contextWindow,
		qualityTier: model.qualityTier.toLowerCase() as
			| "basic"
			| "standard"
			| "premium",
		speedTier: model.speedTier.toLowerCase() as
			| "fast"
			| "balanced"
			| "quality",
		description: model.description,
	};
}

/**
 * Build a lookup map of providerModelId → ModelCapabilities
 * This is the SINGLE SOURCE OF TRUTH for model capabilities.
 */
function buildCapabilitiesLookup(): Map<string, ModelCapabilities> {
	const lookup = new Map<string, ModelCapabilities>();

	for (const model of MODELS) {
		const capabilities = convertCatalogCapabilities(model);

		// Add entry for canonical name
		lookup.set(model.canonicalName, capabilities);

		// Add entries for each provider's model ID
		for (const mapping of model.providerMappings) {
			lookup.set(mapping.providerModelId, capabilities);
			// Also add lowercase version for case-insensitive lookup
			lookup.set(mapping.providerModelId.toLowerCase(), capabilities);
		}
	}

	return lookup;
}

/**
 * Pre-built capabilities lookup map.
 * Use getModelCapabilitiesFromCatalog() for lookups.
 */
const MODEL_CAPABILITIES_LOOKUP = buildCapabilitiesLookup();

/**
 * Get capabilities for a model by its ID (canonical name or provider-specific ID).
 * This is the recommended way to look up model capabilities.
 *
 * @param modelId - The model ID (e.g., "gpt-4o", "openai/gpt-4o", "llama-3.3-70b-versatile")
 * @returns ModelCapabilities or default capabilities if not found
 */
export function getModelCapabilitiesFromCatalog(
	modelId: string,
): ModelCapabilities {
	// Try exact match
	const exact = MODEL_CAPABILITIES_LOOKUP.get(modelId);
	if (exact) {
		return exact;
	}

	// Try lowercase
	const lower = MODEL_CAPABILITIES_LOOKUP.get(modelId.toLowerCase());
	if (lower) {
		return lower;
	}

	// Try extracting model name after slash (e.g., "openai/gpt-4o" → "gpt-4o")
	if (modelId.includes("/")) {
		const modelName = modelId.split("/").pop();
		if (modelName) {
			const byName = MODEL_CAPABILITIES_LOOKUP.get(modelName);
			if (byName) {
				return byName;
			}
			const byNameLower = MODEL_CAPABILITIES_LOOKUP.get(
				modelName.toLowerCase(),
			);
			if (byNameLower) {
				return byNameLower;
			}
		}
	}

	// Return defaults for unknown models
	return DEFAULT_MODEL_CAPABILITIES;
}

/**
 * Export capabilities as a plain object for client-side usage.
 * This can be safely imported in browser code.
 */
export const MODEL_CAPABILITIES_MAP: Record<string, ModelCapabilities> =
	Object.fromEntries(MODEL_CAPABILITIES_LOOKUP.entries());

// ============================================================================
// Default Models and Aliases (for use across the application)
// ============================================================================

/**
 * Default models by task type (canonical names).
 * Use getProviderModelId() to get the provider-specific model ID.
 */
export const DEFAULT_MODELS = {
	/** Fast, cheap model for simple tasks */
	SIMPLE: "gpt-4o-mini",
	/** Capable model for complex tasks */
	COMPLEX: "gpt-4o",
	/** Conversational model */
	CHAT: "gpt-4o",
	/** Model with tool calling support */
	TOOL_CALLING: "gpt-4o",
	/** Reasoning model for deep analysis */
	REASONING: "o1",
	/** Embedding model for RAG */
	EMBEDDING: "text-embedding-3-small",
	/** Evaluation model for LLM-as-judge */
	EVAL: "gpt-4o-mini",
} as const;

/**
 * Model alias map - maps common short names to canonical model names.
 * Use this instead of hardcoding model aliases elsewhere.
 */
export const MODEL_ALIASES: Record<string, string> = {
	// OpenAI shortcuts
	"gpt-4": "gpt-4-turbo",
	"gpt-4o": "gpt-4o",
	"gpt-4o-mini": "gpt-4o-mini",
	"gpt-5": "gpt-5-2",
	"gpt-5.2": "gpt-5-2",
	"gpt-5-nano": "gpt-5-nano",
	"gpt-5-mini": "gpt-5-mini",
	"gpt-3.5": "gpt-3-5-turbo",
	o1: "o1",
	"o1-mini": "o1-mini",
	"o3-mini": "o3-mini",

	// Anthropic shortcuts
	claude: "claude-sonnet-5",
	"claude-3": "claude-sonnet-5",
	"claude-3.5": "claude-sonnet-5",
	"claude-sonnet": "claude-sonnet-5",
	"claude-opus": "claude-opus-4-8",
	"claude-haiku": "claude-haiku-4-5",

	// Llama shortcuts
	llama: "llama-3-3-70b",
	"llama-3": "llama-3-3-70b",
	"llama-3.3": "llama-3-3-70b",
	"llama-70b": "llama-3-3-70b",
	"llama-8b": "llama-3-1-8b",

	// Gemini shortcuts
	gemini: "gemini-2-5-flash",
	"gemini-pro": "gemini-2-5-pro",
	"gemini-flash": "gemini-2-5-flash",
	"gemini-3": "gemini-3-flash",
	"gemini-3-pro": "gemini-3-1-pro",

	// DeepSeek shortcuts
	deepseek: "deepseek-chat",
	"deepseek-r1": "deepseek-r1",
	"deepseek-v3": "deepseek-chat",

	// Mistral shortcuts
	mistral: "mistral-large-3",
	"mistral-large": "mistral-large-3",
	"mistral-small": "mistral-small-3",
	magistral: "magistral-medium",
	codestral: "codestral",
	devstral: "devstral",

	// xAI Grok shortcuts
	grok: "grok-4-1-fast",
	"grok-4": "grok-4",
	"grok-3": "grok-3",

	// Cohere shortcuts
	command: "command-a",
	"command-a": "command-a",
	"command-r": "command-r",
	"command-r+": "command-r-plus",

	// Perplexity shortcuts
	sonar: "sonar",
	"sonar-pro": "sonar-pro",
	perplexity: "sonar-pro",
};

/**
 * Get cost per 1M tokens for a model (from provider mapping or model default).
 */
export function getModelCost(
	canonicalName: string,
	provider?: AIProvider,
): { inputCostPer1M: number; outputCostPer1M: number } | undefined {
	const model = MODELS.find((m) => m.canonicalName === canonicalName);
	if (!model) {
		return undefined;
	}

	// Try to get provider-specific cost first
	if (provider) {
		const mapping = model.providerMappings.find(
			(m) => m.provider === provider,
		);
		if (mapping?.inputCostPer1M !== undefined) {
			return {
				inputCostPer1M: mapping.inputCostPer1M,
				outputCostPer1M:
					mapping.outputCostPer1M ?? mapping.inputCostPer1M * 2,
			};
		}
	}

	// Fall back to model default
	if (model.inputCostPer1M !== undefined) {
		return {
			inputCostPer1M: model.inputCostPer1M,
			outputCostPer1M: model.outputCostPer1M ?? model.inputCostPer1M * 2,
		};
	}

	return undefined;
}
