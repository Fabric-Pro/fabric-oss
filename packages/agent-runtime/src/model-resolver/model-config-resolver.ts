/**
 * Model Configuration Resolver
 *
 * Resolves model configuration for a tenant based on their preferences,
 * organization policies, and system defaults. Uses the Runtime API
 * instead of direct database access.
 */

import { getRuntimeClient } from "../runtime-client";
import type { ModelResolutionInput, TenantModelConfig } from "../types";

// Cache for resolved configurations (per tenant + task type)
const configCache = new Map<
	string,
	{ config: TenantModelConfig; expiresAt: number }
>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve model configuration for a tenant and task type
 *
 * Note: This function now requires the API key to be passed in, as the
 * resolution is done via HTTP call to the Runtime API.
 *
 * @param apiKey - The API key used to authenticate and identify the tenant
 * @param taskType - The type of task (SIMPLE, COMPLEX, REASONING, etc.)
 * @param agentId - Optional agent ID for agent-specific preferences
 */
export async function resolveModelConfig(
	apiKey: string,
	taskType: ModelResolutionInput["taskType"],
	agentId?: string,
): Promise<TenantModelConfig | null> {
	// Check cache using a hash of the API key (don't cache the key itself)
	const keyHash =
		apiKey.substring(0, 8) + apiKey.substring(apiKey.length - 4);
	const cacheKey = `${keyHash}:${taskType}:${agentId || ""}`;
	const cached = configCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.config;
	}

	// Call Runtime API
	const client = getRuntimeClient();
	const config = await client.resolveModel({
		apiKey,
		taskType,
		agentId,
	});

	if (config) {
		configCache.set(cacheKey, {
			config,
			expiresAt: Date.now() + CACHE_TTL_MS,
		});
	}

	return config;
}

/**
 * Clear the configuration cache (for testing or force refresh)
 */
export function clearConfigCache(): void {
	configCache.clear();
}
