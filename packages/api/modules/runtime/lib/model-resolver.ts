/**
 * Model Resolver Library
 *
 * Resolves model configuration for a tenant including the decrypted API key.
 * This is the server-side implementation that agents call via HTTP.
 */

import { getAIModelWithMetadata, getRAGProviderConfig } from "@repo/ai";
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
			{ userId: tenant.userId, organizationId },
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
