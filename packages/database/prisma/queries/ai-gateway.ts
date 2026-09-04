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
 * Read a stored provider row's credentials the way the resolver does.
 *
 * Two rules that are easy to get wrong separately, so they live together: the
 * key may still sit in the legacy `config.apiKey` rather than the
 * `encryptedApiKey` column, and an OAuth-only service-principal row has no key
 * at all yet is configured. Any caller that answers "is this row usable?"
 * differently from the resolver will disagree with it — and a UI that decides a
 * tenant is unconfigured while the resolver happily serves them, or the
 * reverse, is worse than no answer.
 *
 * Returns the resolved key too, because the resolver needs the value and the
 * status endpoints need only the verdict; deriving both here keeps the
 * coalescing rule in one place.
 */
export function readProviderRowCredentials(row: {
	encryptedApiKey: string | null;
	clientId: string | null;
	encryptedClientSecret: string | null;
	config: unknown;
}): { apiKey: string | null; hasCredentials: boolean } {
	const configData = (row.config as Record<string, unknown>) || {};
	const apiKey =
		row.encryptedApiKey ||
		(configData?.apiKey as string | undefined) ||
		null;

	return {
		apiKey,
		hasCredentials: hasProviderCredentials({
			apiKey,
			clientId: row.clientId,
			encryptedClientSecret: row.encryptedClientSecret,
		}),
	};
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
	const { apiKey, hasCredentials } = readProviderRowCredentials(row);

	if (!hasCredentials) {
		return null;
	}

	const configData = (row.config as Record<string, unknown>) || {};

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
 * Resolve the tenant's OWN provider configuration.
 *
 * AI PROVIDER RESOLUTION (with fallback):
 * - Organization context: First try org-level cloud_provider_config
 * - If org has no config: Fall back to user's personal config
 * - Personal context: Use user-level user_cloud_provider_config
 *
 * NOTE: The personal fall-back inside an organization is an exception to
 * strict tenant isolation because:
 * 1. AI API keys are paid by users personally
 * 2. Users expect their personal API key to work in org context
 * 3. No data is leaked - it's the same authenticated user
 * 4. Cost tracking stays on the user's API key
 *
 * Returns null when neither source carries a usable credential. Shared by the
 * two public entry points below, so the ONLY difference between them is what
 * happens when nothing resolves.
 */
async function resolveTenantProviderConfig({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId?: string | null;
}): Promise<AiProviderConfig | null> {
	// First, try organization-level config if in org context
	if (organizationId) {
		// WHOSE KEY FUNDS THE CALL — a deliberate ruling, not an oversight.
		// This reads the organization's config by id with NO membership check.
		// A project guest holds a project membership but no organization
		// membership, and arrives here with the host organization supplied by
		// project authorization — so the host organization's key funds a guest's
		// work. That is intended: the guest was invited onto that organization's
		// project and the work is done in its interest, the same reasoning by
		// which its storage holds their uploads. It settles whose account is
		// charged, NOT what a guest may see — guests still reach no other
		// project, no organization settings, and never the key itself.
		// Adding a membership filter here would silently change who pays.
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

	return null;
}

/**
 * Get AI provider configuration for a user/organization — TENANT-FACING.
 *
 * **This entry point cannot reach the platform gateway credential at all.** A
 * user-facing AI operation runs on a provider the tenant configured — its
 * organization's, or the caller's own personal key used inside it — or it does
 * not run. Neither a credit balance, nor a saved card, nor the platform's own
 * gateway key takes part in that decision.
 *
 * When nothing resolves this returns the "nothing configured" shape (a null
 * `provider` and a null `source`), which every caller already turns into a
 * provider-not-configured refusal naming the provider settings as the remedy.
 *
 * Background and system work — indexing, embedding, tool ingestion — keeps the
 * platform fallback through {@link getSystemAiProviderApiKey}. The two are
 * separate, differently-named functions rather than one function with a flag
 * precisely so a call site cannot be handed the wrong policy: a boolean would
 * make every one of the call sites restate a judgement that a typo can invert.
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
	const resolved = await resolveTenantProviderConfig({
		userId,
		organizationId,
	});

	return resolved ?? { ...EMPTY_PROVIDER_CONFIG };
}

/**
 * Get AI provider configuration for BACKGROUND / SYSTEM work — the only entry
 * point that may end in the platform gateway credential.
 *
 * Identical to {@link getAiProviderApiKey} except for the last rung: when the
 * tenant configured nothing, this falls back to the deployment's own gateway
 * key (when one is set and the gateway is enabled).
 *
 * Use it ONLY from callers that are not a user-facing AI operation — indexing,
 * embedding and tool ingestion, and the system model-resolution helpers those
 * run on. Anything a person triggered and waits on must use
 * {@link getAiProviderApiKey} instead.
 *
 * Note the shape difference that made the old single-function fallback
 * invisible: the platform branch hands back a real, working key but leaves
 * `source` null, while the organization and personal branches stamp a source.
 * Callers that ask "did the tenant configure this?" read `source`, so a
 * platform-served request looked unconfigured while still being served.
 */
export async function getSystemAiProviderApiKey({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId?: string | null;
}): Promise<AiProviderConfig> {
	const resolved = await resolveTenantProviderConfig({
		userId,
		organizationId,
	});

	if (resolved) {
		return resolved;
	}

	return getPlatformGatewayProviderConfig() ?? { ...EMPTY_PROVIDER_CONFIG };
}

/**
 * Debounce window for `updateProviderLastUsed`. Every AI model call used to
 * unconditionally `update` this row — measured in prod as the single most
 * expensive statement in the app (54,102 calls / 14 days, 3.8ms mean, 17% of
 * app DB time) because a 3-row table means concurrent calls serialize on the
 * row lock. A "last used" display only needs one-minute granularity, so a
 * config is touched at most once per interval.
 */
const PROVIDER_LAST_USED_DEBOUNCE_MS = 60_000;

/**
 * Update last used timestamp for a provider config, debounced to at most once
 * per `PROVIDER_LAST_USED_DEBOUNCE_MS`. Uses a conditional `updateMany` (id +
 * "never touched or touched before the cutoff") instead of an unconditional
 * `update` so a call inside the debounce window takes no row lock at all.
 *
 * Returns the number of rows actually updated (0 or 1) rather than the row
 * itself — both call sites (`packages/ai/lib/dynamic-model-selector.ts`) are
 * fire-and-forget (`.catch(() => {})`) and never read the return value.
 */
export async function updateProviderLastUsed({
	configId,
	source,
}: {
	configId: string;
	source: "organization" | "user";
}): Promise<number> {
	const now = new Date();
	const cutoff = new Date(now.getTime() - PROVIDER_LAST_USED_DEBOUNCE_MS);
	const where = {
		id: configId,
		OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }],
	};

	if (source === "organization") {
		const { count } = await db.cloudProviderConfig.updateMany({
			where,
			data: { lastUsedAt: now },
		});
		return count;
	}
	const { count } = await db.userCloudProviderConfig.updateMany({
		where,
		data: { lastUsedAt: now },
	});
	return count;
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
