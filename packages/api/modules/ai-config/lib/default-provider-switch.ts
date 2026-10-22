import { ORPCError } from "@orpc/server";
import { buildProviderModelString } from "@repo/ai/lib/provider-model-string";
import { selectModelDynamic } from "@repo/ai/model-selector";
import {
	type AIProvider,
	type AiProviderConfig,
	type AiTaskType,
	captureTaskDefaultsSnapshot,
	db,
	getAiProviderApiKeyByProvider,
	getEmbeddingProviderConfig,
	getOrganizationDefaultProvider,
	LLM_PROVIDER_PURPOSE_FILTER,
	organizationDefaultProviderWhere,
	type Prisma,
	readProviderRowCredentials,
} from "@repo/database";
import { AiTaskTypeSchema } from "@repo/database/prisma/zod";
import { companyEmbeddingIdentity } from "@repo/rag/lib/company-contexts/resolution";
import { z } from "zod";
import { resolveEmbeddingModel } from "./embedding-model-resolution";
import { resolveOrganizationEmbedding } from "./organization-embedding-resolution";

export const EMBEDDINGS_ONLY_DEFAULT_MESSAGE =
	"An embeddings-only key cannot be the default AI provider. Change its purpose to allow all AI work first.";

const TEXT_TASKS = [
	"SIMPLE",
	"COMPLEX",
	"REASONING",
	"CHAT",
	"TOOL_CALLING",
	"EVAL",
] as const;

const previewModelSchema = z
	.object({
		id: z.string(),
		canonicalName: z.string(),
		displayName: z.string(),
		identity: z.string().nullable().optional(),
	})
	.nullable();
const previewPreferenceSchema = z.object({
	id: z.string(),
	taskType: AiTaskTypeSchema,
	provider: z.string(),
	modelId: z.string().nullable(),
});
/** Keep persistence predicates server-side; the read response contains display data only. */
export const defaultProviderSwitchPreviewSchema = z.object({
	currentProvider: z.string().nullable(),
	targetProvider: z.string().nullable(),
	validProviders: z.array(z.object({ provider: z.string() })),
	removedPreferences: z.array(previewPreferenceSchema),
	keptPreferences: z.array(previewPreferenceSchema),
	savedTextChoiceCount: z.number(),
	preservesEmbedding: z.boolean(),
	documentsProvider: z.string().nullable(),
	textTasks: z.array(
		z.object({
			taskType: z.enum(TEXT_TASKS),
			currentModel: previewModelSchema,
			targetModel: previewModelSchema,
		}),
	),
	currentEmbeddingModel: previewModelSchema,
	targetEmbeddingModel: previewModelSchema,
	embeddingsModelChanged: z.boolean(),
});

/** Resolve through the runtime selector, including deprecation and catalog fallback. */
async function modelFor(params: {
	userId: string;
	organizationId: string;
	provider: string | null;
	taskType: AiTaskType;
	ignorePreferences?: boolean;
	providerConfig?: AiProviderConfig;
}) {
	if (!params.provider) {
		return null;
	}
	try {
		const model =
			params.taskType === "EMBEDDING"
				? await resolveEmbeddingModel({
						...params,
						ignorePreferences: params.ignorePreferences ?? false,
						organizationOnly: true,
					})
				: await selectModelDynamic(
						{
							taskType: params.taskType,
							preferredProvider: params.provider as AIProvider,
							ignorePreferences: params.ignorePreferences,
							providerConfig: params.providerConfig,
						},
						{
							userId: params.userId,
							organizationId: params.organizationId,
						},
					);
		if (!model) {
			return null;
		}
		return {
			id: model.modelId,
			canonicalName: model.canonicalName,
			displayName: model.displayName,
			...(params.taskType === "EMBEDDING"
				? {
						identity: companyEmbeddingIdentity({
							provider: params.provider,
							modelString: buildProviderModelString(
								model.providerModelId ?? model.canonicalName,
								params.provider as AIProvider,
							),
						}),
					}
				: {}),
		};
	} catch (error) {
		// Missing catalog coverage is a preview result; database/provider failures still fail the read.
		if (
			error instanceof Error &&
			(error.message.startsWith("[ModelSelector] No model configured") ||
				error.message.startsWith("[ModelSelector] Embedding provider"))
		) {
			return null;
		}
		throw error;
	}
}

