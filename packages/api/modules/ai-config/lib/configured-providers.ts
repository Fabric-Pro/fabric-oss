/**
 * Which AI providers a tenant can actually reach, and which models follow from
 * that.
 *
 * Extracted from `procedures/models/list-available.ts` so it can be shared.
 * Importing it from that module pulled the procedure definition in with it,
 * and defining a procedure runs permission middleware at import time — which
 * blew up any consumer outside the oRPC runtime. This module holds no
 * procedures, so importing it is free.
 */

import type { AIProvider } from "@repo/database";
import {
	ALL_AUDIO_CAPABLE_PROVIDERS,
	ALL_EMBEDDING_CAPABLE_PROVIDERS,
	ALL_IMAGE_CAPABLE_PROVIDERS,
	db,
	GATEWAY_PROVIDERS,
} from "@repo/database";

const SPECIALIZED_TASK_TYPES = ["IMAGE", "AUDIO", "EMBEDDING"] as const;
type SpecializedTaskType = (typeof SPECIALIZED_TASK_TYPES)[number];

/**
 * Get the list of capable providers for a specialized task type.
 * Returns null if the task type is not specialized (uses default provider only).
 */
function getCapableProvidersForTask(
	taskType: string | undefined,
): readonly AIProvider[] | null {
	if (!taskType) {
		return null;
	}

	switch (taskType as SpecializedTaskType) {
		case "IMAGE":
			return ALL_IMAGE_CAPABLE_PROVIDERS;
		case "AUDIO":
			return ALL_AUDIO_CAPABLE_PROVIDERS;
		case "EMBEDDING":
			return ALL_EMBEDDING_CAPABLE_PROVIDERS;
		default:
			return null; // Not a specialized task, use default provider only
	}
}

export const PROVIDERS_WITH_SUBPROVIDERS = new Set<AIProvider>([
	...GATEWAY_PROVIDERS,
]);

export interface ConfiguredGateway {
	id: string;
	provider: AIProvider;
	displayName: string | null;
	isDefault: boolean;
	priority: number;
	enabledProviders: AIProvider[];
	source: "user_config" | "org_config";
}

/**
 * Get the configured providers and identify the default one.
 *
 * For general tasks: Only the default provider's models are returned.
 * For specialized tasks (IMAGE, AUDIO, EMBEDDING): Models from ALL configured
 * providers that support the capability are returned, enabling users to use
 * OpenAI for images even when their default is Azure/Anthropic.
 *
 * TENANT ISOLATION:
 * - If organizationId is provided: ONLY query cloud_provider_config (org level)
 * - If organizationId is NOT provided: ONLY query user_cloud_provider_config (user level)
 * - Personal and organization configurations are NEVER mixed
 */
/**
 * Exported so the default-agent resolver can ask the same question this
 * procedure asks — "which providers can this tenant actually reach?" — rather
 * than growing a second, drifting answer to it.
 */
