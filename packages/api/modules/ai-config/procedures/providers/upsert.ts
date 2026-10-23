/**
 * Upsert User Provider Configuration
 *
 * Creates or updates an AI provider configuration for the current user.
 * Stores configuration in user_cloud_provider_config table.
 */

import { ORPCError } from "@orpc/server";
import {
	type AIProvider,
	type AiTaskType,
	ALL_EMBEDDING_CAPABLE_PROVIDERS,
	canProviderSupportEmbeddings,
	db,
	getProviderDisplayName,
	getProviderMetadata,
	LLM_PROVIDER_PURPOSE_FILTER,
	lockTenantProviderConnections,
	organizationDefaultProviderWhere,
	type Prisma,
	readProviderRowCredentials,
	taskDefaultsSnapshotMutation,
} from "@repo/database";
import { disableOrgDecisionPreferenceForProvider } from "@repo/database/prisma/queries/organization-model-preference-write";
import {
	type AiProviderPurpose,
	AiProviderPurposeSchema,
} from "@repo/database/prisma/zod";
import { encryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../../organizations/lib/membership";
import {
	defaultProviderSwitchPreviewSchema,
	defaultProviderSwitchRules,
	EMBEDDINGS_ONLY_DEFAULT_MESSAGE,
	pinDefaultSwitchEmbeddings,
	planDefaultProviderSwitch,
	prepareDefaultSwitchEmbeddings,
	previewDefaultProviderSwitch,
} from "../../lib/default-provider-switch";
import { assertEmbeddingPreferenceFitsVectorStore } from "../../lib/embedding-model-guard";
import {
	type ProviderAuditScope,
	type ProviderAuditSnapshot,
	recordProviderConfigured,
	recordProviderDeleted,
	recordProviderSettingChanged,
	snapshotProviderRow,
} from "../../lib/provider-audit";
import { refineProviderCredentials } from "../../lib/provider-credentials";
// Shared with `providers/test-connection.ts` so the SSRF rules applied when
// TESTING a URL are identical to those applied when STORING one.
import { validateProviderUrl } from "../../lib/provider-url";

/**
 * The credential columns written for a provider config. Exactly one auth mode
 * is populated and the other is explicitly nulled, so switching a provider from
 * an API key to a service principal (or back) never leaves a stale credential
 * behind that a read path could pick up.
 */
interface ProviderCredentialFields {
	encryptedApiKey: string | null;
	clientId: string | null;
	encryptedClientSecret: string | null;
}

/**
 * Build the credential columns from validated input. The XOR is already
 * guaranteed by the input schema's superRefine; this just encrypts the secret
 * and nulls the unused mode.
 */
function buildCredentialFields(input: {
	apiKey?: string;
	clientId?: string;
	clientSecret?: string;
}): ProviderCredentialFields {
	if (input.clientId && input.clientSecret) {
		return {
			encryptedApiKey: null,
			clientId: input.clientId,
			encryptedClientSecret: encryptApiKey(input.clientSecret),
		};
	}
	return {
		encryptedApiKey: encryptApiKey(input.apiKey as string),
		clientId: null,
		encryptedClientSecret: null,
	};
}

/**
 * Validate a save's purpose against the request and the tenant's other rows.
 * An embeddings-only key is always the documents provider, so there is never
 * more than one, and it is never the default.
 */
function assertPurposeAllowed(params: {
	provider: AIProvider;
	purpose: AiProviderPurpose;
	requestedDefault: boolean | undefined;
	otherEmbeddingsOnlyProvider: string | null;
}) {
	if (params.purpose !== "EMBEDDINGS_ONLY") {
		return;
	}
	if (params.requestedDefault === true) {
		throw new ORPCError("BAD_REQUEST", {
			message: EMBEDDINGS_ONLY_DEFAULT_MESSAGE,
		});
	}
	if (!canProviderSupportEmbeddings(params.provider)) {
		throw new ORPCError("BAD_REQUEST", {
			message: `${getProviderDisplayName(params.provider)} does not support embeddings, so it cannot be an embeddings-only key.`,
		});
	}
	if (params.otherEmbeddingsOnlyProvider) {
		throw new ORPCError("BAD_REQUEST", {
			message: `${getProviderDisplayName(params.otherEmbeddingsOnlyProvider as AIProvider)} is already the embeddings-only key. Change its purpose or remove it first.`,
		});
	}
}

/**
 * The documents flag cannot leave an embeddings-only key: that key would then
 * serve nothing at all, while still looking configured.
 */
function assertEmbeddingFlagCanMove(
	current: { provider: string; purpose: AiProviderPurpose } | null,
	target: AIProvider,
) {
	if (current?.purpose === "EMBEDDINGS_ONLY" && current.provider !== target) {
		throw new ORPCError("BAD_REQUEST", {
			message: `${getProviderDisplayName(current.provider as AIProvider)} is an embeddings-only key and must stay the documents provider. Change its purpose or remove it first.`,
		});
	}
}

/**
 * The model preferences an embeddings-only (or deleted) key can no longer
 * serve: every task but EMBEDDING, which stays with the documents provider.
 * Left in place they would still show as the task's model in the settings
 * form while nothing could run them.
 */
function llmPreferencesPinnedTo(provider: AIProvider) {
	return { provider, taskType: { not: "EMBEDDING" as AiTaskType } };
}

interface EmbeddingRowLike {
	provider: string;
	isDefault: boolean;
	isEmbeddingProvider: boolean;
	purpose: AiProviderPurpose;
}

function embeddingChangeAudit(
	target: EmbeddingRowLike | null,
	previous: EmbeddingRowLike | null,
	change: {
		purpose: AiProviderPurpose | undefined;
		defaultReassignedTo: string | null;
	},
) {
	const beforePurpose = target?.purpose ?? "ALL";
	const afterPurpose = change.purpose ?? beforePurpose;
	const loseDefault =
		afterPurpose === "EMBEDDINGS_ONLY" && Boolean(target?.isDefault);
	return {
		before: {
			isEmbeddingProvider: target?.isEmbeddingProvider ?? false,
			purpose: beforePurpose,
			...(loseDefault ? { isDefault: true } : {}),
		},
		after: {
			isEmbeddingProvider: true,
			purpose: afterPurpose,
			...(loseDefault ? { isDefault: false } : {}),
		},
		details: {
			previousEmbeddingProvider: previous?.provider ?? null,
			...(change.defaultReassignedTo
				? { defaultReassignedTo: change.defaultReassignedTo }
				: {}),
		},
	};
}

interface UpsertOutcome {
	result: {
		success: boolean;
		id: string;
		provider: string;
		displayName: string | null;
		isDefault: boolean;
		purpose: AiProviderPurpose;
	};
	/** Row state before the write (null when created) and after it. */
	before: ProviderAuditSnapshot | null;
	after: ProviderAuditSnapshot;
	embeddingPin?: {
		id: string;
		provider: string;
		previousEmbeddingProvider: string | null;
	} | null;
}

function recordDefaultSwitchEmbeddingPin(
	context: Parameters<typeof recordProviderSettingChanged>[0],
	scope: ProviderAuditScope,
	pin: UpsertOutcome["embeddingPin"],
) {
	if (pin) {
		recordProviderSettingChanged(context, scope, "embedding_changed", pin, {
			before: { isEmbeddingProvider: false },
			after: { isEmbeddingProvider: true },
			details: {
				reason: "pinned_by_default_switch",
				previousEmbeddingProvider: pin.previousEmbeddingProvider,
			},
		});
	}
}

/** Only a usable LLM key may be promoted, even when a stale default flag exists. */
async function findUsableOrganizationProvider(
	tx: Prisma.TransactionClient,
	organizationId: string,
	exclude: Prisma.CloudProviderConfigWhereInput = {},
) {
	const rows = await tx.cloudProviderConfig.findMany({
		where: {
			organizationId,
			enabled: true,
			...LLM_PROVIDER_PURPOSE_FILTER,
			...exclude,
		},
	});
	return (
		rows.find((row) => readProviderRowCredentials(row).hasCredentials) ??
		null
	);
}

/** Resolve the default from locked tenant rows before changing any flags. */
async function findResolvedDefaultProvider(
	tx: Prisma.TransactionClient,
	scope: { type: "organization" | "user"; id: string },
) {
	const row =
		scope.type === "organization"
			? await tx.cloudProviderConfig.findFirst({
					where: organizationDefaultProviderWhere(scope.id),
				})
			: await tx.userCloudProviderConfig.findFirst({
					where: {
						userId: scope.id,
						isDefault: true,
						enabled: true,
						...LLM_PROVIDER_PURPOSE_FILTER,
					},
				});
	return row && readProviderRowCredentials(row).hasCredentials
		? row.provider
		: null;
}

async function promoteOrganizationProvider(
	tx: Prisma.TransactionClient,
	organizationId: string,
	id: string,
	currentDefaultProvider: AIProvider | null,
) {
	const target = await tx.cloudProviderConfig.findUnique({ where: { id } });
	const snapshotMutation = target
		? await taskDefaultsSnapshotMutation(
				target.provider,
				{ isDefault: currentDefaultProvider === target.provider },
				true,
				tx,
			)
		: {};
	await tx.cloudProviderConfig.updateMany({
		where: { organizationId },
		data: { isDefault: false },
	});
	await tx.cloudProviderConfig.update({
		where: { id },
		data: { isDefault: true, ...snapshotMutation },
	});
}

/**
 * Upsert organization-level provider configuration
 * Saves to cloud_provider_config table for organization-wide access
 */
interface OrganizationProviderUpsert {
	organizationId: string;
	userId: string;
	provider: AIProvider;
	displayName: string;
	credentials: ProviderCredentialFields;
	isDefault?: boolean;
	purpose?: AiProviderPurpose;
	enabledProviders?: string[];
	baseUrl?: string;
	/** For Azure AI Foundry - the deployment name (user-defined) */
	deploymentName?: string;
}

async function upsertOrganizationProvider({
	organizationId,
	userId,
	provider,
	displayName,
	credentials,
	isDefault,
	purpose: requestedPurpose,
	enabledProviders,
	baseUrl,
	deploymentName,
}: OrganizationProviderUpsert): Promise<UpsertOutcome> {
	const preparedEmbeddings = await prepareDefaultSwitchEmbeddings({
		organizationId,
		userId,
		targetProvider: isDefault === true ? provider : undefined,
	});
	// Revalidate the pre-read under lock before committing provider writes
	// Existing targets are locked before deriving their default transition.
	return await db.$transaction(async (tx) => {
		await lockTenantProviderConnections(tx, {
			type: "organization",
			id: organizationId,
		});
		const currentDefaultProvider = await findResolvedDefaultProvider(tx, {
			type: "organization",
			id: organizationId,
		});
		// Check if this provider already exists for this organization
		const existing = await tx.cloudProviderConfig.findUnique({
			where: {
				organizationId_provider: {
					organizationId,
					provider,
				},
			},
		});

		const notThisRow = existing ? { id: { not: existing.id } } : {};
		const purpose = requestedPurpose ?? existing?.purpose ?? "ALL";
		const embeddingsOnly = purpose === "EMBEDDINGS_ONLY";
		if (embeddingsOnly) {
			const otherEmbeddingsOnly = await tx.cloudProviderConfig.findFirst({
				where: { organizationId, purpose, ...notThisRow },
			});
			assertPurposeAllowed({
				provider,
				purpose,
				requestedDefault: isDefault,
				otherEmbeddingsOnlyProvider:
					otherEmbeddingsOnly?.provider ?? null,
			});
		}

		// Determine if this should be default (first provider or explicitly set)
		// Derive the default choice after locking and refreshing the target.
		// Embeddings-only rows never count: they can never be the default.
		const otherEnabledProvider = await findUsableOrganizationProvider(
			tx,
			organizationId,
			notThisRow,
		);
		// Check if there's another provider that IS default (not just enabled)
		const otherDefaultRow = await tx.cloudProviderConfig.findFirst({
			where: {
				...organizationDefaultProviderWhere(organizationId),
				...notThisRow,
			},
		});
		const otherDefaultProvider =
			otherDefaultRow &&
			readProviderRowCredentials(otherDefaultRow).hasCredentials
				? otherDefaultRow
				: null;
		// Logic:
		// 0. An embeddings-only key is never default
		// 1. If explicitly set to true, use that
		// 2. If no other providers exist, this MUST be default
		// 3. If other providers exist but none are default, this MUST be default
		// 4. Only respect explicit false if there's another default provider
		const shouldBeDefault =
			!embeddingsOnly &&
			(isDefault === true ||
				!otherEnabledProvider ||
				!otherDefaultProvider);

		const snapshotMutation = await taskDefaultsSnapshotMutation(
			provider,
			existing
				? { isDefault: currentDefaultProvider === provider }
				: null,
			shouldBeDefault,
			tx,
		);

		let embeddingPin: UpsertOutcome["embeddingPin"] = null;
		// Validate routing and pin before changing the default; upsert keeps saved preferences.
		if (shouldBeDefault) {
			const currentDefault = await tx.cloudProviderConfig.findFirst({
				where: organizationDefaultProviderWhere(organizationId),
			});
			embeddingPin = (
				await pinDefaultSwitchEmbeddings(tx, {
					organizationId,
					userId,
					targetProvider: provider,
					prepared: preparedEmbeddings,
					currentDefault,
				})
			).pin;

			await tx.cloudProviderConfig.updateMany({
				where: { organizationId, isDefault: true },
				data: { isDefault: false },
			});
		}
		if (embeddingsOnly) {
			await disableOrgDecisionPreferenceForProvider(
				tx,
				organizationId,
				provider,
			);
			await tx.organizationModelPreference.deleteMany({
				where: { organizationId, ...llmPreferencesPinnedTo(provider) },
			});
			// It is the documents provider by definition.
			await tx.cloudProviderConfig.updateMany({
				where: {
					organizationId,
					isEmbeddingProvider: true,
					...notThisRow,
				},
				data: { isEmbeddingProvider: false },
			});
			// Never leave the organization without a default it could have.
			if (
				otherEnabledProvider &&
				(!currentDefaultProvider || currentDefaultProvider === provider)
			) {
				await promoteOrganizationProvider(
					tx,
					organizationId,
					otherEnabledProvider.id,
					currentDefaultProvider,
				);
			}
		}
		const purposeFields = {
			purpose,
			...(embeddingsOnly ? { isEmbeddingProvider: true } : {}),
		};

		if (existing) {
			// Update existing - merge with existing config
			const existingConfig =
				(existing.config as Record<string, unknown>) || {};
			// Store API key in dedicated encrypted column, remove from JSON config
			const newConfig = {
				...existingConfig,
				// Remove apiKey from config (now stored in encryptedApiKey column)
				apiKey: undefined,
				...(enabledProviders !== undefined && { enabledProviders }),
				...(baseUrl !== undefined && { baseUrl }),
				...(deploymentName !== undefined && { deploymentName }),
			};

			const updated = await tx.cloudProviderConfig.update({
				where: { id: existing.id },
				data: {
					config: newConfig as any,
					...credentials,
					displayName,
					enabled: true,
					isDefault: shouldBeDefault,
					...snapshotMutation,
					...purposeFields,
					updatedAt: new Date(),
				},
			});

			return {
				result: {
					success: true,
					id: updated.id,
					provider: updated.provider,
					displayName: updated.displayName,
					isDefault: updated.isDefault,
					purpose: updated.purpose,
				},
				before: snapshotProviderRow(existing),
				after: snapshotProviderRow(updated),
				embeddingPin,
			};
		}

		// Create new
		const newConfig = {
			...(enabledProviders !== undefined && { enabledProviders }),
			...(baseUrl !== undefined && { baseUrl }),
			...(deploymentName !== undefined && { deploymentName }),
		};

		const created = await tx.cloudProviderConfig.create({
			data: {
				id: `cpc_${crypto.randomUUID()}`,
				organizationId,
				provider,
				...credentials,
				config: newConfig as any,
				displayName,
				enabled: true,
				isDefault: shouldBeDefault,
				...snapshotMutation,
				...purposeFields,
				priority: 1,
				updatedAt: new Date(),
			},
		});

		console.log(
			`[AI Config] Created organization provider ${provider} for org ${organizationId}`,
		);

		return {
			result: {
				success: true,
				id: created.id,
				provider: created.provider,
				displayName: created.displayName,
				isDefault: created.isDefault,
				purpose: created.purpose,
			},
			before: null,
			after: snapshotProviderRow(created),
			embeddingPin,
		};
	});
}

export const upsertUserProviderProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_EDIT))
	.route({
		method: "POST",
		path: "/ai-config/providers/upsert",
		tags: ["AI Config"],
		summary: "Create or update AI provider configuration",
		description:
			"Save an AI provider configuration for the current user or organization",
	})
	.input(
		z
			.object({
				provider: z.string(),
				// Optional at the schema level so a Databricks service principal
				// can be saved instead; the superRefine below still requires it
				// for every other provider.
				apiKey: z.string().optional(),
				// Databricks service-principal (OAuth M2M) credentials.
				clientId: z.string().optional(),
				clientSecret: z.string().optional(),
				displayName: z.string().optional(),
				isDefault: z.boolean().optional(),
				// Omitted on an update keeps the row's current purpose.
				purpose: AiProviderPurposeSchema.optional(),
				enabledProviders: z.array(z.string()).optional(),
				baseUrl: z.string().optional(), // Custom base URL for gateways
				deploymentName: z.string().optional(), // For Azure AI Foundry - the deployment name (user-defined)
				organizationId: z.string().nullable().optional(), // If provided, saves to org-level config
			})
			.superRefine((input, ctx) => {
				// A member connects their own ChatGPT plan with the CLI; it is
				// never a provider row anyone configures with a key.
				if (input.provider === "OPENAI_CHATGPT_PLAN") {
					ctx.addIssue({
						code: "custom",
						path: ["provider"],
						message:
							"A ChatGPT plan is connected with `fabric connect chatgpt`, not configured as a provider",
					});
					return;
				}
				const metadata = getProviderMetadata(
					input.provider as AIProvider,
				);
				// Shared with `testConnection` so a config can never pass the
				// tester in a shape the writer rejects, or vice versa.
				refineProviderCredentials(
					input,
					ctx,
					Boolean(metadata?.supportsServicePrincipal),
					metadata?.displayName,
				);
			}),
	)
	.output(
		z.object({
			success: z.boolean(),
			id: z.string(),
			provider: z.string(),
			displayName: z.string().nullable(),
			isDefault: z.boolean(),
			purpose: AiProviderPurposeSchema,
		}),
	)
	.handler(async ({ context, input }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);
		const provider = input.provider as AIProvider;
		const keyChanged = Boolean(input.apiKey || input.clientSecret);

		// Enforce the `requiresBaseUrl` invariant at the persistence boundary.
		// The client forms already block an empty base URL for these providers,
		// but a direct oRPC call could otherwise persist a Databricks / Azure AI
		// Foundry / AWS Bedrock / Cloudflare AI config with no base URL — a bad
		// state that downstream misroutes the tenant's provider key (see the
		// agent `ai-config` route). Reject it here so the invariant holds
		// regardless of caller.
		const providerMetadata = getProviderMetadata(provider);
		if (providerMetadata?.requiresBaseUrl && !input.baseUrl?.trim()) {
			throw new ORPCError("BAD_REQUEST", {
				message: `${providerMetadata.displayName} requires a base URL. Please configure the base URL for this provider.`,
			});
		}

		// These endpoints receive provider credentials during model resolution.
		// Apply the connection-test URL rules here as well so direct saves cannot
		// bypass them, regardless of the provider's authentication mode.
		if (
			(provider === "DATABRICKS" || provider === "AZURE_AI_FOUNDRY") &&
			input.baseUrl?.trim()
		) {
			const urlValidation = validateProviderUrl(
				input.baseUrl.trim(),
				provider,
			);
			if (!urlValidation.valid) {
				const providerUrlName =
					provider === "DATABRICKS"
						? "Databricks workspace"
						: "Azure AI Foundry";
				throw new ORPCError("BAD_REQUEST", {
					message: `Invalid ${providerUrlName} URL: ${
						urlValidation.error ?? "not an allowed provider URL"
					}`,
				});
			}
		}

		const displayName =
			input.displayName || getProviderDisplayName(provider);

		// Encrypt once, up front. Exactly one auth mode is populated and the
		// other is explicitly nulled (see buildCredentialFields), so switching
		// modes clears the credential that is no longer in use.
		const credentials = buildCredentialFields(input);

		// If organizationId is provided, save to organization-level config
		if (organizationId) {
			// Verify user is an admin or owner of the organization
			const membership = await requireOrgMembership(
				user.id,
				organizationId,
				["owner", "admin"],
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Only organization admins can configure AI providers",
				});
			}

			const outcome = await upsertOrganizationProvider({
				organizationId,
				userId: user.id,
				provider,
				displayName,
				credentials,
				isDefault: input.isDefault,
				purpose: input.purpose,
				enabledProviders: input.enabledProviders,
				baseUrl: input.baseUrl,
				deploymentName: input.deploymentName,
			});
			recordProviderConfigured(
				context,
				{ kind: "org", organizationId },
				outcome.result,
				{ before: outcome.before, after: outcome.after, keyChanged },
			);
			recordDefaultSwitchEmbeddingPin(
				context,
				{ kind: "org", organizationId },
				outcome.embeddingPin,
			);
			return outcome.result;
		}

		const preparedEmbeddings = await prepareDefaultSwitchEmbeddings({
			organizationId,
			userId: user.id,
			targetProvider: input.isDefault === true ? provider : undefined,
		});

		// Otherwise, save to user-level config
		// Revalidate the pre-read under lock before committing provider writes
		// Existing targets are locked before deriving their default transition.
		const outcome = await db.$transaction(
			async (tx): Promise<UpsertOutcome> => {
				await lockTenantProviderConnections(tx, {
					type: "user",
					id: user.id,
				});
				const currentDefaultProvider =
					await findResolvedDefaultProvider(tx, {
						type: "user",
						id: user.id,
					});
				// Check if this provider already exists for this user
				const existing = await tx.userCloudProviderConfig.findUnique({
					where: {
						userId_provider: {
							userId: user.id,
							provider,
						},
					},
				});

				const notThisRow = existing ? { id: { not: existing.id } } : {};
				const purpose = input.purpose ?? existing?.purpose ?? "ALL";
				const embeddingsOnly = purpose === "EMBEDDINGS_ONLY";
				if (embeddingsOnly) {
					const otherEmbeddingsOnly =
						await tx.userCloudProviderConfig.findFirst({
							where: { userId: user.id, purpose, ...notThisRow },
						});
					assertPurposeAllowed({
						provider,
						purpose,
						requestedDefault: input.isDefault,
						otherEmbeddingsOnlyProvider:
							otherEmbeddingsOnly?.provider ?? null,
					});
				}

				// Determine if this should be default (first provider or explicitly set)
				// Derive the default choice after locking and refreshing the target.
				// Embeddings-only rows never count: they can never be the default.
				const otherEnabledProvider =
					await tx.userCloudProviderConfig.findFirst({
						where: {
							userId: user.id,
							enabled: true,
							...LLM_PROVIDER_PURPOSE_FILTER,
							...notThisRow,
						},
					});
				// Check if there's another provider that IS default (not just enabled)
				const otherDefaultProvider =
					await tx.userCloudProviderConfig.findFirst({
						where: {
							userId: user.id,
							enabled: true,
							isDefault: true,
							...LLM_PROVIDER_PURPOSE_FILTER,
							...notThisRow,
						},
					});
				// Logic:
				// 0. An embeddings-only key is never default
				// 1. If explicitly set to true, use that
				// 2. If no other providers exist, this MUST be default
				// 3. If other providers exist but none are default, this MUST be default
				// 4. Only respect explicit false if there's another default provider
				const shouldBeDefault =
					!embeddingsOnly &&
					(input.isDefault === true ||
						!otherEnabledProvider ||
						!otherDefaultProvider);

				const snapshotMutation = await taskDefaultsSnapshotMutation(
					provider,
					existing
						? { isDefault: currentDefaultProvider === provider }
						: null,
					shouldBeDefault,
					tx,
				);

				let embeddingPin: UpsertOutcome["embeddingPin"] = null;
				// Validate routing and pin before changing the default; upsert keeps saved preferences.
				if (shouldBeDefault) {
					const currentDefault =
						await tx.userCloudProviderConfig.findFirst({
							where: {
								userId: user.id,
								isDefault: true,
								enabled: true,
								...LLM_PROVIDER_PURPOSE_FILTER,
							},
						});
					embeddingPin = (
						await pinDefaultSwitchEmbeddings(tx, {
							organizationId,
							userId: user.id,
							targetProvider: provider,
							prepared: preparedEmbeddings,
							currentDefault,
						})
					).pin;

					await tx.userCloudProviderConfig.updateMany({
						where: { userId: user.id, isDefault: true },
						data: { isDefault: false },
					});
				}
				if (embeddingsOnly) {
					await tx.userModelPreference.deleteMany({
						where: {
							userId: user.id,
							...llmPreferencesPinnedTo(provider),
						},
					});
					// It is the documents provider by definition.
					await tx.userCloudProviderConfig.updateMany({
						where: {
							userId: user.id,
							isEmbeddingProvider: true,
							...notThisRow,
						},
						data: { isEmbeddingProvider: false },
					});
					// Never leave the account without a default it could have.
					if (
						otherEnabledProvider &&
						(!currentDefaultProvider ||
							currentDefaultProvider === provider)
					) {
						await tx.userCloudProviderConfig.update({
							where: { id: otherEnabledProvider.id },
							data: {
								isDefault: true,
								...(await taskDefaultsSnapshotMutation(
									otherEnabledProvider.provider,
									{
										isDefault:
											currentDefaultProvider ===
											otherEnabledProvider.provider,
									},
									true,
									tx,
								)),
							},
						});
					}
				}
				// An embeddings-only key never stands in for a spent ChatGPT plan
				// (Fizzy #3085), so its opt-in does not survive the restriction.
				const purposeFields = {
					purpose,
					...(embeddingsOnly
						? { isEmbeddingProvider: true, useWhenPlanSpent: false }
						: {}),
				};

				if (existing) {
					// Update existing - merge with existing config
					const existingConfig =
						(existing.config as Record<string, unknown>) || {};
					// Store API key in dedicated encrypted column, remove from JSON config
					const newConfig = {
						...existingConfig,
						// Remove apiKey from config (now stored in encryptedApiKey column)
						apiKey: undefined,
						...(input.enabledProviders !== undefined && {
							enabledProviders: input.enabledProviders,
						}),
						...(input.baseUrl !== undefined && {
							baseUrl: input.baseUrl,
						}),
						...(input.deploymentName !== undefined && {
							deploymentName: input.deploymentName,
						}),
					};

					const updated = await tx.userCloudProviderConfig.update({
						where: { id: existing.id },
						data: {
							config: newConfig as any,
							...credentials,
							displayName,
							enabled: true,
							isDefault: shouldBeDefault,
							...snapshotMutation,
							...purposeFields,
							updatedAt: new Date(),
						},
					});

					return {
						result: {
							success: true,
							id: updated.id,
							provider: updated.provider,
							displayName: updated.displayName,
							isDefault: updated.isDefault,
							purpose: updated.purpose,
						},
						before: snapshotProviderRow(existing),
						after: snapshotProviderRow(updated),
						embeddingPin,
					};
				}

				// Create new
				const newConfig = {
					...(input.enabledProviders !== undefined && {
						enabledProviders: input.enabledProviders,
					}),
					...(input.baseUrl !== undefined && {
						baseUrl: input.baseUrl,
					}),
					...(input.deploymentName !== undefined && {
						deploymentName: input.deploymentName,
					}),
				};

				const created = await tx.userCloudProviderConfig.create({
					data: {
						id: `ucpc_${crypto.randomUUID()}`,
						userId: user.id,
						provider,
						...credentials,
						config: newConfig as any,
						displayName,
						enabled: true,
						isDefault: shouldBeDefault,
						...snapshotMutation,
						...purposeFields,
						priority: 1,
						updatedAt: new Date(),
					},
				});

				return {
					result: {
						success: true,
						id: created.id,
						provider: created.provider,
						displayName: created.displayName,
						isDefault: created.isDefault,
						purpose: created.purpose,
					},
					before: null,
					after: snapshotProviderRow(created),
					embeddingPin,
				};
			},
		);
		recordProviderConfigured(context, { kind: "account" }, outcome.result, {
			before: outcome.before,
			after: outcome.after,
			keyChanged,
		});
		recordDefaultSwitchEmbeddingPin(
			context,
			{ kind: "account" },
			outcome.embeddingPin,
		);
		return outcome.result;
	});

