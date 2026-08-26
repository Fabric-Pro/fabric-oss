/**
 * Database queries for AI Provider configuration
 *
 * Uses user_cloud_provider_config / cloud_provider_config tables
 * to support multiple providers with one marked as default.
 */

import { config } from "@repo/config";
import { encryptApiKey } from "@repo/utils";
import { db } from "../client";

/**
 * Full provider configuration returned by query functions
 */
export interface ProviderConfigResult {
	id: string;
	provider: string;
	apiKey: string | undefined;
	baseUrl: string | undefined;
	enabledProviders: string[];
	displayName: string | null;
	isDefault: boolean;
	lastUsedAt: Date | null;
	/** Service-principal client id (Databricks OAuth M2M), when configured. */
	clientId: string | null;
	/** Encrypted service-principal secret (Databricks OAuth M2M). */
	encryptedClientSecret: string | null;
}

/**
 * Columns every provider read needs to resolve a credential. Kept as one
 * constant so a new credential field can never be added to some reads and
 * silently missed by others.
 */
const PROVIDER_CREDENTIAL_SELECT = {
	encryptedApiKey: true,
	clientId: true,
	encryptedClientSecret: true,
} as const;

/**
 * True when a provider config carries ANY usable credential — a static API
 * key/PAT or a complete service principal.
 *
 * THE shared "is this provider configured?" predicate. Every consumer that
 * would otherwise write `if (config.apiKey)` must use this instead: an
 * OAuth-only Databricks row has a null `encryptedApiKey`, so a bare truthiness
 * check silently classifies a correctly-configured tenant as unconfigured —
 * falling through to another config source, or hard-failing a preflight.
 *
 * Lives here because `@repo/database` owns `AiProviderConfig` and everything
 * downstream (`@repo/api`, `@repo/temporal`, `@repo/ai`) already depends on it,
 * so there is no import-direction problem. `@repo/ai` additionally exports a
 * structurally identical predicate for callers holding a `ResolvedModelConfig`
 * without pulling in Prisma.
 */
export function hasProviderCredentials(row: {
	apiKey?: string | null;
	clientId?: string | null;
	encryptedClientSecret?: string | null;
}): boolean {
	return Boolean(row.apiKey || (row.clientId && row.encryptedClientSecret));
}

/**
 * Get organization's default AI provider configuration (NEW MODEL)
 * Returns the default provider config from cloud_provider_config table
 */
export async function getOrganizationDefaultProviderConfig(
	organizationId: string,
): Promise<ProviderConfigResult | null> {
	const config = await db.cloudProviderConfig.findFirst({
		where: {
			organizationId,
			isDefault: true,
			enabled: true,
		},
		select: {
			id: true,
			provider: true,
			...PROVIDER_CREDENTIAL_SELECT,
			config: true,
			displayName: true,
			isDefault: true,
			lastUsedAt: true,
		},
	});

	if (!config) {
		return null;
	}

	const configData = config.config as Record<string, unknown>;
	// Prefer new encryptedApiKey column, fall back to legacy config.apiKey for backward compatibility
	const apiKey =
		config.encryptedApiKey || (configData?.apiKey as string | undefined);
	return {
		id: config.id,
		provider: config.provider,
		apiKey,
		baseUrl: configData?.baseUrl as string | undefined,
		enabledProviders: (configData?.enabledProviders as string[]) || [],
		displayName: config.displayName,
		isDefault: config.isDefault,
		lastUsedAt: config.lastUsedAt,
		clientId: config.clientId,
		encryptedClientSecret: config.encryptedClientSecret,
	};
}

/**
 * Get user's default AI provider configuration (NEW MODEL)
 * Returns the default provider config from user_cloud_provider_config table
 */
