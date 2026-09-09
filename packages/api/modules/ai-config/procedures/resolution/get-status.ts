import type { AIProvider, AiTaskType } from "@repo/database";
import {
	db,
	getAiProviderApiKey,
	getEmbeddingProviderConfig,
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
 * `canResolveProvider` and `resolvedEmbeddingProvider` are the TWO fields that
 * describe the CALLER rather than the tenant, and the isolation rule above is
 * unchanged by them. They answer "can *you* reach a provider from here?" and
 * "which one will embedding actually use for *you*?", so — exactly like the
 * resolvers they mirror — they may consult the caller's own personal rows while
 * standing inside an organization. Those rows are filtered by `userId`, are
 * never anyone else's, and never enter `configuredProviders` / `hasOrgConfig` /
 * `hasUserConfig` / `defaultProvider` / `embeddingProvider`, which keep
 * describing the tenant alone.
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

/**
 * The provider the EMBEDDING path would actually resolve to for this caller.
 *
 * Mirrors `resolveModelWithProvider`'s embedding branch
 * (`packages/ai/lib/dynamic-model-selector.ts`) rung for rung by CALLING the
 * same two functions rather than restating what they do — a restatement is
 * exactly the drift this helper exists to remove:
 *
 * 1. `getEmbeddingProviderConfig` — the row explicitly marked "use for
 *    documents". If it yields a provider, that is the answer.
 * 2. otherwise `getAiProviderApiKey` — the tenant's default row, then the
 *    CALLER'S OWN personal default.
 * 3. neither yields one → null.
 *
 * ONE RUNG SHORT, on purpose. At runtime the second step is
 * `getSystemAiProviderApiKey`, which has a third rung this helper does not
 * follow: the deployment's own platform gateway key. Stopping before it is
 * safe for the question this field answers, because that rung is hardcoded to
 * `VERCEL_GATEWAY` and so can never be the provider a caller needs warning
 * about. Following it would buy nothing and cost two things — the platform
 * config encrypts its key on every call, and `encryptApiKey` runs a synchronous
 * scrypt, which is not work to put on an endpoint the app shell hits on every
 * page load; and the returned `VERCEL_GATEWAY` would tell every tenant that the
 * deployment holds a platform key and which provider it points at. A caller who
 * reaches that rung has no tenant provider at all, which the neighbouring
 * `canResolveProvider` already reports.
 *
 * SECURITY: both functions return stored credential material — the encrypted
 * key, `clientId`, `encryptedClientSecret`, `baseUrl`, the raw config. It is
 * ciphertext, not plaintext: decryption happens further downstream, never
 * here. Only `.provider`, an identifier such as `"ANTHROPIC"`, is read out
 * of them, and only that string is returned. The rest never leaves this
 * function.
 *
 * COST, stated honestly: two extra database reads in personal context, and
 * up to three inside an organization — the tenant resolver may try the
 * organization's default row and then the caller's own before answering. They
 * land on a query the web client caches with a 60-second stale time and shares
 * between two banners. Correctness by construction was chosen over inference:
 * the inference it replaces was wrong in three reachable states (see the
 * field's doc comment on the output schema below).
 */
async function resolveEmbeddingProviderForCaller({
	userId,
	organizationId,
}: {
	userId: string;
	// Matches the resolvers' own signature rather than narrowing it, so the
	// absent-organization case arrives here exactly as it arrives at runtime.
	organizationId?: string | null;
}): Promise<{
	provider: string | null;
	source: "organization" | "user" | null;
}> {
	const dedicated = await getEmbeddingProviderConfig({
		userId,
		organizationId,
	});
	if (dedicated.provider) {
		return {
			provider: dedicated.provider,
			source: normalizeSource(dedicated.source),
		};
	}

	// The tenant entry point, not the system one: see "ONE RUNG SHORT" above.
	// Already `string | null` — the "nothing configured" shape carries a null
	// provider, which is rung 3.
	const tenant = await getAiProviderApiKey({ userId, organizationId });
	return {
		provider: tenant.provider,
		source: normalizeSource(tenant.source),
	};
}

/**
 * Whose row the resolver landed on, narrowed to the two answers a caller can
 * act on differently.
 *
 * The resolvers type `source` loosely and use it for their own bookkeeping; a
 * notice branching a remedy on it needs only "the organization's" or "my own",
 * and must not guess when it is neither.
 */
function normalizeSource(source: unknown): "organization" | "user" | null {
	return source === "organization" || source === "user" ? source : null;
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
			/**
			 * What embedding resolution will ACTUALLY land on for this caller —
			 * the provider `resolveModelWithProvider` returns for an EMBEDDING
			 * task, obtained by calling the very functions the runtime calls.
			 * It is the only field in this payload describing a RESOLVED
			 * OUTCOME; every other provider field describes STORED
			 * CONFIGURATION, and the two are not interchangeable.
			 *
			 * It exists because a UI notice used to infer the outcome from
			 * `defaultProvider` / `embeddingProvider` / `configuredProviders`,
			 * and that inference is wrong in three reachable states:
			 *
			 * 1. The organization has enabled rows but none marked `isDefault`,
			 *    so the back-fill below fabricates a `defaultProvider` from
			 *    `configuredProviders[0]` — a row the resolver's
			 *    `findFirst({ isDefault: true })` never sees. The caller
			 *    meanwhile resolves to their own personal provider.
			 * 2. The organization's default row IS that provider but carries no
			 *    usable credential, so the resolver rejects it and falls
			 *    through to the caller's personal default.
			 * 3. The organization has no rows at all, so every tenant-scoped
			 *    field here is null while the caller's personal default
			 *    resolves — the inference misses a real outcome entirely.
			 *
			 * Like `canResolveProvider`, this describes the CALLER, so it may
			 * reflect the caller's own personal rows — filtered by `userId`,
			 * never anyone else's.
			 *
			 * It stops one rung short of `resolveModelWithProvider`: the
			 * deployment's platform gateway key is not consulted, so `null`
			 * means "no provider the TENANT can reach", not "the embedding will
			 * fail". See "ONE RUNG SHORT" on the helper for why following that
			 * rung would cost a synchronous scrypt on this endpoint and tell
			 * every tenant the platform key exists, while never changing the
			 * answer the notice reading this field asks for.
			 *
			 * Only the provider IDENTIFIER travels: the stored, still-encrypted
			 * credential material those resolvers return is dropped inside
			 * `resolveEmbeddingProviderForCaller`, and would be stripped here
			 * regardless, since this `z.object` removes unknown keys.
			 */
			resolvedEmbeddingProvider: z.string().nullable(),
			/**
			 * WHOSE configuration the provider above came from — the
			 * organization's, or the caller's own.
			 *
			 * A notice about a missing capability has to address someone, and
			 * role alone answers that wrongly. The resolver consults the
			 * organization's default and then the caller's own, so a member who
			 * administers nothing can still be the person whose row the embedding
			 * landed on, and the only person who can move it. Telling them to
			 * find an admin is true — an organization-level assignment outranks
			 * their row — but sends them past the fix they already own.
			 *
			 * Null when nothing resolved, or when the resolver reported an origin
			 * this field does not model: a caller that cannot tell whose it is
			 * should say nothing about whose it is.
			 */
			resolvedEmbeddingSource: z
				.enum(["organization", "user"])
				.nullable(),
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

		// Asked, never inferred. Computed BEFORE the back-fill below so it is
		// visibly independent of it: the back-fill invents a `defaultProvider`
		// the resolver would never pick, and this field must not inherit that
		// invention. See the output-schema comment for the three states the old
		// inference got wrong; the helper carries the cost note.
		//
		// Sequential on purpose. It needs nothing this block produces, so it
		// could start alongside it behind the usual `.catch(() => {})` marker —
		// that is one line, not a barrier. The reason to stay sequential is that
		// the latency it would buy does not matter on a query cached for a
		// minute and shared between two banners, and the straight line is easier
		// to read than the idiom.
		//
		// Caught, like the model lookup below, because this endpoint is not only
		// the banners': anything reading the status treats a failed call as "not
		// configured", so letting two new reads fail the whole payload would
		// take unrelated surfaces down with them. A resolver that cannot answer
		// leaves the field null, which every reader already handles as "we do
		// not know" and nobody reads as Anthropic.
		let resolvedEmbeddingProvider: string | null = null;
		let resolvedEmbeddingSource: "organization" | "user" | null = null;
		try {
			const resolved = await resolveEmbeddingProviderForCaller({
				userId: user.id,
				organizationId,
			});
			resolvedEmbeddingProvider = resolved.provider;
			resolvedEmbeddingSource = resolved.source;
		} catch (error) {
			console.error(
				"[AI Config] Failed to resolve the embedding provider:",
				error,
			);
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
			resolvedEmbeddingProvider,
			resolvedEmbeddingSource,
			hasUserConfig,
			hasOrgConfig,
			configuredProviders,
			defaultProvider,
			embeddingProvider,
			embeddingModel,
			message,
		};
	});