export const deleteUserProviderProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_EDIT))
	.route({
		method: "POST",
		path: "/ai-config/providers/delete",
		tags: ["AI Config"],
		summary: "Delete AI provider configuration",
		description:
			"Remove an AI provider configuration for the current user or organization",
	})
	.input(
		z.object({
			provider: z.string(),
			organizationId: z.string().nullable().optional(), // If provided, deletes from org-level config
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
		}),
	)
	.handler(async ({ context, input }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);
		const provider = input.provider as AIProvider;

		if (organizationId) {
			// Verify user is an admin or owner of the organization
			const membership = await requireOrgMembership(
				user.id,
				organizationId,
				["owner", "admin"],
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Only organization admins can delete AI provider configurations",
				});
			}

			// Use transaction to ensure atomicity of delete + potential default reassignment
			const deleted = await db.$transaction(async (tx) => {
				await lockTenantProviderConnections(tx, {
					type: "organization",
					id: organizationId,
				});
				const currentDefaultProvider =
					await findResolvedDefaultProvider(tx, {
						type: "organization",
						id: organizationId,
					});
				const existing = await tx.cloudProviderConfig.findFirst({
					where: { organizationId, provider },
				});
				// Preserve an explicit off switch before removing the selected provider.
				await disableOrgDecisionPreferenceForProvider(
					tx,
					organizationId,
					provider,
				);
				// Delete from organization-level config
				await tx.cloudProviderConfig.deleteMany({
					where: { organizationId, provider },
				});
				await tx.organizationModelPreference.deleteMany({
					where: { organizationId, provider },
				});
				// API-only organization deletion may change the embedding identity when
				// the default/documents key is removed. This reassignment has no embeddings
				// impact confirmation; organization settings offers no delete action.
				let defaultReassignedTo: string | null = null;

				// After deletion, check if ANY default provider exists
				// This is more robust than checking the deleted row's state (which could be stale)
				const defaultRow = await tx.cloudProviderConfig.findFirst({
					where: organizationDefaultProviderWhere(organizationId),
				});
				const existingDefault =
					defaultRow &&
					readProviderRowCredentials(defaultRow).hasCredentials
						? defaultRow
						: null;

				// Capture a survivor that becomes the resolved default, including a stale flagged row.
				if (
					!existingDefault ||
					existingDefault.provider !== currentDefaultProvider
				) {
					const anotherProvider =
						existingDefault ??
						(await findUsableOrganizationProvider(
							tx,
							organizationId,
						));
					if (anotherProvider) {
						await promoteOrganizationProvider(
							tx,
							organizationId,
							anotherProvider.id,
							currentDefaultProvider,
						);
						defaultReassignedTo = anotherProvider.provider;
						console.log(
							`[AI Config] Set ${anotherProvider.provider} as new default after deleting ${provider}`,
						);
					}
				}
				return existing && { existing, defaultReassignedTo };
			});
			if (deleted) {
				recordProviderDeleted(
					context,
					{ kind: "org", organizationId },
					deleted.existing,
					{
						before: snapshotProviderRow(deleted.existing),
						defaultReassignedTo: deleted.defaultReassignedTo,
					},
				);
			}
		} else {
			// Use transaction to ensure atomicity of delete + potential default reassignment
			const deleted = await db.$transaction(async (tx) => {
				await lockTenantProviderConnections(tx, {
					type: "user",
					id: user.id,
				});
				const currentDefaultProvider =
					await findResolvedDefaultProvider(tx, {
						type: "user",
						id: user.id,
					});
				const existing = await tx.userCloudProviderConfig.findFirst({
					where: { userId: user.id, provider },
				});
				// Delete from user-level config
				await tx.userCloudProviderConfig.deleteMany({
					where: { userId: user.id, provider },
				});
				await tx.userModelPreference.deleteMany({
					where: { userId: user.id, provider },
				});
				let defaultReassignedTo: string | null = null;

				// After deletion, check if ANY default provider exists
				// This is more robust than checking the deleted row's state (which could be stale)
				const defaultRow = await tx.userCloudProviderConfig.findFirst({
					where: {
						userId: user.id,
						enabled: true,
						isDefault: true,
						...LLM_PROVIDER_PURPOSE_FILTER,
					},
				});
				const existingDefault =
					defaultRow &&
					readProviderRowCredentials(defaultRow).hasCredentials
						? defaultRow
						: null;

				// Capture a survivor that becomes the resolved default, including a stale flagged row.
				if (
					!existingDefault ||
					existingDefault.provider !== currentDefaultProvider
				) {
					const anotherProvider =
						existingDefault ??
						(await tx.userCloudProviderConfig.findFirst({
							where: {
								userId: user.id,
								enabled: true,
								...LLM_PROVIDER_PURPOSE_FILTER,
							},
						}));
					if (anotherProvider) {
						await tx.userCloudProviderConfig.update({
							where: { id: anotherProvider.id },
							data: {
								isDefault: true,
								...(await taskDefaultsSnapshotMutation(
									anotherProvider.provider,
									{
										isDefault:
											currentDefaultProvider ===
											anotherProvider.provider,
									},
									true,
									tx,
								)),
							},
						});
						defaultReassignedTo = anotherProvider.provider;
						console.log(
							`[AI Config] Set ${anotherProvider.provider} as new default after deleting ${provider}`,
						);
					}
				}
				return existing && { existing, defaultReassignedTo };
			});
			if (deleted) {
				recordProviderDeleted(
					context,
					{ kind: "account" },
					deleted.existing,
					{
						before: snapshotProviderRow(deleted.existing),
						defaultReassignedTo: deleted.defaultReassignedTo,
					},
				);
			}
		}

		return { success: true };
	});

