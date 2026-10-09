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
	getEmbeddingProviderConfig,
	getProviderDisplayName,
	getProviderMetadata,
	LLM_PROVIDER_PURPOSE_FILTER,
} from "@repo/database";
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
import { assertEmbeddingPreferenceFitsVectorStore } from "../../lib/embedding-model-guard";
import {
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

const EMBEDDINGS_ONLY_DEFAULT_MESSAGE =
	"An embeddings-only key cannot be the default AI provider. Change its purpose to allow all AI work first.";

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
}

/**
 * Upsert organization-level provider configuration
 * Saves to cloud_provider_config table for organization-wide access
 */
interface OrganizationProviderUpsert {
	organizationId: string;
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
	provider,
	displayName,
	credentials,
	isDefault,
	purpose: requestedPurpose,
	enabledProviders,
	baseUrl,
	deploymentName,
}: OrganizationProviderUpsert): Promise<UpsertOutcome> {
	// Use transaction to ensure atomicity of all reads and writes
	// This prevents race conditions that could leave no default or multiple defaults
	return await db.$transaction(async (tx) => {
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
		// All reads must be inside transaction to prevent race conditions.
		// Embeddings-only rows never count: they can never be the default.
		const otherEnabledProvider = await tx.cloudProviderConfig.findFirst({
			where: {
				organizationId,
				enabled: true,
				...LLM_PROVIDER_PURPOSE_FILTER,
				...notThisRow,
			},
		});
		// Check if there's another provider that IS default (not just enabled)
		const otherDefaultProvider = await tx.cloudProviderConfig.findFirst({
			where: {
				organizationId,
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
			(isDefault === true ||
				!otherEnabledProvider ||
				!otherDefaultProvider);

		// Clear existing defaults if this provider will become default
		if (shouldBeDefault) {
			await tx.cloudProviderConfig.updateMany({
				where: { organizationId, isDefault: true },
				data: { isDefault: false },
			});
		}
		if (embeddingsOnly) {
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
			if (!otherDefaultProvider && otherEnabledProvider) {
				await tx.cloudProviderConfig.update({
					where: { id: otherEnabledProvider.id },
					data: { isDefault: true },
				});
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

		// SSRF guard at the persistence boundary. A stored Databricks base URL is
		// not merely a request target: for a service principal the server POSTs
		// the CLIENT SECRET to `<origin>/oidc/v1/token` during model resolution,
		// so a config naming an internal host (link-local metadata, an intranet
		// service) would exfiltrate the secret and expose the response status.
		// `testConnection` already applies these rules — and the UI requires a
		// passing test before Save — so this only closes the direct-oRPC bypass;
		// any host reachable through the normal flow stays reachable. Applied to
		// BOTH auth modes, since a PAT is a bearer credential on the same path.
		if (provider === "DATABRICKS" && input.baseUrl?.trim()) {
			const urlValidation = validateProviderUrl(
				input.baseUrl.trim(),
				provider,
			);
			if (!urlValidation.valid) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Invalid Databricks workspace URL: ${
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
			return outcome.result;
		}

		// Otherwise, save to user-level config
		// Use transaction to ensure atomicity of all reads and writes
		// This prevents race conditions that could leave no default or multiple defaults
		const outcome = await db.$transaction(
			async (tx): Promise<UpsertOutcome> => {
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
				// All reads must be inside transaction to prevent race conditions.
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

				// Clear existing defaults if this provider will become default
				if (shouldBeDefault) {
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
					if (!otherDefaultProvider && otherEnabledProvider) {
						await tx.userCloudProviderConfig.update({
							where: { id: otherEnabledProvider.id },
							data: { isDefault: true },
						});
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
				};
			},
		);
		recordProviderConfigured(context, { kind: "account" }, outcome.result, {
			before: outcome.before,
			after: outcome.after,
			keyChanged,
		});
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
				const existing = await tx.cloudProviderConfig.findFirst({
					where: { organizationId, provider },
				});
				// Delete from organization-level config
				await tx.cloudProviderConfig.deleteMany({
					where: { organizationId, provider },
				});
				await tx.organizationModelPreference.deleteMany({
					where: { organizationId, provider },
				});
				let defaultReassignedTo: string | null = null;

				// After deletion, check if ANY default provider exists
				// This is more robust than checking the deleted row's state (which could be stale)
				const existingDefault = await tx.cloudProviderConfig.findFirst({
					where: { organizationId, enabled: true, isDefault: true },
				});

				// If no default exists, set one
				if (!existingDefault) {
					const anotherProvider =
						await tx.cloudProviderConfig.findFirst({
							where: {
								organizationId,
								enabled: true,
								...LLM_PROVIDER_PURPOSE_FILTER,
							},
						});
					if (anotherProvider) {
						await tx.cloudProviderConfig.update({
							where: { id: anotherProvider.id },
							data: { isDefault: true },
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
				const existingDefault =
					await tx.userCloudProviderConfig.findFirst({
						where: {
							userId: user.id,
							enabled: true,
							isDefault: true,
						},
					});

				// If no default exists, set one
				if (!existingDefault) {
					const anotherProvider =
						await tx.userCloudProviderConfig.findFirst({
							where: {
								userId: user.id,
								enabled: true,
								...LLM_PROVIDER_PURPOSE_FILTER,
							},
						});
					if (anotherProvider) {
						await tx.userCloudProviderConfig.update({
							where: { id: anotherProvider.id },
							data: { isDefault: true },
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

			// Get current default provider to check if it's changing
			const currentDefault = await db.cloudProviderConfig.findFirst({
				where: { organizationId, isDefault: true },
			});
			const target = await db.cloudProviderConfig.findFirst({
				where: { organizationId, provider },
			});
			if (target?.purpose === "EMBEDDINGS_ONLY") {
				throw new ORPCError("BAD_REQUEST", {
					message: EMBEDDINGS_ONLY_DEFAULT_MESSAGE,
				});
			}

			// Only clear preferences if provider is actually changing
			if (currentDefault && currentDefault.provider !== provider) {
				// Clear organization model preferences when provider changes
				// This ensures users don't have models selected that aren't available.
				//
				// Exception: the embeddings model is pinned to the dedicated
				// "Use for Documents" provider (isEmbeddingProvider), independent of
				// the default AI provider — re-pointing it would invalidate already
				// indexed vectors. So when a distinct documents provider governs
				// embeddings, preserve the EMBEDDING preference. When none is
				// configured (or it IS the new default), embeddings fall back to /
				// recompute from the default provider as before.
				//
				// Exception: DECISION is always pinned to the organization's
				// Vercel AI Gateway, never to the default provider, so a new
				// default cannot make its choice unavailable. It is also the
				// one task whose preference row can mean "switched off"
				// (modelId NULL); clearing that row would silently re-enable
				// the seeded decision model. IMAGE and every other task type
				// are always cleared.
				const embeddingProvider = await getEmbeddingProviderConfig({
					userId: user.id,
					organizationId,
				});
				const preserveEmbedding =
					!!embeddingProvider.provider &&
					embeddingProvider.provider !== provider;
				const preservedTaskTypes: AiTaskType[] = preserveEmbedding
					? ["DECISION", "EMBEDDING"]
					: ["DECISION"];

				const deleteResult =
					await db.organizationModelPreference.deleteMany({
						where: {
							organizationId,
							taskType: { notIn: preservedTaskTypes },
							// The ChatGPT plan's model choices are not tied to
							// the API default provider.
							provider: { not: "OPENAI_CHATGPT_PLAN" },
						},
					});
				preferencesCleared = deleteResult.count;
				console.log(
					`[AI Config] Cleared ${preferencesCleared} org model preferences (provider changed from ${currentDefault.provider} to ${provider}${
						preserveEmbedding
							? `, embeddings preserved for documents provider ${embeddingProvider.provider}`
							: ""
					})`,
				);
			}

			// Use transaction to ensure atomicity of clearing + setting default
			await db.$transaction(async (tx) => {
				await tx.cloudProviderConfig.updateMany({
					where: { organizationId, isDefault: true },
					data: { isDefault: false },
				});
				await tx.cloudProviderConfig.updateMany({
					where: { organizationId, provider },
					data: { isDefault: true },
				});
			});
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
			// Get current default provider to check if it's changing
			const currentDefault = await db.userCloudProviderConfig.findFirst({
				where: { userId: user.id, isDefault: true },
			});
			const target = await db.userCloudProviderConfig.findFirst({
				where: { userId: user.id, provider },
			});
			if (target?.purpose === "EMBEDDINGS_ONLY") {
				throw new ORPCError("BAD_REQUEST", {
					message: EMBEDDINGS_ONLY_DEFAULT_MESSAGE,
				});
			}

			// Only clear preferences if provider is actually changing
			if (currentDefault && currentDefault.provider !== provider) {
				// Clear user model preferences when provider changes
				// This ensures users don't have models selected that aren't available.
				//
				// Exception (see org branch): preserve the embeddings model when a
				// distinct "Use for Documents" provider (isEmbeddingProvider) governs
				// it, so switching the default provider doesn't re-point embeddings
				// and invalidate already indexed vectors.
				const embeddingProvider = await getEmbeddingProviderConfig({
					userId: user.id,
					organizationId,
				});
				const preserveEmbedding =
					!!embeddingProvider.provider &&
					embeddingProvider.provider !== provider;

				const deleteResult = await db.userModelPreference.deleteMany({
					where: {
						userId: user.id,
						...(preserveEmbedding
							? { taskType: { not: "EMBEDDING" as AiTaskType } }
							: {}),
					},
				});
				preferencesCleared = deleteResult.count;
				console.log(
					`[AI Config] Cleared ${preferencesCleared} user model preferences (provider changed from ${currentDefault.provider} to ${provider}${
						preserveEmbedding
							? `, embeddings preserved for documents provider ${embeddingProvider.provider}`
							: ""
					})`,
				);
			}

			// Use transaction to ensure atomicity of clearing + setting default
			await db.$transaction(async (tx) => {
				await tx.userCloudProviderConfig.updateMany({
					where: { userId: user.id, isDefault: true },
					data: { isDefault: false },
				});
				await tx.userCloudProviderConfig.updateMany({
					where: { userId: user.id, provider },
					data: { isDefault: true },
				});
			});
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

			const previous = await db.cloudProviderConfig.findFirst({
				where: { organizationId, isEmbeddingProvider: true },
			});
			assertEmbeddingFlagCanMove(previous, provider);
			const target = await db.cloudProviderConfig.findFirst({
				where: { organizationId, provider },
			});
			const embeddingsOnly = input.purpose === "EMBEDDINGS_ONLY";
			// Use transaction to ensure atomicity of clearing + setting embedding provider
			const defaultReassignedTo = await db.$transaction(async (tx) => {
				await tx.cloudProviderConfig.updateMany({
					where: { organizationId, isEmbeddingProvider: true },
					data: { isEmbeddingProvider: false },
				});
				await tx.cloudProviderConfig.updateMany({
					where: { organizationId, provider },
					data: {
						isEmbeddingProvider: true,
						...(input.purpose ? { purpose: input.purpose } : {}),
						...(embeddingsOnly ? { isDefault: false } : {}),
					},
				});
				if (embeddingsOnly) {
					await tx.organizationModelPreference.deleteMany({
						where: {
							organizationId,
							...llmPreferencesPinnedTo(provider),
						},
					});
				}
				if (!(embeddingsOnly && target?.isDefault)) {
					return null;
				}
				// The default just became embeddings-only: hand the role to a
				// key that may serve LLM work, if the organization has one.
				const replacement = await tx.cloudProviderConfig.findFirst({
					where: {
						organizationId,
						enabled: true,
						provider: { not: provider },
						...LLM_PROVIDER_PURPOSE_FILTER,
					},
				});
				if (!replacement) {
					return null;
				}
				await tx.cloudProviderConfig.update({
					where: { id: replacement.id },
					data: { isDefault: true },
				});
				return replacement.provider;
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
			const previous = await db.userCloudProviderConfig.findFirst({
				where: { userId: user.id, isEmbeddingProvider: true },
			});
			assertEmbeddingFlagCanMove(previous, provider);
			const target = await db.userCloudProviderConfig.findFirst({
				where: { userId: user.id, provider },
			});
			const embeddingsOnly = input.purpose === "EMBEDDINGS_ONLY";
			// Use transaction to ensure atomicity of clearing + setting embedding provider
			const defaultReassignedTo = await db.$transaction(async (tx) => {
				await tx.userCloudProviderConfig.updateMany({
					where: { userId: user.id, isEmbeddingProvider: true },
					data: { isEmbeddingProvider: false },
				});
				await tx.userCloudProviderConfig.updateMany({
					where: { userId: user.id, provider },
					data: {
						isEmbeddingProvider: true,
						...(input.purpose ? { purpose: input.purpose } : {}),
						...(embeddingsOnly ? { isDefault: false } : {}),
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
					return null;
				}
				// See the organization branch.
				const replacement = await tx.userCloudProviderConfig.findFirst({
					where: {
						userId: user.id,
						enabled: true,
						provider: { not: provider },
						...LLM_PROVIDER_PURPOSE_FILTER,
					},
				});
				if (!replacement) {
					return null;
				}
				await tx.userCloudProviderConfig.update({
					where: { id: replacement.id },
					data: { isDefault: true },
				});
				return replacement.provider;
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