/** Compute switch effects from the provider state read by the caller. */
export function defaultProviderSwitchRules({
	organizationId,
	currentProvider,
	targetProvider,
	documentsProvider,
}: {
	organizationId: string;
	currentProvider: string | null;
	targetProvider?: string;
	documentsProvider: string | null;
}) {
	const changing =
		targetProvider !== undefined && currentProvider !== targetProvider;
	const preservesEmbedding = !!documentsProvider;
	const preservedTaskTypes: AiTaskType[] = [
		"DECISION",
		"IMAGE",
		"AUDIO",
		...(preservesEmbedding ? ["EMBEDDING" as const] : []),
	];
	const deleteWhere = changing
		? {
				organizationId,
				taskType: { notIn: preservedTaskTypes },
				provider: { not: "OPENAI_CHATGPT_PLAN" as const },
			}
		: null;
	return { deleteWhere, changing, preservesEmbedding };
}

/** Runtime resolution evidence for retaining the outgoing tenant connection. */
export async function planDefaultSwitchEmbeddings(params: {
	userId: string;
	organizationId?: string | null;
	currentProvider: string | null;
	targetProvider?: string;
	documentsProvider: string | null;
	protectedDocumentsProvider?: string | null;
	currentEmbeddingConfig: Pick<
		AiProviderConfig,
		"provider" | "source" | "configId"
	>;
}) {
	const {
		currentProvider,
		targetProvider,
		documentsProvider,
		currentEmbeddingConfig,
	} = params;
	if (
		documentsProvider ||
		!currentProvider ||
		targetProvider === undefined ||
		targetProvider === currentProvider ||
		currentEmbeddingConfig.provider !== currentProvider ||
		currentEmbeddingConfig.source !==
			(params.organizationId ? "organization" : "user") ||
		!currentEmbeddingConfig.configId
	) {
		return { documentsProvider, pin: null };
	}
	// Platform keys have no tenant row to pin. Organization settings compare
	// organization-only identities; a member's personal key is not an input.
	// Configure checks indexed impact before replacing the platform fallback.
	const hasEmbeddingModel = await resolveEmbeddingModel({
		userId: params.userId,
		organizationId: params.organizationId,
		provider: currentProvider,
		ignorePreferences: false,
	});
	if (hasEmbeddingModel && params.protectedDocumentsProvider) {
		throw new ORPCError("CONFLICT", {
			message:
				"The embeddings-only documents provider is unavailable. Restore it before switching default providers.",
		});
	}
	return hasEmbeddingModel
		? {
				documentsProvider: currentProvider,
				pin: {
					id: currentEmbeddingConfig.configId,
					provider: currentProvider,
				},
			}
		: { documentsProvider: null, pin: null };
}

type DefaultSwitchProviderRow = {
	id: string;
	provider: AIProvider;
	enabled: boolean;
	encryptedApiKey: string | null;
	clientId: string | null;
	encryptedClientSecret: string | null;
	config: unknown;
	purpose?: string;
	isDefault?: boolean;
	isEmbeddingProvider?: boolean;
};
type EmbeddingSwitchScope = {
	organizationId?: string | null;
	userId: string;
	targetProvider?: string;
};

