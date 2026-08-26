/**
 * Mastra evaluation configuration helpers.
 */

import { Mastra } from "@mastra/core";
import type { MastraModelConfig } from "@mastra/core/llm";
import {
	type AIModelMetadata,
	AIProviderNotConfiguredError,
	getAIModelWithMetadata,
	type LanguageModel,
} from "@repo/ai";

export interface MastraEvalModel {
	model: LanguageModel;
	metadata: AIModelMetadata;
	trackUsage: () => void;
}

export async function resolveEvalModel(params: {
	userId: string;
	organizationId?: string;
}): Promise<MastraEvalModel | null> {
	try {
		const result = await getAIModelWithMetadata(
			{ taskType: "EVAL" },
			{ userId: params.userId, organizationId: params.organizationId },
		);
		return result;
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			return null;
		}
		throw error;
	}
}

export function createMastraInstance(): Mastra {
	return new Mastra({ logger: false });
}

/**
 * Remove temperature from model call options.
 * Some models (especially Azure deployments like gpt-5-nano) don't support
 * temperature settings at all and will error if any temperature is provided.
 */
function removeTemperatureFromOptions(options: unknown): unknown {
	if (
		options &&
		typeof options === "object" &&
		"temperature" in (options as Record<string, unknown>)
	) {
		const { temperature: _temperature, ...rest } = options as Record<
			string,
			unknown
		>;
		return rest;
	}
	return options;
}

/**
 * Wrap a LanguageModel to remove temperature from all requests.
 * This is specifically for eval workflows where some models (e.g., Azure gpt-5-nano)
 * don't support temperature settings.
 *
 * Uses a Proxy to intercept calls while preserving the original model's
 * private fields and non-enumerable instance state.
 */
function wrapModelWithoutTemperature(model: LanguageModel): LanguageModel {
	// If model is a string (model name), return as-is - can't wrap strings
	if (typeof model === "string") {
		return model;
	}

	return new Proxy(model, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (prop === "doGenerate" || prop === "doStream") {
				if (typeof value === "function") {
					return async (options: unknown) => {
						const cleanedOptions =
							removeTemperatureFromOptions(options);
						return value.call(target, cleanedOptions);
					};
				}
			}
			return value;
		},
	}) as LanguageModel;
}

/**
 * Convert an AI SDK LanguageModel to a Mastra-compatible config.
 *
 * Mastra's resolveModelConfig expects one of:
 * 1. A string like "openai/gpt-4o"
 * 2. An OpenAICompatibleObjectConfig with url, apiKey, model
 * 3. An AI SDK model object with specificationVersion
 *
 * We pass the AI SDK model object directly, which should work if it has
 * the correct specificationVersion.
 *
 * IMPORTANT: For eval workflows, we wrap the model to remove temperature
 * from all requests. Some models (e.g., Azure gpt-5-nano) don't support
 * temperature settings and will error if any value is provided.
 */
export function toMastraModelConfig(model: LanguageModel): MastraModelConfig {
	// Wrap the model to remove temperature from eval requests
	// This ensures compatibility with models that don't support temperature settings
	const wrappedModel = wrapModelWithoutTemperature(model);

	// Mastra expects AI SDK provider types - our model should be compatible
	// but Azure AI Foundry uses a custom fetch wrapper which might cause issues
	return wrappedModel as unknown as MastraModelConfig;
}

// EVAL_VERSION 3: Evidence-based calibration with score deflation
// LLMs tend to over-score, so we apply metric-specific deflation

const PROVIDER_CALIBRATION: Record<string, Record<string, number>> = {
	// Providers tend to over-score, so we deflate
	OPENAI_DIRECT: {
		quality: 0.9, // OpenAI tends to be generous
		coherence: 0.92,
		alignment: 0.95,
	},
	ANTHROPIC_DIRECT: {
		quality: 0.88, // Anthropic even more generous
		coherence: 0.9,
		alignment: 0.92,
	},
	GROQ: {
		quality: 0.85, // Smaller models even more so
		coherence: 0.85,
		alignment: 0.88,
	},
	TOGETHER_AI: {
		quality: 0.85,
		coherence: 0.85,
		alignment: 0.88,
	},
	// Gateways inherit from underlying provider
	VERCEL_GATEWAY: {
		quality: 0.88,
		coherence: 0.9,
		alignment: 0.92,
	},
	AZURE_AI_FOUNDRY: {
		quality: 0.9,
		coherence: 0.92,
		alignment: 0.95,
	},
	AWS_BEDROCK: {
		quality: 0.9,
		coherence: 0.92,
		alignment: 0.95,
	},
	GOOGLE_VERTEX_AI: {
		quality: 0.9,
		coherence: 0.92,
		alignment: 0.95,
	},
};

/**
 * Calibrate LLM scores with metric-specific adjustment and non-linear deflation
 *
 * @param rawScore - The raw score from the LLM (0-100)
 * @param provider - The AI provider name
 * @param metric - The metric type being scored
 * @returns Calibrated score (0-100)
 */
export function calibrateScore(
	rawScore: number,
	provider: string,
	metric: "quality" | "coherence" | "alignment" = "quality",
): number {
	const providerFactors =
		PROVIDER_CALIBRATION[provider] ?? PROVIDER_CALIBRATION.OPENAI_DIRECT;
	const factor = providerFactors[metric] ?? 0.9;

	// Apply non-linear deflation: higher scores get deflated more
	let adjustedScore = rawScore * factor;

	// Additional deflation for very high scores (combat LLM's tendency to score high)
	if (rawScore > 90) {
		adjustedScore *= 0.95; // Extra 5% reduction for 90+ scores
	} else if (rawScore > 80) {
		adjustedScore *= 0.98; // Extra 2% reduction for 80-90 scores
	}

	return Math.min(100, Math.round(adjustedScore));
}