export const previewSetDefaultProviderProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_EDIT))
	.route({
		method: "GET",
		path: "/ai-config/providers/preview-set-default",
		tags: ["AI Config"],
		summary: "Preview an organization default provider switch",
	})
	.input(
		z.object({
			organizationId: z.string(),
			provider: z.string().optional(),
		}),
	)
	.output(defaultProviderSwitchPreviewSchema)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Organization ID is required",
			});
		}
		const membership = await requireOrgMembership(
			context.user.id,
			organizationId,
			["owner", "admin"],
		);
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "Only organization admins can set default AI provider",
			});
		}
		return await previewDefaultProviderSwitch({
			organizationId,
			userId: context.user.id,
			targetProvider: input.provider,
		});
	});

export const setDefaultProviderProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_EDIT))
	.route({
		method: "POST",
		path: "/ai-config/providers/set-default",
		tags: ["AI Config"],
		summary: "Set default AI provider",
		description:
			"Set an AI provider as the default for the current user or organization. Clears model preferences when switching providers.",
	})
	.input(
		z.object({
			provider: z.string(),
			organizationId: z.string().nullable().optional(), // If provided, sets default for org
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			preferencesCleared: z.number(),
		}),
	)
	.handler(async ({ context, input }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);
		const provider = input.provider as AIProvider;
		let preferencesCleared = 0;

		if (organizationId) {
			// Verify user is an admin or owner of the organization
			const membership = await requireOrgMembership(
				user.id,
				organizationId,
				["owner", "admin"],
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Only organization admins can set default AI provider",
				});
			}

			await planDefaultProviderSwitch({
				organizationId,
				userId: user.id,
				targetProvider: provider,
			});
			const preparedEmbeddings = await prepareDefaultSwitchEmbeddings({
				organizationId,
				userId: user.id,
				targetProvider: provider,
			});
			// Get current default provider to check if it's changing
			const { currentDefault, target, embeddingPin } =
				await db.$transaction(async (tx) => {
					await lockTenantProviderConnections(tx, {
						type: "organization",
						id: organizationId,
					});
					const target = await tx.cloudProviderConfig.findFirst({
						where: { organizationId, provider },
					});
					const currentDefault =
						await tx.cloudProviderConfig.findFirst({
							where: organizationDefaultProviderWhere(
								organizationId,
							),
						});
					if (target?.purpose === "EMBEDDINGS_ONLY") {
						throw new ORPCError("BAD_REQUEST", {
							message: EMBEDDINGS_ONLY_DEFAULT_MESSAGE,
						});
					}

					if (
						!target ||
						!target.enabled ||
						!readProviderRowCredentials(target).hasCredentials
					) {
						throw new ORPCError("BAD_REQUEST", {
							message:
								"Choose an enabled API provider with usable credentials that allows language model work.",
						});
					}

					const currentProvider =
						currentDefault &&
						readProviderRowCredentials(currentDefault)
							.hasCredentials
							? currentDefault.provider
							: null;
					const snapshotMutation = await taskDefaultsSnapshotMutation(
						provider,
						{ isDefault: currentProvider === provider },
						true,
						tx,
					);
					const embedding = await pinDefaultSwitchEmbeddings(tx, {
						organizationId,
						userId: user.id,
						targetProvider: provider,
						prepared: preparedEmbeddings,
						currentDefault,
					});
					const plan = defaultProviderSwitchRules({
						organizationId,
						currentProvider,
						targetProvider: provider,
						documentsProvider: embedding.documentsProvider,
					});

					if (plan.deleteWhere) {
						const result =
							await tx.organizationModelPreference.deleteMany({
								where: plan.deleteWhere,
							});
						preferencesCleared = result.count;
					}

					// Clear preferences, flip the default and capture in this transaction.
					await tx.cloudProviderConfig.updateMany({
						where: { organizationId, isDefault: true },
						data: { isDefault: false },
					});
					await tx.cloudProviderConfig.updateMany({
						where: { organizationId, provider },
						data: {
							isDefault: true,
							...snapshotMutation,
						},
					});
					return {
						currentDefault,
						target,
						embeddingPin: embedding.pin,
					};
				});
			recordDefaultSwitchEmbeddingPin(
				context,
				{ kind: "org", organizationId },
				embeddingPin,
			);
			recordProviderSettingChanged(
				context,
				{ kind: "org", organizationId },
				"default_changed",
				{ id: target?.id ?? provider, provider },
				{
					before: { isDefault: target?.isDefault ?? false },
					after: { isDefault: true },
					details: {
						previousDefaultProvider:
							currentDefault?.provider ?? null,
						preferencesCleared,
					},
				},
			);
		} else {
			const preparedEmbeddings = await prepareDefaultSwitchEmbeddings({
				organizationId,
				userId: user.id,
				targetProvider: provider,
			});
			// Get current default provider to check if it's changing
			const { currentDefault, target, embeddingPin } =
				await db.$transaction(async (tx) => {
					await lockTenantProviderConnections(tx, {
						type: "user",
						id: user.id,
					});
					const target = await tx.userCloudProviderConfig.findFirst({
						where: { userId: user.id, provider },
					});
					const currentDefault =
						await tx.userCloudProviderConfig.findFirst({
							where: {
								userId: user.id,
								isDefault: true,
								enabled: true,
								...LLM_PROVIDER_PURPOSE_FILTER,
							},
						});
					if (target?.purpose === "EMBEDDINGS_ONLY") {
						throw new ORPCError("BAD_REQUEST", {
							message: EMBEDDINGS_ONLY_DEFAULT_MESSAGE,
						});
					}

					const currentProvider =
						currentDefault &&
						readProviderRowCredentials(currentDefault)
							.hasCredentials
							? currentDefault.provider
							: null;
					const changing = currentProvider !== provider;
					const snapshotMutation = target
						? await taskDefaultsSnapshotMutation(
								provider,
								{ isDefault: !changing },
								true,
								tx,
							)
						: {};

					const embedding = await pinDefaultSwitchEmbeddings(tx, {
						organizationId,
						userId: user.id,
						targetProvider: provider,
						prepared: preparedEmbeddings,
						currentDefault,
					});

					// Only clear preferences when another flagged default is being
					// replaced, as before this snapshot change. With no current
					// default, saved choices are kept; the snapshot above still
					// captures because this becomes the resolved default.
					if (
						currentDefault &&
						currentDefault.provider !== provider
					) {
						// Clear user model preferences when provider changes
						// This ensures users don't have models selected that aren't available.
						//
						// Exception (see org branch): preserve the embeddings model when a
						// configured "Use for Documents" provider (isEmbeddingProvider) governs
						// it, so switching the default provider doesn't re-point embeddings
						// and invalidate already indexed vectors.

						const preserveEmbedding = !!embedding.documentsProvider;

						const deleteResult =
							await tx.userModelPreference.deleteMany({
								where: {
									userId: user.id,
									...(preserveEmbedding
										? {
												taskType: {
													not: "EMBEDDING" as AiTaskType,
												},
											}
										: {}),
								},
							});
						preferencesCleared = deleteResult.count;
						console.log(
							`[AI Config] Cleared ${preferencesCleared} user model preferences (provider changed from ${currentProvider ?? "none"} to ${provider}${
								preserveEmbedding
									? `, embeddings preserved for documents provider ${embedding.documentsProvider}`
									: ""
							})`,
						);
					}

					// Clear preferences, flip the default and capture in this transaction.
					await tx.userCloudProviderConfig.updateMany({
						where: { userId: user.id, isDefault: true },
						data: { isDefault: false },
					});
					await tx.userCloudProviderConfig.updateMany({
						where: { userId: user.id, provider },
						data: {
							isDefault: true,
							...snapshotMutation,
						},
					});
					return {
						currentDefault,
						target,
						embeddingPin: embedding.pin,
					};
				});
			recordDefaultSwitchEmbeddingPin(
				context,
				{ kind: "account" },
				embeddingPin,
			);
			recordProviderSettingChanged(
				context,
				{ kind: "account" },
				"default_changed",
				{ id: target?.id ?? provider, provider },
				{
					before: { isDefault: target?.isDefault ?? false },
					after: { isDefault: true },
					details: {
						previousDefaultProvider:
							currentDefault?.provider ?? null,
						preferencesCleared,
					},
				},
			);
		}

		return { success: true, preferencesCleared };
	});