async function readDefaultSwitchEmbeddingState(
	client: Pick<
		Prisma.TransactionClient,
		"cloudProviderConfig" | "userCloudProviderConfig"
	>,
	{ organizationId, userId }: EmbeddingSwitchScope,
	lockedDefault?: DefaultSwitchProviderRow | null,
) {
	const currentDefault =
		lockedDefault !== undefined
			? lockedDefault
			: organizationId
				? await client.cloudProviderConfig.findFirst({
						where: organizationDefaultProviderWhere(organizationId),
					})
				: await client.userCloudProviderConfig.findFirst({
						where: {
							userId,
							isDefault: true,
							enabled: true,
							...LLM_PROVIDER_PURPOSE_FILTER,
						},
					});
	const previous = organizationId
		? await client.cloudProviderConfig.findFirst({
				where: { organizationId, isEmbeddingProvider: true },
			})
		: await client.userCloudProviderConfig.findFirst({
				where: { userId, isEmbeddingProvider: true },
			});
	const protectedDocuments = organizationId
		? await client.cloudProviderConfig.findFirst({
				where: {
					organizationId,
					isEmbeddingProvider: true,
					purpose: "EMBEDDINGS_ONLY",
				},
			})
		: await client.userCloudProviderConfig.findFirst({
				where: {
					userId,
					isEmbeddingProvider: true,
					purpose: "EMBEDDINGS_ONLY",
				},
			});
	const documents = organizationId
		? await client.cloudProviderConfig.findFirst({
				where: {
					organizationId,
					enabled: true,
					isEmbeddingProvider: true,
				},
			})
		: await client.userCloudProviderConfig.findFirst({
				where: { userId, enabled: true, isEmbeddingProvider: true },
			});
	return { currentDefault, previous, protectedDocuments, documents };
}

// Compare routing inputs, excluding volatile usage timestamps. Keep credentials
// in memory only; this fingerprint is neither logged nor returned to the client.
function embeddingRoutingSnapshot(
	state: Awaited<ReturnType<typeof readDefaultSwitchEmbeddingState>>,
) {
	return JSON.stringify(
		[
			state.currentDefault,
			state.previous,
			state.protectedDocuments,
			state.documents,
		].map((row) =>
			row
				? {
						id: row.id,
						provider: row.provider,
						enabled: row.enabled,
						purpose: row.purpose,
						isDefault: row.isDefault,
						isEmbeddingProvider: row.isEmbeddingProvider,
						encryptedApiKey: row.encryptedApiKey,
						clientId: row.clientId,
						encryptedClientSecret: row.encryptedClientSecret,
						configApiKey: (
							row.config as { apiKey?: unknown } | null
						)?.apiKey,
						baseUrl: (row.config as { baseUrl?: unknown } | null)
							?.baseUrl,
						deploymentName: (
							row.config as { deploymentName?: unknown } | null
						)?.deploymentName,
					}
				: null,
		),
	);
}

/** Resolve catalog-dependent coverage before acquiring a tenant provider lock. */
export async function prepareDefaultSwitchEmbeddings(
	params: EmbeddingSwitchScope,
) {
	const state = await readDefaultSwitchEmbeddingState(db, params);
	const ownDefault =
		state.currentDefault?.enabled &&
		readProviderRowCredentials(state.currentDefault).hasCredentials
			? state.currentDefault
			: null;
	const documentsProvider =
		state.documents &&
		readProviderRowCredentials(state.documents).hasCredentials
			? state.documents.provider
			: null;
	const plan = await planDefaultSwitchEmbeddings({
		...params,
		currentProvider: ownDefault?.provider ?? null,
		documentsProvider,
		protectedDocumentsProvider: state.protectedDocuments?.provider,
		currentEmbeddingConfig: {
			provider: ownDefault?.provider ?? null,
			configId: ownDefault?.id ?? null,
			source: ownDefault
				? params.organizationId
					? "organization"
					: "user"
				: null,
		},
	});
	return { snapshot: embeddingRoutingSnapshot(state), plan };
}