export async function getUserDefaultProviderConfig(
	userId: string,
): Promise<ProviderConfigResult | null> {
	const config = await db.userCloudProviderConfig.findFirst({
		where: {
			userId,
			isDefault: true,
			enabled: true,
		},
		select: {
			id: true,
			provider: true,
			...PROVIDER_CREDENTIAL_SELECT,
			config: true,
			displayName: true,
			isDefault: true,
			lastUsedAt: true,
		},
	});

	if (!config) {
		return null;
	}

	const configData = config.config as Record<string, unknown>;
	// Prefer new encryptedApiKey column, fall back to legacy config.apiKey for backward compatibility
	const apiKey =
		config.encryptedApiKey || (configData?.apiKey as string | undefined);
	return {
		id: config.id,
		provider: config.provider,
		apiKey,
		baseUrl: configData?.baseUrl as string | undefined,
		enabledProviders: (configData?.enabledProviders as string[]) || [],
		displayName: config.displayName,
		isDefault: config.isDefault,
		lastUsedAt: config.lastUsedAt,
		clientId: config.clientId,
		encryptedClientSecret: config.encryptedClientSecret,
	};
}

/**
 * Update last used timestamp for organization's provider config
 */
export async function updateOrganizationProviderLastUsed(configId: string) {
	return await db.cloudProviderConfig.update({
		where: { id: configId },
		data: { lastUsedAt: new Date() },
	});
}

/**
 * Update last used timestamp for user's provider config
 */
export async function updateUserProviderLastUsed(configId: string) {
	return await db.userCloudProviderConfig.update({
		where: { id: configId },
		data: { lastUsedAt: new Date() },
	});
}

/**
 * Full provider config result for AI API calls
 */
export interface AiProviderConfig {
	apiKey: string | null;
	configId: string | null;
	provider: string | null;
	baseUrl: string | null;
	enabledProviders: string[];
	source: "organization" | "user" | null;
	/** For Azure AI Foundry - the user-defined deployment name */
	deploymentName: string | null;
	/**
	 * Service-principal client id (Databricks OAuth M2M). When set alongside
	 * `encryptedClientSecret`, `apiKey` is null and callers must mint a token
	 * via `resolveProviderApiKey` from `@repo/ai`.
	 */
	clientId: string | null;
	/** Encrypted service-principal secret (Databricks OAuth M2M). */
	encryptedClientSecret: string | null;
}

/** The "nothing configured" shape, shared by every early return below. */
const EMPTY_PROVIDER_CONFIG: AiProviderConfig = {
	apiKey: null,
	configId: null,
	provider: null,
	baseUrl: null,
	enabledProviders: [],
	source: null,
	deploymentName: null,
	clientId: null,
	encryptedClientSecret: null,
};

/**
 * Map a provider config row to the resolved `AiProviderConfig`, or null when
 * the row carries no usable credential (so the caller falls through to the
 * next source, exactly as the old inline `if (apiKey)` guards did).
 *
 * Shared by every provider read below so a newly added credential field is
 * threaded through all of them at once.
 */
function toAiProviderConfig(
	row: {
		id: string;
		provider: string;
		encryptedApiKey: string | null;
		clientId: string | null;
		encryptedClientSecret: string | null;
		config: unknown;
	},
	source: "organization" | "user",
): AiProviderConfig | null {
	const configData = (row.config as Record<string, unknown>) || {};
	// Prefer new encryptedApiKey column, fall back to legacy config.apiKey for backward compatibility
	const apiKey =
		row.encryptedApiKey ||
		(configData?.apiKey as string | undefined) ||
		null;

	// An OAuth-only (service-principal) row has a null apiKey but IS configured.
	if (
		!hasProviderCredentials({
			apiKey,
			clientId: row.clientId,
			encryptedClientSecret: row.encryptedClientSecret,
		})
	) {
		return null;
	}

	return {
		apiKey,
		configId: row.id,
		provider: row.provider,
		baseUrl: (configData?.baseUrl as string) || null,
		enabledProviders: (configData?.enabledProviders as string[]) || [],
		source,
		deploymentName: (configData?.deploymentName as string) || null,
		clientId: row.clientId,
		encryptedClientSecret: row.encryptedClientSecret,
	};
}

function getPlatformGatewayProviderConfig(): AiProviderConfig | null {
	if (!config.ai.enableGateway || !config.ai.gatewayApiKey) {
		return null;
	}

	return {
		...EMPTY_PROVIDER_CONFIG,
		apiKey: encryptApiKey(config.ai.gatewayApiKey),
		provider: "VERCEL_GATEWAY",
		enabledProviders: config.ai.enabledProviders.map((provider) =>
			provider.toUpperCase(),
		),
	};
}

