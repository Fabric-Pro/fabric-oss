/** Tenant-aware configuration for reranking providers. */
import { resolveProviderApiKey } from "@repo/ai/lib/databricks-oauth";
import { getOrganizationGatewaySearchConfig } from "@repo/database";
import type {
	RerankerConfig,
	RerankerProviderType,
	RerankerTenant,
} from "./types";
import { RERANKER_MODELS } from "./types";

/** Ignore unknown environment values so tenant defaults can still apply. */
export function getDefaultRerankerProvider(): RerankerProviderType | undefined {
	const provider = process.env.RERANKER_PROVIDER?.toLowerCase();
	return provider === "cohere" ||
		provider === "gateway" ||
		provider === "cross-encoder"
		? provider
		: undefined;
}

export function getCohereApiKey(): string | undefined {
	return process.env.COHERE_API_KEY;
}

export function isCohereAvailable(): boolean {
	return !!getCohereApiKey();
}

/** Local ONNX inference is unavailable in the Vercel function bundle. */
export function isCrossEncoderAvailable(): boolean {
	return process.env.VERCEL !== "1";
}

/** Resolve only the caller's organization gateway key. */
export async function resolveRerankerGatewayCredential(
	tenant?: RerankerTenant,
) {
	const config =
		tenant?.organizationId && tenant.userId
			? await getOrganizationGatewaySearchConfig(tenant.organizationId)
			: null;
	if (!config?.apiKey) {
		return null;
	}
	const apiKey = await resolveProviderApiKey(config);
	return apiKey
		? { apiKey, providerConfigId: config.configId ?? undefined }
		: null;
}

/**
 * Stored cross-encoder is the historical column default, not an explicit
 * opt-out. Explicit cloud preferences beat the environment; defaults use the
 * environment or an available tenant gateway credential.
 */
export async function getRerankerConfig(
	preferredProvider?: RerankerProviderType,
	overrides?: Partial<RerankerConfig>,
	tenant?: RerankerTenant,
): Promise<RerankerConfig> {
	const preference = overrides?.provider ?? preferredProvider;
	let provider =
		preference && preference !== "cross-encoder"
			? preference
			: getDefaultRerankerProvider();
	let credential: Awaited<
		ReturnType<typeof resolveRerankerGatewayCredential>
	> = null;
	if (!provider || provider === "gateway") {
		try {
			credential = await resolveRerankerGatewayCredential(tenant);
		} catch {
			// Credential errors must not expose encrypted or decrypted keys.
			throw new Error("Gateway reranker credential resolution failed");
		}
		provider = credential ? "gateway" : "cross-encoder";
	}
	if (provider === "cohere" && !isCohereAvailable()) {
		provider = "cross-encoder";
	}
	return {
		timeout: 30000,
		...overrides,
		provider,
		tenant,
		apiKey:
			provider === "gateway"
				? credential?.apiKey
				: (overrides?.apiKey ?? getCohereApiKey()),
		providerConfigId:
			provider === "gateway" ? credential?.providerConfigId : undefined,
		model:
			overrides?.model ??
			(provider === "gateway"
				? process.env.RERANKER_GATEWAY_MODEL ||
					RERANKER_MODELS.gateway.default
				: RERANKER_MODELS[provider].default),
	};
}

export const RERANKER_ENV_VARS = {
	/** Known provider override: cross-encoder, cohere, or gateway. */
	RERANKER_PROVIDER: "RERANKER_PROVIDER",
	RERANKER_GATEWAY_MODEL: "RERANKER_GATEWAY_MODEL",
	COHERE_API_KEY: "COHERE_API_KEY",
} as const;