/** Validate the pre-read under the provider lock, then pin using precomputed coverage. */
export async function pinDefaultSwitchEmbeddings(
	client: Prisma.TransactionClient,
	params: EmbeddingSwitchScope & {
		currentDefault: DefaultSwitchProviderRow | null;
		prepared: Awaited<ReturnType<typeof prepareDefaultSwitchEmbeddings>>;
	},
) {
	const { organizationId, userId } = params;
	const state = await readDefaultSwitchEmbeddingState(
		client,
		params,
		params.currentDefault,
	);
	if (embeddingRoutingSnapshot(state) !== params.prepared.snapshot) {
		throw new ORPCError("CONFLICT", {
			message:
				"The default or documents provider changed. Refresh and try again.",
		});
	}
	const { previous } = state;
	const { plan } = params.prepared;
	if (plan.pin) {
		const where = { id: plan.pin.id, isDefault: true, enabled: true };
		// Remove unusable/disabled flags before creating the live documents choice.
		if (organizationId) {
			await client.cloudProviderConfig.updateMany({
				where: { organizationId, isEmbeddingProvider: true },
				data: { isEmbeddingProvider: false },
			});
		} else {
			await client.userCloudProviderConfig.updateMany({
				where: { userId, isEmbeddingProvider: true },
				data: { isEmbeddingProvider: false },
			});
		}
		const result = organizationId
			? await client.cloudProviderConfig.updateMany({
					where: { ...where, organizationId },
					data: { isEmbeddingProvider: true },
				})
			: await client.userCloudProviderConfig.updateMany({
					where: { ...where, userId },
					data: { isEmbeddingProvider: true },
				});
		if (result.count !== 1) {
			throw new ORPCError("CONFLICT", {
				message:
					"The outgoing embedding provider changed. Refresh and try again.",
			});
		}
	}
	return {
		...plan,
		pin: plan.pin
			? {
					...plan.pin,
					previousEmbeddingProvider: previous?.provider ?? null,
				}
			: null,
	};
}

/** Read the available providers and plan a switch without changing preferences. */
export async function planDefaultProviderSwitch({
	organizationId,
	userId,
	targetProvider,
}: {
	organizationId: string;
	userId: string;
	targetProvider?: string;
}) {
	const [currentProvider, rows, documents] = await Promise.all([
		getOrganizationDefaultProvider(organizationId),
		db.cloudProviderConfig.findMany({
			where: { organizationId },
			select: {
				provider: true,
				purpose: true,
				isEmbeddingProvider: true,
			},
		}),
		getEmbeddingProviderConfig({ organizationId, userId }),
	]);
	const resolved = await Promise.all(
		rows
			.filter(
				(row) =>
					row.provider !== "OPENAI_CHATGPT_PLAN" &&
					row.purpose !== "EMBEDDINGS_ONLY",
			)
			.map(async (row) => {
				const config = await getAiProviderApiKeyByProvider({
					organizationId,
					userId,
					provider: row.provider,
				});
				return config.provider === row.provider &&
					config.source === "organization"
					? { provider: row.provider }
					: null;
			}),
	);
	const validProviders = resolved.filter(
		(p): p is NonNullable<typeof p> => p !== null,
	);
	const target = validProviders.find((p) => p.provider === targetProvider);
	if (targetProvider !== undefined && !target) {
		if (
			rows.some(
				(row) =>
					row.provider === targetProvider &&
					row.purpose === "EMBEDDINGS_ONLY",
			)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: EMBEDDINGS_ONLY_DEFAULT_MESSAGE,
			});
		}
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Choose an enabled API provider with usable credentials that allows language model work.",
		});
	}
	const organizationEmbedding = await resolveOrganizationEmbedding({
		organizationId,
		userId,
	});
	const currentEmbeddingConfig = documents.provider
		? documents
		: currentProvider
			? await getAiProviderApiKeyByProvider({
					organizationId,
					userId,
					provider: currentProvider,
				})
			: { provider: null, source: null, configId: null };
	const embeddingPlan = await planDefaultSwitchEmbeddings({
		userId,
		organizationId,
		protectedDocumentsProvider: rows.find(
			(row) =>
				row.isEmbeddingProvider && row.purpose === "EMBEDDINGS_ONLY",
		)?.provider,
		currentProvider,
		targetProvider,
		documentsProvider: documents.provider,
		currentEmbeddingConfig,
	});
	const { deleteWhere, changing, preservesEmbedding } =
		defaultProviderSwitchRules({
			organizationId,
			currentProvider,
			targetProvider,
			documentsProvider: embeddingPlan.documentsProvider,
		});
	return {
		deleteWhere,
		currentProvider,
		targetProvider: target?.provider ?? null,
		validProviders,
		preservesEmbedding,
		documentsProvider: embeddingPlan.documentsProvider,
		currentEmbeddingProvider: organizationEmbedding.provider,
		organizationEmbedding,
		changing,
	};
}