export const updateEnabledProvidersProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_EDIT))
	.route({
		method: "POST",
		path: "/ai-config/providers/update-enabled",
		tags: ["AI Config"],
		summary: "Update enabled providers for a gateway",
		description: "Update which sub-providers are enabled for an AI gateway",
	})
	.input(
		z.object({
			provider: z.string(),
			enabledProviders: z.array(z.string()),
			organizationId: z.string().nullable().optional(), // If provided, updates org-level config
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			enabledProviders: z.array(z.string()),
		}),
	)
	.handler(async ({ context, input }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);
		const provider = input.provider as AIProvider;

		if (organizationId) {
			// Verify user is an admin or owner of the organization
			const membership = await requireOrgMembership(
				user.id,
				organizationId,
				["owner", "admin"],
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Only organization admins can update AI provider settings",
				});
			}

			// Update organization-level config
			const existing = await db.cloudProviderConfig.findUnique({
				where: {
					organizationId_provider: {
						organizationId,
						provider,
					},
				},
			});

			if (!existing) {
				throw new Error(
					`Provider ${provider} is not configured for this organization`,
				);
			}

			const existingConfig =
				(existing.config as Record<string, unknown>) || {};
			const newConfig = {
				...existingConfig,
				enabledProviders: input.enabledProviders,
			};

			await db.cloudProviderConfig.update({
				where: { id: existing.id },
				data: {
					config: newConfig as any,
					updatedAt: new Date(),
				},
			});
			recordProviderSettingChanged(
				context,
				{ kind: "org", organizationId },
				"enabled_providers_changed",
				existing,
				{
					before: {
						enabledProviders:
							snapshotProviderRow(existing).enabledProviders,
					},
					after: { enabledProviders: input.enabledProviders },
				},
			);
		} else {
			// Update user-level config
			const existing = await db.userCloudProviderConfig.findUnique({
				where: {
					userId_provider: {
						userId: user.id,
						provider,
					},
				},
			});

			if (!existing) {
				throw new Error(`Provider ${provider} is not configured`);
			}

			const existingConfig =
				(existing.config as Record<string, unknown>) || {};
			const newConfig = {
				...existingConfig,
				enabledProviders: input.enabledProviders,
			};

			await db.userCloudProviderConfig.update({
				where: { id: existing.id },
				data: {
					config: newConfig as any,
					updatedAt: new Date(),
				},
			});
			recordProviderSettingChanged(
				context,
				{ kind: "account" },
				"enabled_providers_changed",
				existing,
				{
					before: {
						enabledProviders:
							snapshotProviderRow(existing).enabledProviders,
					},
					after: { enabledProviders: input.enabledProviders },
				},
			);
		}

		return {
			success: true,
			enabledProviders: input.enabledProviders,
		};
	});