export async function getConfiguredProviders(
	userId: string,
	organizationId?: string,
	taskType?: string,
): Promise<{
	allProviders: ConfiguredGateway[];
	defaultProvider: ConfiguredGateway | null;
	defaultProviderType: AIProvider | null;
	effectiveProviders: AIProvider[]; // Providers to query models for
}> {
	const allProviders: ConfiguredGateway[] = [];
	let defaultProvider: ConfiguredGateway | null = null;

	// TENANT ISOLATION: Query ONLY the appropriate config based on context
	// Never mix personal and organization configurations
	if (organizationId) {
		// Organization context: ONLY query cloud_provider_config
		const orgProviders = await db.cloudProviderConfig.findMany({
			where: { organizationId, enabled: true },
			orderBy: [{ isDefault: "desc" }, { priority: "desc" }],
		});

		for (const config of orgProviders) {
			const configData = config.config as Record<string, unknown>;
			const enabledProviders =
				(configData?.enabledProviders as string[]) || [];
			const hasSubProviders = PROVIDERS_WITH_SUBPROVIDERS.has(
				config.provider,
			);
			const providers: AIProvider[] = hasSubProviders
				? (enabledProviders.filter(
						(p): p is AIProvider =>
							typeof p === "string" && p.length > 0,
					) as AIProvider[])
				: [config.provider];

			const gateway: ConfiguredGateway = {
				id: config.id,
				provider: config.provider,
				displayName: config.displayName,
				isDefault: config.isDefault,
				priority: config.priority,
				enabledProviders: providers,
				source: "org_config",
			};

			allProviders.push(gateway);

			if (config.isDefault && !defaultProvider) {
				defaultProvider = gateway;
			}
		}
	} else {
		// Personal context: ONLY query user_cloud_provider_config
		const userProviders = await db.userCloudProviderConfig.findMany({
			where: { userId: userId, enabled: true },
			orderBy: [{ isDefault: "desc" }, { priority: "desc" }],
		});

		for (const config of userProviders) {
			const configData = config.config as Record<string, unknown>;
			const enabledProviders =
				(configData?.enabledProviders as string[]) || [];
			const hasSubProviders = PROVIDERS_WITH_SUBPROVIDERS.has(
				config.provider,
			);
			const providers: AIProvider[] = hasSubProviders
				? (enabledProviders.filter(
						(p): p is AIProvider =>
							typeof p === "string" && p.length > 0,
					) as AIProvider[])
				: [config.provider];

			const gateway: ConfiguredGateway = {
				id: config.id,
				provider: config.provider,
				displayName: config.displayName,
				isDefault: config.isDefault,
				priority: config.priority,
				enabledProviders: providers,
				source: "user_config",
			};

			allProviders.push(gateway);

			if (config.isDefault && !defaultProvider) {
				defaultProvider = gateway;
			}
		}
	}

	// If no default, use first configured
	if (!defaultProvider && allProviders.length > 0) {
		defaultProvider = allProviders[0];
		allProviders[0].isDefault = true;
	}

	// Build the list of providers to query models from
	const effectiveProviders: AIProvider[] = [];
	const configuredProviderSet = new Set(allProviders.map((p) => p.provider));

	// Check if this is a specialized task type (IMAGE, AUDIO, EMBEDDING)
	const capableProviders = getCapableProvidersForTask(taskType);

	if (capableProviders) {
		// SPECIALIZED TASK with explicit taskType: Include ALL configured providers that support this capability
		for (const provider of capableProviders) {
			if (configuredProviderSet.has(provider)) {
				effectiveProviders.push(provider);
			}
		}

		// If no capable providers are configured, fall back to default (will show empty)
		if (effectiveProviders.length === 0 && defaultProvider) {
			effectiveProviders.push(defaultProvider.provider);
		}
	} else {
		// NO taskType specified OR general task type: Include default provider + all specialized providers
		// This allows the UI to fetch all models in one call and filter client-side

		// 1. Add the default provider for general tasks
		if (defaultProvider) {
			effectiveProviders.push(defaultProvider.provider);
		}

		// 2. Also include any configured providers that support specialized capabilities
		// This ensures IMAGE, AUDIO, and EMBEDDING models from non-default providers are available
		const specializedProviderLists = [
			ALL_IMAGE_CAPABLE_PROVIDERS,
			ALL_AUDIO_CAPABLE_PROVIDERS,
			ALL_EMBEDDING_CAPABLE_PROVIDERS,
		];

		for (const providerList of specializedProviderLists) {
			for (const provider of providerList) {
				if (
					configuredProviderSet.has(provider) &&
					!effectiveProviders.includes(provider)
				) {
					effectiveProviders.push(provider);
				}
			}
		}
	}

	return {
		allProviders,
		defaultProvider,
		defaultProviderType: defaultProvider?.provider || null,
		effectiveProviders,
	};
}

// getProviderDisplayName is imported from @repo/database (single source of truth)