/**
 * Get AI provider configuration for a user/organization
 *
 * AI PROVIDER RESOLUTION (with fallback):
 * - Organization context: First try org-level cloud_provider_config
 * - If org has no config: Fall back to user's personal config
 * - Personal context: Use user-level user_cloud_provider_config
 *
 * NOTE: This is an exception to strict tenant isolation because:
 * 1. AI API keys are paid by users personally
 * 2. Users expect their personal API key to work in org context
 * 3. No data is leaked - it's the same authenticated user
 * 4. Cost tracking stays on the user's API key
 *
 * Returns the full provider config including API key, baseUrl, and enabled sub-providers.
 */
export async function getAiProviderApiKey({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId?: string | null;
}): Promise<AiProviderConfig> {
	// First, try organization-level config if in org context
	if (organizationId) {
		const orgConfig = await db.cloudProviderConfig.findFirst({
			where: {
				organizationId,
				isDefault: true,
				enabled: true,
			},
			select: {
				id: true,
				provider: true,
				...PROVIDER_CREDENTIAL_SELECT,
				config: true,
			},
		});

		if (orgConfig) {
			const resolved = toAiProviderConfig(orgConfig, "organization");
			if (resolved) {
				return resolved;
			}
		}

		// Organization has no configured provider - fall back to personal config
		// This allows users to use their personal API key for org activities
		console.log(
			`[AI Provider] No org-level AI config found for org ${organizationId}, falling back to user personal config`,
		);
	}

	// Personal context OR fallback from org context: query user_cloud_provider_config
	const userConfig = await db.userCloudProviderConfig.findFirst({
		where: {
			userId,
			isDefault: true,
			enabled: true,
		},
		select: {
			id: true,
			provider: true,
			...PROVIDER_CREDENTIAL_SELECT,
			config: true,
		},
	});

	if (userConfig) {
		const resolved = toAiProviderConfig(userConfig, "user");
		if (resolved) {
			return resolved;
		}
	}

	return getPlatformGatewayProviderConfig() ?? { ...EMPTY_PROVIDER_CONFIG };
}

/**
 * Update last used timestamp for a provider config
 */
export async function updateProviderLastUsed({
	configId,
	source,
}: {
	configId: string;
	source: "organization" | "user";
}) {
	if (source === "organization") {
		return await db.cloudProviderConfig.update({
			where: { id: configId },
			data: { lastUsedAt: new Date() },
		});
	}
	return await db.userCloudProviderConfig.update({
		where: { id: configId },
		data: { lastUsedAt: new Date() },
	});
}

/**
 * Get AI provider configuration for a specific provider type.
 *
 * This is different from getAiProviderApiKey() which returns the DEFAULT provider.
 * This function returns the config for a SPECIFIC provider type (e.g., OPENAI_DIRECT, VERCEL_GATEWAY).
 *
 * Use case: User has configured both Vercel Gateway and OpenAI Direct.
 * For EMBEDDING task, they selected a model via OpenAI Direct.
 * We need to get the OpenAI Direct API key specifically, not the default provider.
 *
 * @param userId - User ID
 * @param organizationId - Organization ID (if in org context)
 * @param provider - The specific provider type to get config for
 */
/**
 * Get the dedicated embedding provider configuration.
 *
 * This returns the provider marked with isEmbeddingProvider: true.
 * If no embedding provider is configured, returns null (caller should handle).
 *
 * IMPORTANT: Embedding provider is independent of the default AI provider.
 * This ensures embeddings always use the same model, preventing vector incompatibility
 * when users change their default provider.
 *
 * @param userId - User ID
 * @param organizationId - Organization ID (if in org context)
 */
