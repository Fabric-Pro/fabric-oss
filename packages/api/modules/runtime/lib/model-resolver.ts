/**
 * Model Resolver Library
 *
 * Resolves model configuration for a tenant including the decrypted API key.
 * This is the server-side implementation that agents call via HTTP.
 */

import {
	chatGptPlanServesCall,
	getAIModelWithMetadata,
	getRAGProviderConfig,
} from "@repo/ai";
import type { AiTaskType } from "@repo/database";
import type { ResolvedModelConfig, TaskType, TenantContext } from "../types";

/**
 * Resolve model configuration for a tenant and task type
 * Uses centralized AI model resolution
 */
export async function resolveModelForTenant(
	tenant: TenantContext,
	taskType: TaskType,
): Promise<ResolvedModelConfig | null> {
	try {
		// Convert null to undefined for organizationId
		const organizationId = tenant.organizationId ?? undefined;

		// Use centralized model resolution
		const { metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: taskType as AiTaskType },
			// Callers get the raw provider key below, which the plan does not have.
			{ userId: tenant.userId, organizationId, excludeChatGptPlan: true },
		);

		// Track usage (fire-and-forget)
		trackUsage();

		// Get raw credentials
		const providerConfig = await getRAGProviderConfig({
			userId: tenant.userId,
			organizationId,
		});

		// Map selection source to expected format
		const mapSource = (
			source: string,
		): "user_override" | "org_override" | "system_default" => {
			if (source.includes("user")) {
				return "user_override";
			}
			if (source.includes("org")) {
				return "org_override";
			}
			return "system_default";
		};

		return {
			provider: metadata.provider,
			providerModelId: metadata.modelString,
			modelString: metadata.modelString,
			apiKey: providerConfig.apiKey,
			source: mapSource(metadata.selectionSource),
		};
	} catch {
		return null;
	}
}

/**
 * Why no model resolved, for the caller's refusal. An external runtime needs
 * the raw provider key, which a ChatGPT plan does not have (Fizzy #2770 D9):
 * a tenant whose work runs on a plan, with no API provider for LLM work (an
 * embeddings-only key never counts), is told so rather than told nothing is
 * configured.
 */
export async function modelUnavailableMessage(
	tenant: TenantContext,
): Promise<string> {
	const planServed = await chatGptPlanServesCall({
		userId: tenant.userId,
		organizationId: tenant.organizationId ?? undefined,
	}).catch(() => false);
	return planServed
		? "This organization's AI work runs on ChatGPT plans, which an agent runtime cannot use. Add an API provider in Settings → AI Providers."
		: "No AI provider configured. Please configure at least one provider in settings.";
}
