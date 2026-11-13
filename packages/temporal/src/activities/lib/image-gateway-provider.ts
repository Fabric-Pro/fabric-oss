import {
	AIProviderNotConfiguredError,
	getRAGProviderConfig,
	isVercelGatewayKey,
	type RAGProviderConfig,
	resolveProviderApiKey,
} from "@repo/ai";
import {
	getAiProviderApiKeyByProvider,
	updateProviderLastUsed,
} from "@repo/database";

function isUsableVercelConfig(
	config: Pick<RAGProviderConfig, "apiKey" | "provider">,
): boolean {
	return Boolean(
		config.apiKey &&
			(config.provider === "VERCEL_GATEWAY" ||
				isVercelGatewayKey(config.apiKey)),
	);
}

/**
 * Resolve the tenant-owned credential for a Vercel AI Gateway image request.
 * The tenant's ordinary provider resolution retains precedence, including a
 * personal Vercel key used inside an organization. Only an organization may
 * fall back to its enabled, non-embeddings-only Vercel connection.
 */
export async function resolveImageGatewayProviderConfig(context: {
	userId: string;
	organizationId?: string;
}): Promise<RAGProviderConfig | null> {
	let providerConfig: RAGProviderConfig | null = null;
	let defaultResolutionError: { error: unknown } | undefined;
	try {
		providerConfig = await getRAGProviderConfig(context);
	} catch (error) {
		if (!(error instanceof AIProviderNotConfiguredError)) {
			defaultResolutionError = { error };
		}
	}

	if (providerConfig && isUsableVercelConfig(providerConfig)) {
		return providerConfig;
	}

	if (!context.organizationId) {
		if (defaultResolutionError) {
			throw defaultResolutionError.error;
		}
		return providerConfig;
	}

	const organizationGateway = await getAiProviderApiKeyByProvider({
		userId: context.userId,
		organizationId: context.organizationId,
		provider: "VERCEL_GATEWAY",
	});
	if (
		organizationGateway.provider !== "VERCEL_GATEWAY" ||
		organizationGateway.source !== "organization" ||
		!organizationGateway.apiKey
	) {
		if (defaultResolutionError) {
			throw defaultResolutionError.error;
		}
		return providerConfig;
	}

	const apiKey = await resolveProviderApiKey(organizationGateway);
	if (organizationGateway.configId) {
		void updateProviderLastUsed({
			configId: organizationGateway.configId,
			source: "organization",
		}).catch(() => {
			// Best effort, like the language- and speech-model paths.
		});
	}

	return {
		apiKey,
		provider: organizationGateway.provider,
		baseUrl: organizationGateway.baseUrl,
		enabledProviders: organizationGateway.enabledProviders,
		source: "organization",
		deploymentName: organizationGateway.deploymentName,
	};
}