export const setEmbeddingProviderProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_EDIT))
	.route({
		method: "POST",
		path: "/ai-config/providers/set-embedding",
		tags: ["AI Config"],
		summary: "Set embedding provider",
		description:
			"Set an AI provider as the dedicated embedding provider. This provider will be used for all embedding operations regardless of the default provider setting. Pass `purpose` to also restrict it to embeddings only, or to lift that restriction.",
	})
	.input(
		z.object({
			provider: z.string(),
			// Omitted keeps the row's current purpose.
			purpose: AiProviderPurposeSchema.optional(),
			organizationId: z.string().nullable().optional(), // If provided, sets for org
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
		}),
	)
	.handler(async ({ context, input }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);
		const provider = input.provider as AIProvider;

		// Validate that the provider supports embeddings
		if (!canProviderSupportEmbeddings(provider)) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Provider ${provider} does not support embeddings. Only the following providers support embeddings: ${ALL_EMBEDDING_CAPABLE_PROVIDERS.join(", ")}`,
			});
		}
		await assertEmbeddingPreferenceFitsVectorStore({
			organizationId,
			userId: user.id,
			provider,
		});

		if (organizationId) {
			// Verify user is an admin or owner of the organization
			const membership = await requireOrgMembership(
				user.id,
				organizationId,
				["owner", "admin"],
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Only organization admins can set embedding provider",
				});
			}

			const embeddingsOnly = input.purpose === "EMBEDDINGS_ONLY";
			const { defaultReassignedTo, previous, target } =
				await db.$transaction(async (tx) => {
					await lockTenantProviderConnections(tx, {
						type: "organization",
						id: organizationId,
					});
					const currentDefaultProvider =
						await findResolvedDefaultProvider(tx, {
							type: "organization",
							id: organizationId,
						});
					const previous = await tx.cloudProviderConfig.findFirst({
						where: { organizationId, isEmbeddingProvider: true },
					});
					assertEmbeddingFlagCanMove(previous, provider);
					const target = await tx.cloudProviderConfig.findFirst({
						where: { organizationId, provider },
					});
					await tx.cloudProviderConfig.updateMany({
						where: { organizationId, isEmbeddingProvider: true },
						data: { isEmbeddingProvider: false },
					});
					await tx.cloudProviderConfig.updateMany({
						where: { organizationId, provider },
						data: {
							isEmbeddingProvider: true,
							...(input.purpose
								? { purpose: input.purpose }
								: {}),
							...(embeddingsOnly ? { isDefault: false } : {}),
						},
					});
					if (embeddingsOnly) {
						await disableOrgDecisionPreferenceForProvider(
							tx,
							organizationId,
							provider,
						);
						await tx.organizationModelPreference.deleteMany({
							where: {
								organizationId,
								...llmPreferencesPinnedTo(provider),
							},
						});
					}
					if (!(embeddingsOnly && target?.isDefault)) {
						return { defaultReassignedTo: null, previous, target };
					}
					// The default just became embeddings-only: hand the role to a
					// key that may serve LLM work, if the organization has one.
					const replacement = await findUsableOrganizationProvider(
						tx,
						organizationId,
						{ provider: { not: provider } },
					);
					if (!replacement) {
						return { defaultReassignedTo: null, previous, target };
					}
					await promoteOrganizationProvider(
						tx,
						organizationId,
						replacement.id,
						currentDefaultProvider,
					);
					return {
						defaultReassignedTo: replacement.provider,
						previous,
						target,
					};
				});
			recordProviderSettingChanged(
				context,
				{ kind: "org", organizationId },
				"embedding_changed",
				{ id: target?.id ?? provider, provider },
				embeddingChangeAudit(target, previous, {
					purpose: input.purpose,
					defaultReassignedTo,
				}),
			);
		} else {
			const embeddingsOnly = input.purpose === "EMBEDDINGS_ONLY";
			const { defaultReassignedTo, previous, target } =
				await db.$transaction(async (tx) => {
					await lockTenantProviderConnections(tx, {
						type: "user",
						id: user.id,
					});
					const currentDefaultProvider =
						await findResolvedDefaultProvider(tx, {
							type: "user",
							id: user.id,
						});
					const previous = await tx.userCloudProviderConfig.findFirst(
						{
							where: {
								userId: user.id,
								isEmbeddingProvider: true,
							},
						},
					);
					assertEmbeddingFlagCanMove(previous, provider);
					const target = await tx.userCloudProviderConfig.findFirst({
						where: { userId: user.id, provider },
					});
					await tx.userCloudProviderConfig.updateMany({
						where: { userId: user.id, isEmbeddingProvider: true },
						data: { isEmbeddingProvider: false },
					});
					await tx.userCloudProviderConfig.updateMany({
						where: { userId: user.id, provider },
						data: {
							isEmbeddingProvider: true,
							...(input.purpose
								? { purpose: input.purpose }
								: {}),
							// Never the default, nor the key for a spent plan.
							...(embeddingsOnly
								? { isDefault: false, useWhenPlanSpent: false }
								: {}),
						},
					});
					if (embeddingsOnly) {
						await tx.userModelPreference.deleteMany({
							where: {
								userId: user.id,
								...llmPreferencesPinnedTo(provider),
							},
						});
					}
					if (!(embeddingsOnly && target?.isDefault)) {
						return { defaultReassignedTo: null, previous, target };
					}
					// See the organization branch.
					const replacement =
						await tx.userCloudProviderConfig.findFirst({
							where: {
								userId: user.id,
								enabled: true,
								provider: { not: provider },
								...LLM_PROVIDER_PURPOSE_FILTER,
							},
						});
					if (!replacement) {
						return { defaultReassignedTo: null, previous, target };
					}
					await tx.userCloudProviderConfig.update({
						where: { id: replacement.id },
						data: {
							isDefault: true,
							...(await taskDefaultsSnapshotMutation(
								replacement.provider,
								{
									isDefault:
										currentDefaultProvider ===
										replacement.provider,
								},
								true,
								tx,
							)),
						},
					});
					return {
						defaultReassignedTo: replacement.provider,
						previous,
						target,
					};
				});
			recordProviderSettingChanged(
				context,
				{ kind: "account" },
				"embedding_changed",
				{ id: target?.id ?? provider, provider },
				embeddingChangeAudit(target, previous, {
					purpose: input.purpose,
					defaultReassignedTo,
				}),
			);
		}

		console.log(
			`[AI Config] Set ${provider} as embedding provider for ${organizationId ? `org ${organizationId}` : `user ${user.id}`}`,
		);

		return { success: true };
	});

export const getProviderConfigProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ORG_AI_CONFIG_READ))
	.route({
		method: "GET",
		path: "/ai-config/providers/get-config",
		tags: ["AI Config"],
		summary: "Get provider configuration",
		description: "Get the configuration for a specific AI provider",
	})
	.input(
		z.object({
			provider: z.string(),
			organizationId: z.string().nullable().optional(), // If provided, gets org-level config
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			provider: z.string().nullable(),
			displayName: z.string().nullable(),
			isDefault: z.boolean(),
			isEmbeddingProvider: z.boolean(),
			purpose: AiProviderPurposeSchema,
			enabled: z.boolean(),
			enabledProviders: z.array(z.string()),
			hasApiKey: z.boolean(),
			// Auth mode indicators. The encrypted secret itself is NEVER
			// returned — only whether one is stored, plus the non-secret
			// client id so the form can prefill it.
			hasServicePrincipal: z.boolean(),
			clientId: z.string().nullable(),
			baseUrl: z.string().nullable(), // Custom base URL for gateways
			deploymentName: z.string().nullable(), // For Azure AI Foundry - the deployment name
		}),
	)
	.handler(async ({ context: { user, session }, input }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);
		const provider = input.provider as AIProvider;

		let config: {
			provider: string;
			displayName: string | null;
			isDefault: boolean;
			isEmbeddingProvider: boolean;
			purpose: AiProviderPurpose;
			enabled: boolean;
			encryptedApiKey: string | null;
			clientId: string | null;
			encryptedClientSecret: string | null;
			config: unknown;
		} | null = null;

		if (organizationId) {
			// Get organization-level config
			config = await db.cloudProviderConfig.findUnique({
				where: {
					organizationId_provider: {
						organizationId,
						provider,
					},
				},
			});
		} else {
			// Get user-level config
			config = await db.userCloudProviderConfig.findUnique({
				where: {
					userId_provider: {
						userId: user.id,
						provider,
					},
				},
			});
		}

		if (!config) {
			return {
				success: false,
				provider: null,
				displayName: null,
				isDefault: false,
				isEmbeddingProvider: false,
				purpose: "ALL" as const,
				enabled: false,
				enabledProviders: [],
				hasApiKey: false,
				hasServicePrincipal: false,
				clientId: null,
				baseUrl: null,
				deploymentName: null,
			};
		}

		const configData = (config.config as Record<string, unknown>) || {};
		const enabledProviders =
			(configData.enabledProviders as string[]) || [];
		// Check both new encryptedApiKey column and legacy config.apiKey for backward compatibility
		const hasApiKey = !!(config.encryptedApiKey || configData.apiKey);
		const hasServicePrincipal = !!(
			config.clientId && config.encryptedClientSecret
		);
		const baseUrl = (configData.baseUrl as string) || null;
		const deploymentName = (configData.deploymentName as string) || null;

		return {
			success: true,
			provider: config.provider,
			displayName: config.displayName,
			isDefault: config.isDefault,
			isEmbeddingProvider: config.isEmbeddingProvider,
			purpose: config.purpose,
			enabled: config.enabled,
			enabledProviders,
			hasApiKey,
			hasServicePrincipal,
			// Client id is not a secret (it is an application id); the secret
			// stays server-side and is never returned.
			clientId: config.clientId,
			baseUrl,
			deploymentName,
		};
	});
