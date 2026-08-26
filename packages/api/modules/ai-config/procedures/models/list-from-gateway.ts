/**
 * List Models from Gateway API
 *
 * Fetches available models directly from the configured AI gateway's API.
 * This provides a real-time view of what models are available based on
 * the gateway's current configuration.
 */

import { resolveProviderApiKey } from "@repo/ai";
import type { AIProvider } from "@repo/database";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	fetchGatewayModels,
	getProvidersFromGatewayModels,
	groupModelsByProvider,
	supportsModelFetching,
} from "../../lib/gateway-model-fetcher";

/**
 * List Models from Gateway API
 *
 * TENANT ISOLATION:
 * - If organizationId is provided: ONLY query cloud_provider_config (org level)
 * - If organizationId is NOT provided: ONLY query user_cloud_provider_config (user level)
 * - Personal and organization configurations are NEVER mixed
 */
export const listModelsFromGatewayProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ORG_AI_CONFIG_READ))
	.route({
		method: "GET",
		path: "/ai-config/models/from-gateway",
		tags: ["AI Config"],
		summary: "List models from gateway API",
		description:
			"Fetch available models directly from the configured AI gateway. " +
			"Returns real-time model availability based on gateway configuration.",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			gateway: z.string().nullable(),
			gatewayDisplayName: z.string().nullable(),
			// Providers detected from gateway models
			providers: z.array(z.string()),
			// All models from gateway
			models: z.array(
				z.object({
					id: z.string(),
					name: z.string().optional(),
					description: z.string().optional(),
					provider: z.string().optional(),
					contextLength: z.number().optional(),
				}),
			),
			// Models grouped by provider
			modelsByProvider: z.record(
				z.string(),
				z.array(
					z.object({
						id: z.string(),
						name: z.string().optional(),
						description: z.string().optional(),
					}),
				),
			),
			// Cache info
			cachedAt: z.string().nullable(),
			error: z.string().optional(),
		}),
	)
	.handler(async ({ context: { user, session }, input }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// TENANT ISOLATION: Query ONLY the appropriate config based on context
		// Never mix personal and organization configurations
		let config: {
			provider: AIProvider;
			displayName: string | null;
			encryptedApiKey: string | null;
			clientId: string | null;
			encryptedClientSecret: string | null;
			config: unknown;
		} | null = null;

		if (organizationId) {
			// Organization context: ONLY query cloud_provider_config
			const gatewayConfig = await db.cloudProviderConfig.findFirst({
				where: {
					organizationId,
					enabled: true,
					isDefault: true,
				},
				orderBy: { priority: "desc" },
			});

			// If no default, try first enabled
			config =
				gatewayConfig ||
				(await db.cloudProviderConfig.findFirst({
					where: { organizationId, enabled: true },
					orderBy: { priority: "desc" },
				}));
		} else {
			// Personal context: ONLY query user_cloud_provider_config
			const gatewayConfig = await db.userCloudProviderConfig.findFirst({
				where: {
					userId: user.id,
					enabled: true,
					isDefault: true,
				},
				orderBy: { priority: "desc" },
			});

			// If no default, try first enabled
			config =
				gatewayConfig ||
				(await db.userCloudProviderConfig.findFirst({
					where: { userId: user.id, enabled: true },
					orderBy: { priority: "desc" },
				}));
		}

		if (!config) {
			return {
				success: false,
				gateway: null,
				gatewayDisplayName: null,
				providers: [],
				models: [],
				modelsByProvider: {},
				cachedAt: null,
				error: "No AI gateway configured",
			};
		}

		// Check if gateway supports dynamic model fetching
		// If not (direct providers like OPENAI_DIRECT), fall back to database models
		if (!supportsModelFetching(config.provider)) {
			// Fetch models from database that have mappings for this provider
			const dbModels = await db.aiModel.findMany({
				where: {
					isActive: true,
					providerMappings: {
						some: {
							provider: config.provider,
							isAvailable: true,
						},
					},
				},
				include: {
					providerMappings: {
						where: {
							provider: config.provider,
							isAvailable: true,
						},
					},
				},
				orderBy: [{ qualityTier: "desc" }, { displayName: "asc" }],
			});

			// Map to gateway model format
			const models = dbModels.map((m) => ({
				id: m.providerMappings[0]?.providerModelId || m.canonicalName,
				name: m.displayName,
				description: m.description || undefined,
				provider: config.provider
					.toLowerCase()
					.replace("_direct", "")
					.replace("_ai", ""),
				contextLength: m.contextWindow || undefined,
			}));

			// Group by provider (single provider for direct providers)
			const providerName = config.provider
				.toLowerCase()
				.replace("_direct", "")
				.replace("_ai", "");
			const modelsByProvider: Record<
				string,
				Array<{ id: string; name?: string; description?: string }>
			> = {
				[providerName]: models.map((m) => ({
					id: m.id,
					name: m.name,
					description: m.description,
				})),
			};

			return {
				success: true,
				gateway: config.provider,
				gatewayDisplayName: config.displayName,
				providers: [providerName],
				models,
				modelsByProvider,
				cachedAt: null,
			};
		}

		// Get API key and enabled providers from config
		const configData = config.config as Record<string, unknown>;
		// Prefer new encryptedApiKey column, fall back to legacy config.apiKey for backward compatibility
		const apiKey = config.encryptedApiKey || (configData?.apiKey as string);
		const enabledProviders =
			(configData?.enabledProviders as string[]) || [];
		// A Databricks service-principal config stores no API key — it mints a
		// short-lived token instead, so "no apiKey" is not "not configured".
		const hasServicePrincipal = !!(
			config.clientId && config.encryptedClientSecret
		);

		if (!apiKey && !hasServicePrincipal) {
			return {
				success: false,
				gateway: config.provider,
				gatewayDisplayName: config.displayName,
				providers: [],
				models: [],
				modelsByProvider: {},
				cachedAt: null,
				error: "Gateway API key not configured",
			};
		}

		// Fetch models from gateway.
		// Databricks lists endpoints via the native REST API using a bearer
		// token + the tenant's workspace host (config.baseUrl). The token is
		// the decrypted PAT, or one minted from the stored service principal.
		const isDatabricks = config.provider === "DATABRICKS";
		const databricksBaseUrl = configData?.baseUrl as string | undefined;

		let resolvedKey = apiKey;
		if (isDatabricks) {
			try {
				resolvedKey = await resolveProviderApiKey(
					{
						provider: config.provider,
						apiKey,
						baseUrl: databricksBaseUrl ?? null,
						clientId: config.clientId,
						encryptedClientSecret: config.encryptedClientSecret,
					},
					// Preserves this path's pre-existing `decryptApiKeyMaybe`
					// tolerance for legacy rows storing an unencrypted key.
					{ lenientDecrypt: true },
				);
			} catch (error) {
				return {
					success: false,
					gateway: config.provider,
					gatewayDisplayName: config.displayName,
					providers: [],
					models: [],
					modelsByProvider: {},
					cachedAt: null,
					error:
						error instanceof Error
							? error.message
							: "Failed to resolve Databricks credentials",
				};
			}
		}

		const result = await fetchGatewayModels(
			config.provider,
			resolvedKey,
			isDatabricks ? { baseUrl: databricksBaseUrl } : undefined,
		);

		// Filter models by enabled providers if configured
		if (enabledProviders.length > 0 && result.success) {
			// Map AIProvider enum values to gateway provider names
			// Some providers host models from other vendors (e.g., Groq hosts Meta's Llama)
			const providerMapping: Record<string, string[]> = {
				OPENAI_DIRECT: ["openai"],
				ANTHROPIC_DIRECT: ["anthropic"],
				GROQ: ["groq", "meta"], // Groq hosts Meta's Llama, Mixtral, etc.
				GOOGLE_VERTEX_AI: ["google"],
				MISTRAL_AI: ["mistral", "mistralai"],
				DEEPSEEK: ["deepseek"],
				COHERE: ["cohere"],
				PERPLEXITY: ["perplexity"],
				XAI: ["xai"],
				TOGETHER_AI: ["together", "meta"], // Together AI also hosts Meta models
				FIREWORKS: ["fireworks", "meta"], // Fireworks also hosts Meta models
			};

			// Build set of allowed gateway provider names from enabled AIProviders
			const allowedGatewayProviders = new Set<string>();
			for (const enabledProvider of enabledProviders) {
				const mappedNames = providerMapping[enabledProvider];
				if (mappedNames) {
					for (const name of mappedNames) {
						allowedGatewayProviders.add(name);
					}
				}
				// Also allow the raw lowercase version (backward compatibility)
				allowedGatewayProviders.add(
					enabledProvider
						.toLowerCase()
						.replace("_direct", "")
						.replace("_ai", ""),
				);
			}

			result.models = result.models.filter((model) => {
				if (!model.provider) {
					return false;
				}
				const normalizedModelProvider = model.provider.toLowerCase();
				return allowedGatewayProviders.has(normalizedModelProvider);
			});
		}

		if (!result.success) {
			return {
				success: false,
				gateway: config.provider,
				gatewayDisplayName: config.displayName,
				providers: [],
				models: [],
				modelsByProvider: {},
				cachedAt: null,
				error: result.error,
			};
		}

		// Get unique providers from models
		const providers = getProvidersFromGatewayModels(result.models);

		// Group models by provider
		const grouped = groupModelsByProvider(result.models);
		const modelsByProvider: Record<
			string,
			Array<{ id: string; name?: string; description?: string }>
		> = {};
		for (const [provider, models] of Object.entries(grouped)) {
			modelsByProvider[provider] = models.map((m) => ({
				id: m.id,
				name: m.name,
				description: m.description,
			}));
		}

		return {
			success: true,
			gateway: config.provider,
			gatewayDisplayName: config.displayName,
			providers,
			models: result.models.map((m) => ({
				id: m.id,
				name: m.name,
				description: m.description,
				provider: m.provider,
				contextLength: m.contextLength,
			})),
			modelsByProvider,
			cachedAt: result.cachedAt?.toISOString() ?? null,
		};
	});