/** Enrich the shared rules with display-only catalog reads. Apply never calls this. */
export async function previewDefaultProviderSwitch(
	params: Parameters<typeof planDefaultProviderSwitch>[0],
) {
	const core = await planDefaultProviderSwitch(params);
	const { organizationId, userId } = params;
	const {
		currentProvider,
		targetProvider,
		preservesEmbedding,
		changing,
		documentsProvider,
	} = core;
	const preferences = await db.organizationModelPreference.findMany({
		where: { organizationId },
		select: { id: true, taskType: true, provider: true, modelId: true },
	});
	const removedPreferences = preferences.filter(
		(p) =>
			core.deleteWhere &&
			p.provider !== core.deleteWhere.provider.not &&
			!core.deleteWhere.taskType.notIn.includes(p.taskType),
	);
	const removedIds = new Set(removedPreferences.map((p) => p.id));
	const keptPreferences = preferences.filter((p) => !removedIds.has(p.id));
	if (targetProvider === null) {
		return {
			...core,
			removedPreferences,
			keptPreferences,
			savedTextChoiceCount: 0,
			textTasks: [],
			currentEmbeddingModel: null,
			targetEmbeddingModel: null,
			embeddingsModelChanged: false,
		};
	}

	const [currentConnection, targetConnection] = await Promise.all([
		currentProvider
			? getAiProviderApiKeyByProvider({
					organizationId,
					userId,
					provider: currentProvider,
				})
			: undefined,
		getAiProviderApiKeyByProvider({
			organizationId,
			userId,
			provider: targetProvider,
		}),
	]);
	// A switch captures the template from the database; preview with that same
	// uncached capture so a cached template row cannot make the two disagree.
	// Re-defaulting preserves the stored snapshot.
	const targetConfig =
		changing && targetProvider
			? {
					...targetConnection,
					taskDefaultsSnapshot:
						await captureTaskDefaultsSnapshot(targetProvider),
				}
			: targetConnection;

	const textTasks = targetProvider
		? await Promise.all(
				TEXT_TASKS.map(async (taskType) => ({
					taskType,
					currentModel: await modelFor({
						organizationId,
						userId,
						provider: currentProvider,
						providerConfig: currentConnection,
						taskType,
					}),
					targetModel: await modelFor({
						organizationId,
						userId,
						provider: targetProvider,
						providerConfig: targetConfig,
						taskType,
						ignorePreferences: changing,
					}),
				})),
			)
		: [];
	const currentEmbeddingProvider = core.currentEmbeddingProvider;
	const currentEmbeddingModel = core.organizationEmbedding.model
		? {
				id: core.organizationEmbedding.model.id,
				canonicalName: core.organizationEmbedding.model.canonicalName,
				displayName: core.organizationEmbedding.model.displayName,
				identity: core.organizationEmbedding.identity,
			}
		: null;
	const targetEmbeddingProvider =
		documentsProvider ?? targetProvider ?? currentEmbeddingProvider;
	const targetEmbeddingModel = changing
		? await modelFor({
				organizationId,
				userId,
				provider: targetEmbeddingProvider,
				taskType: "EMBEDDING",
				ignorePreferences: !preservesEmbedding,
			})
		: currentEmbeddingModel;
	return {
		...core,
		removedPreferences,
		keptPreferences,
		savedTextChoiceCount: removedPreferences.filter((p) =>
			(TEXT_TASKS as readonly string[]).includes(p.taskType),
		).length,
		preservesEmbedding,
		documentsProvider,
		textTasks,
		currentEmbeddingModel,
		targetEmbeddingModel,
		embeddingsModelChanged:
			changing &&
			(core.organizationEmbedding.source === "platform" ||
				currentEmbeddingModel?.identity !==
					targetEmbeddingModel?.identity),
	};
}
