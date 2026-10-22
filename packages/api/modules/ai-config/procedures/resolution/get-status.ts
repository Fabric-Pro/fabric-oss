import type { AIProvider, AiTaskType } from "@repo/database";
import {
	db,
	getAiProviderApiKey,
	getEmbeddingProviderConfig,
	getModelForTask,
	getOrganizationDefaultProvider,
	getPlanSpentPersonalProviderConfig,
	getProviderDisplayName,
	isGatewayProvider,
	LLM_PROVIDER_PURPOSE_FILTER,
	readProviderRowCredentials,
} from "@repo/database";
import {
	type AiProviderPurpose,
	AiProviderPurposeSchema,
} from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

import {
	organizationEmbeddingSchema,
	resolveOrganizationEmbedding,
} from "../../lib/organization-embedding-resolution";

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
 * `canResolveProvider`, `resolvedProvider` / `resolvedProviderSource` and
 * `resolvedEmbeddingProvider` / `resolvedEmbeddingSource` are the fields that
 * describe the CALLER rather than the tenant, and the isolation rule above is
 * unchanged by them. They answer "can *you* reach a provider from here?",
 * "which one, and whose, will chat actually use for *you*?" and the same for
 * embedding, so — exactly like the resolvers they mirror — they may consult the
 * caller's own personal rows while standing inside an organization. Those rows are filtered by `userId`, are
 * never anyone else's, and never enter `configuredProviders` / `hasOrgConfig` /
 * `hasUserConfig` / `defaultProvider` / `embeddingProvider`, which keep
 * describing the tenant alone.
 */

interface ConfiguredProvider {
	provider: AIProvider;
	displayName: string | null;
	isDefault: boolean;
	isEmbeddingProvider: boolean;
	purpose: AiProviderPurpose;
	/** A personal key's opt-in for a spent ChatGPT plan; false for org rows. */
	useWhenPlanSpent: boolean;
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

/** The row the resolver would pick: the default, never an embeddings-only key. */
function isResolvableDefault(row: {
	isDefault: boolean;
	purpose: AiProviderPurpose;
	encryptedApiKey: string | null;
	clientId: string | null;
	encryptedClientSecret: string | null;
	config: unknown;
}): boolean {
	return (
		row.isDefault &&
		row.purpose !== "EMBEDDINGS_ONLY" &&
		rowCarriesCredentials(row)
	);
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
 * COST, stated honestly: the dedicated-row lookup here, plus the tenant
 * resolver the handler now runs on every call for the chat path (Fizzy #3082)
 * and hands in as rung 2 — one read in personal context, up to two inside an
 * organization, since it may try the organization's default row and then the
 * caller's own. They land on a query the web client caches with a 60-second
 * stale time and shares between the chrome's AI notices. Correctness by construction was chosen over inference:
 * the inference it replaces was wrong in three reachable states (see the
 * field's doc comment on the output schema below).
 */
async function resolveEmbeddingProviderForCaller(
	{
		userId,
		organizationId,
	}: {
		userId: string;
		// Matches the resolvers' own signature rather than narrowing it, so the
		// absent-organization case arrives here exactly as it arrives at runtime.
		organizationId?: string | null;
	},
	// Rung 2, already asked: the tenant resolver's answer is the same
	// question the chat path asks, so the handler asks it once and hands it
	// to both. Null when that call failed — rung 2 then cannot answer.
	tenant: ResolvedProvider | null,
): Promise<ResolvedProvider> {
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

	return tenant ?? { provider: null, source: null };
}

/**
 * The provider a user-facing AI call (chat, agents, generation) lands on for
 * this caller, from the same tenant entry point the runtime uses: the
 * organization's default row, then the caller's own personal default.
 *
 * The tenant entry point, not the system one: see "ONE RUNG SHORT" above.
 * Already `string | null` — the "nothing configured" shape carries a null
 * provider. Only the identifier and its origin leave this function.
 */
async function resolveTenantProviderForCaller({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId?: string | null;
}): Promise<ResolvedProvider> {
	const tenant = await getAiProviderApiKey({ userId, organizationId });
	return {
		provider: tenant.provider,
		source: normalizeSource(tenant.source),
	};
}

type ResolvedProvider = {
	provider: string | null;
	source: "organization" | "user" | null;
};

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
			organizationEmbedding: organizationEmbeddingSchema.nullable(),
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
			 * It describes the caller. `organizationEmbedding` separately describes
			 * the organization-only outcome used by settings. Stored configuration
			 * fields are not interchangeable with either resolution.
			 *
			 * It exists because a UI notice used to infer the outcome from
			 * `defaultProvider` / `embeddingProvider` / `configuredProviders`,
			 * and that inference is wrong in three reachable states:
			 *
			 * 1. The organization has enabled rows but no explicit usable
			 *    default, so `defaultProvider` is null while the caller may
			 *    resolve to their own personal provider.
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
			/**
			 * What a user-facing AI call (chat, agents, generation) resolves
			 * to for this caller when it runs on a provider key — the
			 * provider `getAiProviderApiKey` returns, the function the runtime
			 * calls. A ChatGPT plan that serves the caller's own work is
			 * consulted before any key at runtime and is NOT reflected here;
			 * readers check the plan separately.
			 *
			 * Describes the CALLER, like `canResolveProvider`: inside an
			 * organization with no usable default of its own it is the caller's
			 * personal default, filtered by `userId`. Null when nothing
			 * resolves or the lookup failed.
			 */
			resolvedProvider: z.string().nullable(),
			/**
			 * WHOSE key the provider above came from. `"user"` inside an
			 * organization means the caller's work there is billed to their
			 * own personal key, which the app tells them about. Null when
			 * nothing resolved or the origin is one this field does not model.
			 */
			resolvedProviderSource: z.enum(["organization", "user"]).nullable(),
			hasUserConfig: z.boolean(),
			hasOrgConfig: z.boolean(),
			configuredProviders: z.array(
				z.object({
					provider: z.string(),
					displayName: z.string().nullable(),
					isDefault: z.boolean(),
					isEmbeddingProvider: z.boolean(),
					purpose: AiProviderPurposeSchema,
					/**
					 * The caller's own key stands in for a spent ChatGPT plan
					 * (Fizzy #3085). Always false for an organization's key.
					 */
					useWhenPlanSpent: z.boolean(),
					source: z.string(),
				}),
			),
			/**
			 * The provider of the CALLER'S OWN key that serves their work
			 * while every ChatGPT plan is spent (Fizzy #3085), whichever
			 * context they ask from; null when they opted none in or the
			 * lookup failed. Filtered by `userId`, like `resolvedProvider`:
			 * it never describes another member, and never enters the
			 * tenant fields above.
			 */
			planSpentPersonalProvider: z.string().nullable(),
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
		let organizationEmbedding: Awaited<
			ReturnType<typeof resolveOrganizationEmbedding>
		> | null = null;
		if (organizationId) {
			try {
				organizationEmbedding = await resolveOrganizationEmbedding({
					organizationId,
					userId: user.id,
				});
			} catch (error) {
				console.error(
					"[AI Config] Failed to resolve organization embeddings:",
					error,
				);
			}
		}
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

			defaultProvider =
				await getOrganizationDefaultProvider(organizationId);

			if (orgProviders.length > 0) {
				hasOrgConfig = true;
				for (const p of orgProviders) {
					configuredProviders.push({
						provider: p.provider,
						displayName: p.displayName,
						isDefault:
							p.isDefault && p.provider === defaultProvider,
						isEmbeddingProvider: p.isEmbeddingProvider,
						purpose: p.purpose,
						useWhenPlanSpent: false,
						source: "org_config",
					});

					if (p.isEmbeddingProvider && !embeddingProvider) {
						embeddingProvider = p.provider;
					}
				}
			}

			// The same explicit usable organization default as every settings path.
			canResolveProvider = !!defaultProvider;
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
						purpose: p.purpose,
						useWhenPlanSpent: p.useWhenPlanSpent,
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
			canResolveProvider = userProviders.some(isResolvableDefault);
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
				where: {
					userId: user.id,
					isDefault: true,
					enabled: true,
					...LLM_PROVIDER_PURPOSE_FILTER,
				},
				select: CREDENTIAL_COLUMNS,
			});
			canResolveProvider = ownProviders.some(rowCarriesCredentials);
		}

