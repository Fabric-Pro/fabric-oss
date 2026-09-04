import type { AIProvider, AiTaskType } from "@repo/database";
import {
	db,
	getModelForTask,
	getProviderDisplayName,
	isGatewayProvider,
	readProviderRowCredentials,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AI Configuration Status API
 *
 * Queries actual configured providers from database.
 * Uses user_cloud_provider_config and cloud_provider_config tables.
 *
 * TENANT ISOLATION:
 * - If organizationId is provided: ONLY query cloud_provider_config (org level)
 * - If organizationId is NOT provided: ONLY query user_cloud_provider_config (user level)
 * - Personal and organization configurations are NEVER mixed
 *
 * `canResolveProvider` is the ONE field that describes the CALLER rather than
 * the tenant, and the isolation rule above is unchanged by it. It answers "can
 * *you* reach a provider from here?", so — exactly like the resolver it mirrors
 * — it may consult the caller's own personal rows while standing inside an
 * organization. Those rows are filtered by `userId`, are never anyone else's,
 * and never enter `configuredProviders` / `hasOrgConfig` / `hasUserConfig`,
 * which keep describing the tenant alone.
 */

interface ConfiguredProvider {
	provider: AIProvider;
	displayName: string | null;
	isDefault: boolean;
	isEmbeddingProvider: boolean;
	source: "user_config" | "org_config";
}

/** The columns a credential check needs, on either config table. */
const CREDENTIAL_COLUMNS = {
	encryptedApiKey: true,
	clientId: true,
	encryptedClientSecret: true,
	config: true,
} as const;

/**
 * True when a provider row carries a credential the resolver could actually
 * use. Delegates to `@repo/database` rather than restating the rule, because a
 * status endpoint that judges a row differently from the resolver reports a
 * state the product is not in.
 *
 * `enabled: true` alone is not enough. A row saved without a key is enabled and
 * listed, and the resolver returns nothing for it — which is how an
 * organization could be refused AI with no notice explaining why.
 */
function rowCarriesCredentials(row: {
	encryptedApiKey: string | null;
	clientId: string | null;
	encryptedClientSecret: string | null;
	config: unknown;
}): boolean {
	return readProviderRowCredentials(row).hasCredentials;
}

export const getAiConfigStatusProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ORG_AI_CONFIG_READ))
	.route({
		method: "GET",
		path: "/ai-config/status",
		tags: ["AI Config"],
		summary: "Get AI configuration status",
		description:
			"Check if the user has any AI providers configured and ready to use",
	})
	.input(
		z
			.object({
				// organizationId: null = explicit personal context, undefined = use session fallback
				organizationId: z.string().nullable().optional(),
			})
			.optional(),
	)
	.output(
		z.object({
			isConfigured: z.boolean(),
			/**
			 * Whether THIS caller can reach a usable provider from this
			 * context — the question the AI-provider notice asks, and the only
			 * field that mirrors what the resolver actually does. It differs
			 * from `isConfigured` in both directions: an organization whose
			 * only enabled row carries no credential is configured but not
			 * resolvable, and a member with a personal key inside an
			 * organization that has none is resolvable but not configured.
			 */
			canResolveProvider: z.boolean(),
			hasUserConfig: z.boolean(),
			hasOrgConfig: z.boolean(),
			configuredProviders: z.array(
				z.object({
					provider: z.string(),
					displayName: z.string().nullable(),
					isDefault: z.boolean(),
					isEmbeddingProvider: z.boolean(),
					source: z.string(),
				}),
			),
			defaultProvider: z.string().nullable(),
			embeddingProvider: z.string().nullable(),
			// Embedding model details
			embeddingModel: z
				.object({
					displayName: z.string(), // e.g., "Text Embedding 3 Small"
					modelId: z.string(), // e.g., "text-embedding-3-small" or "openai/text-embedding-3-small"
					subProvider: z.string().nullable(), // e.g., "openai" for gateways, null for direct
				})
				.nullable(),
			message: z.string(),
		}),
	)
	.handler(async ({ input, context: { user, session } }) => {
		const organizationId = resolveOrganizationId(
			input?.organizationId,
			session,
		);
		const configuredProviders: ConfiguredProvider[] = [];
		let hasUserConfig = false;
		let hasOrgConfig = false;
		let defaultProvider: AIProvider | null = null;
		let embeddingProvider: AIProvider | null = null;
		let canResolveProvider = false;

		// TENANT ISOLATION: Query ONLY the appropriate config based on context
		// Never mix personal and organization configurations
		if (organizationId) {
			// Organization context: ONLY query cloud_provider_config
			const orgProviders = await db.cloudProviderConfig.findMany({
				where: { organizationId, enabled: true },
				orderBy: [{ isDefault: "desc" }, { priority: "desc" }],
			});

			if (orgProviders.length > 0) {
				hasOrgConfig = true;
				for (const p of orgProviders) {
					configuredProviders.push({
						provider: p.provider,
						displayName: p.displayName,
						isDefault: p.isDefault,
						isEmbeddingProvider: p.isEmbeddingProvider,
						source: "org_config",
					});
					if (p.isDefault && !defaultProvider) {
						defaultProvider = p.provider;
					}
					if (p.isEmbeddingProvider && !embeddingProvider) {
						embeddingProvider = p.provider;
					}
				}
			}

			// Only the DEFAULT row, because that is the only one the resolver
			// looks at: `resolveTenantProviderConfig` issues a `findFirst` with
			// `isDefault: true`. Asking whether ANY enabled row carries a
			// credential answers a different question, and answers it wrongly
			// for an organization whose default was saved without one while
			// some other row has one — it would report resolvable while every
			// real call refuses, which is the exact divergence this field
			// exists to remove.
			canResolveProvider = orgProviders.some(
				(row) => row.isDefault && rowCarriesCredentials(row),
			);
		} else {
			// Personal context: ONLY query user_cloud_provider_config
			const userProviders = await db.userCloudProviderConfig.findMany({
				where: { userId: user.id, enabled: true },
				orderBy: [{ isDefault: "desc" }, { priority: "desc" }],
			});

			if (userProviders.length > 0) {
				hasUserConfig = true;
				for (const p of userProviders) {
					configuredProviders.push({
						provider: p.provider,
						displayName: p.displayName,
						isDefault: p.isDefault,
						isEmbeddingProvider: p.isEmbeddingProvider,
						source: "user_config",
					});
					if (p.isDefault && !defaultProvider) {
						defaultProvider = p.provider;
					}
					if (p.isEmbeddingProvider && !embeddingProvider) {
						embeddingProvider = p.provider;
					}
				}
			}

			// Same rule as the organization arm above, and for the same reason.
			canResolveProvider = userProviders.some(
				(row) => row.isDefault && rowCarriesCredentials(row),
			);
		}

		// The resolver's last rung, mirrored: inside an organization that
		// resolves nothing of its own, it falls through to the CALLER'S OWN
		// personal default, and a member whose personal key works must not be
		// told that AI cannot run. Filtered by `userId`, so nobody ever reads
		// someone else's configuration, and the rows stay out of every field
		// above — this widens what the caller is told about themselves, not
		// what the organization is told about its tenants.
		if (organizationId && !canResolveProvider) {
			const ownProviders = await db.userCloudProviderConfig.findMany({
				where: { userId: user.id, isDefault: true, enabled: true },
				select: CREDENTIAL_COLUMNS,
			});
			canResolveProvider = ownProviders.some(rowCarriesCredentials);
		}

		// If still no default, use first configured
		if (!defaultProvider && configuredProviders.length > 0) {
			defaultProvider = configuredProviders[0].provider;
			configuredProviders[0].isDefault = true;
		}

		const isConfigured = hasUserConfig || hasOrgConfig;

		// Build status message
		let message: string;
		if (!isConfigured) {
			message =
				"No AI provider configured. Please configure at least one provider in settings.";
		} else if (configuredProviders.length === 1) {
			message = `Using ${configuredProviders[0].displayName || getProviderDisplayName(configuredProviders[0].provider)} as AI provider`;
		} else {
			const defaultName = defaultProvider
				? getProviderDisplayName(defaultProvider)
				: "None";
			message = `${configuredProviders.length} AI providers configured. Default: ${defaultName}`;
		}

		// Get embedding model details if embedding provider is configured
		let embeddingModel: {
			displayName: string;
			modelId: string;
			subProvider: string | null;
		} | null = null;

		if (embeddingProvider) {
			try {
				const modelResult = await getModelForTask(
					user.id,
					embeddingProvider,
					"EMBEDDING" as AiTaskType,
					organizationId,
				);

				if (modelResult?.model) {
					const modelId =
						modelResult.providerModelId ||
						modelResult.model.canonicalName;

					// For gateways, extract sub-provider from model ID (e.g., "openai/text-embedding-3-small" -> "openai")
					let subProvider: string | null = null;
					if (
						isGatewayProvider(embeddingProvider) &&
						modelId.includes("/")
					) {
						subProvider = modelId.split("/")[0];
					}

					embeddingModel = {
						displayName:
							modelResult.model.displayName ||
							modelResult.model.canonicalName,
						modelId,
						subProvider,
					};
				}
			} catch (error) {
				// If model resolution fails, just return null for embeddingModel
				console.warn(
					"[AI Config] Failed to resolve embedding model:",
					error,
				);
			}
		}

		return {
			isConfigured,
			canResolveProvider,
			hasUserConfig,
			hasOrgConfig,
			configuredProviders,
			defaultProvider,
			embeddingProvider,
			embeddingModel,
			message,
		};
	});
