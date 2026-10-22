import { buildProviderModelString } from "@repo/ai/lib/provider-model-string";
import { config } from "@repo/config";
import {
	type AIProvider,
	getEmbeddingProviderConfig,
	getOrganizationDefaultProvider,
} from "@repo/database";
import { isGatewayProvider } from "@repo/database/prisma/queries/ai-provider-config";
import { companyEmbeddingIdentity } from "@repo/rag/lib/company-contexts/resolution";
import { z } from "zod";
import { resolveEmbeddingModel } from "./embedding-model-resolution";

export const organizationEmbeddingSchema = z.object({
	provider: z.string().nullable(),
	model: z
		.object({
			id: z.string(),
			canonicalName: z.string(),
			displayName: z.string(),
			providerModelId: z.string(),
			modelString: z.string(),
			subProvider: z.string().nullable(),
		})
		.nullable(),
	identity: z.string().nullable(),
	source: z
		.enum(["documents_provider", "default_provider", "platform"])
		.nullable(),
});
export type OrganizationEmbedding = z.infer<typeof organizationEmbeddingSchema>;

/**
 * Settings' organization-only embedding resolution, matching the runtime's
 * documents -> organization default -> platform path. No personal-key rung.
 * The platform gate matches getPlatformGatewayProviderConfig without calling
 * its encryptApiKey/scrypt or disclosing its provider or model to tenants.
 */
export async function resolveOrganizationEmbedding(params: {
	organizationId: string;
	userId: string;
	/** Task-default readers need the post-reset model rather than the saved choice. */
	ignorePreferences?: boolean;
}): Promise<OrganizationEmbedding> {
	if (!params.organizationId) {
		throw new Error(
			"Organization embedding resolution requires an organization",
		);
	}
	const empty: OrganizationEmbedding = {
		provider: null,
		model: null,
		identity: null,
		source: null,
	};
	const documents = await getEmbeddingProviderConfig({
		organizationId: params.organizationId,
		userId: params.userId,
	});
	const provider =
		documents.provider ??
		(await getOrganizationDefaultProvider(params.organizationId));
	if (!provider) {
		return {
			...empty,
			source:
				config.ai.enableGateway && config.ai.gatewayApiKey
					? "platform"
					: null,
		};
	}
	const resolved = await resolveEmbeddingModel({
		...params,
		provider,
		organizationOnly: true,
		ignorePreferences: params.ignorePreferences ?? false,
	});
	if (!resolved) {
		return empty;
	}
	const modelString = buildProviderModelString(
		resolved.providerModelId ?? resolved.canonicalName,
		provider as AIProvider,
	);
	return {
		provider,
		source: documents.provider ? "documents_provider" : "default_provider",
		model: {
			id: resolved.modelId,
			canonicalName: resolved.canonicalName,
			displayName: resolved.displayName,
			providerModelId: resolved.providerModelId ?? resolved.canonicalName,
			modelString,
			subProvider:
				isGatewayProvider(provider as AIProvider) &&
				modelString.includes("/")
					? modelString.split("/")[0]
					: null,
		},
		identity: companyEmbeddingIdentity({ provider, modelString }),
	};
}
