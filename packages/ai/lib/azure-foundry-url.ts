/**
 * Azure AI Foundry (Azure OpenAI) request-target resolution — the single
 * source of truth for turning a stored endpoint and deployment name into the
 * URL, `model` body value and `api-version` that chat and embedding requests
 * use.
 *
 * Shared by `@repo/ai`'s model factory and `@repo/api`'s connection tester so
 * Test Connection probes exactly the request every in-app Azure chat call makes.
 * The tester previously asked Azure to list deployments instead, which current
 * Azure AI Foundry resources do not answer, so a working key and deployment
 * failed the test.
 */

/** The `api-version` query parameter classic deployment requests carry. */
export const AZURE_OPENAI_API_VERSION = "2025-01-01-preview";

/** Same marker `@repo/agent-core` uses to detect the project-scoped v1 endpoint. */
const AZURE_V1_ENDPOINT = /\/openai\/v1(?:\/|$)/;

export interface AzureDeploymentTarget {
	/** Append `/chat/completions` or `/embeddings` to this. */
	baseURL: string;
	/** Value for the request body's `model` field. */
	model: string;
	/** `api-version` query value, or `null` when Azure rejects the parameter. */
	apiVersion: string | null;
}

/**
 * Two endpoint shapes exist. The classic resource endpoint routes by URL
 * (`<endpoint>/openai/deployments/<name>` plus `api-version`, model in the URL).
 * The project-scoped v1 endpoint
 * (`https://{resource}.services.ai.azure.com/api/projects/{project}/openai/v1`)
 * routes by the body's `model`, and rejects `api-version` outright.
 * The deployment name is trimmed here rather than by each caller, so a stray
 * space typed into the form cannot pass the test and then fail in the app.
 */
export function resolveAzureDeploymentTarget(
	baseUrl: string,
	deploymentName: string,
): AzureDeploymentTarget {
	const endpoint = baseUrl.trim().replace(/\/+$/, "");
	const deployment = deploymentName.trim();
	if (AZURE_V1_ENDPOINT.test(endpoint)) {
		return { baseURL: endpoint, model: deployment, apiVersion: null };
	}
	return {
		baseURL: `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}`,
		model: "",
		apiVersion: AZURE_OPENAI_API_VERSION,
	};
}
