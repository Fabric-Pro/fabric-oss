/**
 * Model Capabilities
 *
 * This module provides model capability lookups using the AI Model Catalog
 * as the SINGLE SOURCE OF TRUTH.
 *
 * DO NOT add hardcoded model names here - update ai-model-catalog.ts instead.
 */

// Re-export types and functions from the catalog
export {
	DEFAULT_MODEL_CAPABILITIES,
	getModelCapabilitiesFromCatalog,
	MODEL_CAPABILITIES_MAP,
	type ModelCapabilities,
} from "@repo/database/prisma/ai-model-catalog";

import {
	DEFAULT_MODEL_CAPABILITIES,
	getModelCapabilitiesFromCatalog,
	type ModelCapabilities,
} from "@repo/database/prisma/ai-model-catalog";

/**
 * Get capabilities for a specific model.
 * This is the main entry point - delegates to the catalog.
 *
 * @param modelId - The model ID (e.g., "gpt-4o", "openai/gpt-4o", "llama-3.3-70b-versatile")
 * @returns ModelCapabilities
 */
export function getModelCapabilities(modelId: string): ModelCapabilities {
	return getModelCapabilitiesFromCatalog(modelId);
}

/**
 * Check if a model supports a specific capability
 */
export function modelSupports(
	modelId: string,
	capability: keyof ModelCapabilities,
): boolean {
	const caps = getModelCapabilities(modelId);
	return Boolean(caps[capability]);
}

/**
 * Get models that support a specific capability
 */
export function getModelsWithCapability(
	models: Array<{ id: string }>,
	capability: keyof ModelCapabilities,
): Array<{ id: string }> {
	return models.filter((m) => modelSupports(m.id, capability));
}

/**
 * Get a formatted description for model capabilities
 */
export function getCapabilityDescription(caps: ModelCapabilities): string {
	const features: string[] = [];
	if (caps.vision) {
		features.push("Vision");
	}
	if (caps.reasoning) {
		features.push("Reasoning");
	}
	if (caps.pdf) {
		features.push("PDF");
	}
	if (caps.fast) {
		features.push("Fast");
	}
	if (caps.code) {
		features.push("Code");
	}
	if (caps.toolCalling) {
		features.push("Tools");
	}
	return features.join(" • ") || "Standard";
}

/**
 * Infer capabilities from model name when not in catalog.
 * This is a fallback for dynamically discovered models.
 */
export function inferCapabilitiesFromName(modelId: string): ModelCapabilities {
	const lower = modelId.toLowerCase();
	const caps = { ...DEFAULT_MODEL_CAPABILITIES };

	// Vision detection
	if (
		lower.includes("vision") ||
		lower.includes("-v") ||
		lower.includes("4o") ||
		lower.includes("gemini")
	) {
		caps.vision = true;
		caps.pdf = true; // Vision models typically support PDFs
	}

	// Reasoning detection
	if (
		lower.includes("o1") ||
		lower.includes("o3") ||
		lower.includes("r1") ||
		lower.includes("reasoning") ||
		lower.includes("think")
	) {
		caps.reasoning = true;
		caps.toolCalling = false; // Reasoning models often don't support tool calling
	}

	// Speed detection
	if (
		lower.includes("instant") ||
		lower.includes("flash") ||
		lower.includes("mini") ||
		lower.includes("turbo") ||
		lower.includes("fast")
	) {
		caps.fast = true;
		caps.speedTier = "fast";
	}

	// Quality tier detection
	if (
		lower.includes("opus") ||
		lower.includes("large") ||
		lower.includes("pro") ||
		lower.includes("70b") ||
		lower.includes("405b")
	) {
		caps.qualityTier = "premium";
	} else if (
		lower.includes("haiku") ||
		lower.includes("small") ||
		lower.includes("mini") ||
		lower.includes("8b") ||
		lower.includes("7b")
	) {
		caps.qualityTier = "basic";
		caps.speedTier = "fast";
	}

	// Code detection
	if (
		lower.includes("code") ||
		lower.includes("coder") ||
		lower.includes("codestral")
	) {
		caps.code = true;
	}

	return caps;
}