		// Ask the runtime resolver for the caller's outcome separately from
		// the organization's explicit default. The personal-context display
		// fallback below must not feed either resolved field.
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
		//
		// The chat path's answer is asked first, because the embedding path's
		// second rung is the same question: one call answers both.
		let tenantResolution: ResolvedProvider | null = null;
		try {
			tenantResolution = await resolveTenantProviderForCaller({
				userId: user.id,
				organizationId,
			});
		} catch (error) {
			console.error(
				"[AI Config] Failed to resolve the tenant provider:",
				error,
			);
		}

		let resolvedEmbeddingProvider: string | null = null;
		let resolvedEmbeddingSource: "organization" | "user" | null = null;
		try {
			const resolved = await resolveEmbeddingProviderForCaller(
				{
					userId: user.id,
					organizationId,
				},
				tenantResolution,
			);
			resolvedEmbeddingProvider = resolved.provider;
			resolvedEmbeddingSource = resolved.source;
		} catch (error) {
			console.error(
				"[AI Config] Failed to resolve the embedding provider:",
				error,
			);
		}

		// Keep the legacy display fallback in personal context only.
		const fallbackDefault = configuredProviders.find(
			(p) => p.purpose !== "EMBEDDINGS_ONLY",
		);
		if (!organizationId && !defaultProvider && fallbackDefault) {
			defaultProvider = fallbackDefault.provider;
			fallbackDefault.isDefault = true;
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

		if (organizationEmbedding?.model) {
			embeddingModel = {
				displayName: organizationEmbedding.model.displayName,
				modelId: organizationEmbedding.model.modelString,
				subProvider: organizationEmbedding.model.subProvider,
			};
		} else if (!organizationId && embeddingProvider) {
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

		// Caught like the reads above: a status payload must not fail on it.
		let planSpentPersonalProvider: string | null = null;
		try {
			planSpentPersonalProvider =
				(await getPlanSpentPersonalProviderConfig({ userId: user.id }))
					?.provider ?? null;
		} catch (error) {
			console.error(
				"[AI Config] Failed to read the plan-spent personal key:",
				error,
			);
		}

		return {
			isConfigured,
			canResolveProvider,
			planSpentPersonalProvider,
			resolvedEmbeddingProvider,
			resolvedEmbeddingSource,
			resolvedProvider: tenantResolution?.provider ?? null,
			resolvedProviderSource: tenantResolution?.source ?? null,
			hasUserConfig,
			hasOrgConfig,
			configuredProviders,
			defaultProvider,
			embeddingProvider,
			embeddingModel,
			organizationEmbedding,
			message,
		};
	});