export async function getEmbeddingProviderConfig({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId?: string | null;
}): Promise<AiProviderConfig> {
	if (organizationId) {
		// Organization context: query cloud_provider_config for embedding provider
		const orgConfig = await db.cloudProviderConfig.findFirst({
			where: {
				organizationId,
				isEmbeddingProvider: true,
				enabled: true,
			},
			select: {
				id: true,
				provider: true,
				...PROVIDER_CREDENTIAL_SELECT,
				config: true,
			},
		});

		if (orgConfig) {
			const resolved = toAiProviderConfig(orgConfig, "organization");
			if (resolved) {
				return resolved;
			}
		}

		// No embedding provider configured for organization
		return { ...EMPTY_PROVIDER_CONFIG };
	}

	// Personal context: query user_cloud_provider_config for embedding provider
	const userConfig = await db.userCloudProviderConfig.findFirst({
		where: {
			userId,
			isEmbeddingProvider: true,
			enabled: true,
		},
		select: {
			id: true,
			provider: true,
			...PROVIDER_CREDENTIAL_SELECT,
			config: true,
		},
	});

	if (userConfig) {
		const resolved = toAiProviderConfig(userConfig, "user");
		if (resolved) {
			return resolved;
		}
	}

	return { ...EMPTY_PROVIDER_CONFIG };
}

/**
 * Set a provider as the embedding provider.
 * This unsets any existing embedding provider and sets the new one.
 *
 * @param userId - User ID
 * @param organizationId - Organization ID (if in org context)
 * @param configId - The config ID to set as embedding provider
 */
export async function setEmbeddingProvider({
	userId,
	organizationId,
	configId,
}: {
	userId: string;
	organizationId?: string | null;
	configId: string;
}): Promise<void> {
	if (organizationId) {
		// First, unset any existing embedding provider
		await db.cloudProviderConfig.updateMany({
			where: {
				organizationId,
				isEmbeddingProvider: true,
			},
			data: { isEmbeddingProvider: false },
		});

		// Then set the new one
		await db.cloudProviderConfig.update({
			where: { id: configId },
			data: { isEmbeddingProvider: true },
		});
	} else {
		// User level
		await db.userCloudProviderConfig.updateMany({
			where: {
				userId,
				isEmbeddingProvider: true,
			},
			data: { isEmbeddingProvider: false },
		});

		await db.userCloudProviderConfig.update({
			where: { id: configId },
			data: { isEmbeddingProvider: true },
		});
	}
}

/**
 * Get AI provider configuration for a specific provider type.
 *
 * This is different from getAiProviderApiKey() which returns the DEFAULT provider.
 * This function returns the config for a SPECIFIC provider type (e.g., OPENAI_DIRECT, VERCEL_GATEWAY).
 *
 * Use case: User has configured both Vercel Gateway and OpenAI Direct.
 * For EMBEDDING task, they selected a model via OpenAI Direct.
 * We need to get the OpenAI Direct API key specifically, not the default provider.
 *
 * @param userId - User ID
 * @param organizationId - Organization ID (if in org context)
 * @param provider - The specific provider type to get config for
 */
export async function getAiProviderApiKeyByProvider({
	userId,
	organizationId,
	provider,
}: {
	userId: string;
	organizationId?: string | null;
	provider: string;
}): Promise<AiProviderConfig> {
	// Cast provider string to AIProvider enum type for Prisma query
	// Using the Zod-generated type which matches the Prisma enum
	const providerEnum = provider as import("../zod").AIProvider;

	if (organizationId) {
		// Organization context: query cloud_provider_config for specific provider
		const orgConfig = await db.cloudProviderConfig.findFirst({
			where: {
				organizationId,
				provider: providerEnum,
				enabled: true,
			},
			select: {
				id: true,
				provider: true,
				...PROVIDER_CREDENTIAL_SELECT,
				config: true,
			},
		});

		if (orgConfig) {
			const resolved = toAiProviderConfig(orgConfig, "organization");
			if (resolved) {
				return resolved;
			}
		}

		return { ...EMPTY_PROVIDER_CONFIG };
	}

	// Personal context: query user_cloud_provider_config for specific provider
	const userConfig = await db.userCloudProviderConfig.findFirst({
		where: {
			userId,
			provider: providerEnum,
			enabled: true,
		},
		select: {
			id: true,
			provider: true,
			...PROVIDER_CREDENTIAL_SELECT,
			config: true,
		},
	});

	if (userConfig) {
		const resolved = toAiProviderConfig(userConfig, "user");
		if (resolved) {
			return resolved;
		}
	}

	if (provider === "VERCEL_GATEWAY") {
		return (
			getPlatformGatewayProviderConfig() ?? { ...EMPTY_PROVIDER_CONFIG }
		);
	}

	return { ...EMPTY_PROVIDER_CONFIG };
}
