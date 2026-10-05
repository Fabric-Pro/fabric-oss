/**
 * Azure AI Foundry (Azure OpenAI) request-target resolution — the single
 * source of truth for turning a stored endpoint and deployment name into the
 * URL, `model` body value and `api-version` that chat and embedding requests
 * use.
 *
 * Lives in `@repo/agent-types` because it is pure and the LangGraph agent
 * bundle cannot import `@repo/ai`: every `agents/langchain/*` tsup config marks
 * `@repo/ai` external, while bundling the other `@repo/*` packages.
 * `@repo/ai` re-exports it for the model factory and the connection tester, so
 * Test Connection probes exactly the request every in-app Azure call makes.
 */

/** The `api-version` query parameter classic deployment requests carry. */
export const AZURE_OPENAI_API_VERSION = "2025-01-01-preview";

const AZURE_V1_PATH = /\/openai\/v1(?:\/|$)/i;

export interface AzureEndpoint {
	origin: string;
	/** True when the pasted URL points at the v1 API (`/openai/v1`). */
	isV1: boolean;
}

export interface AzureDeploymentTarget {
	/** Append `/chat/completions` or `/embeddings` to this. */
	baseURL: string;
	/** Value for the request body's `model` field. */
	model: string;
	/** `api-version` query value, or `null` when Azure rejects the parameter. */
	apiVersion: string | null;
}

/**
 * Only Azure resource hosts pass the provider-URL allow-list, and every one of
 * them serves both API shapes at its root, so a pasted URL reduces to its
 * origin plus whether it names the v1 API. Everything else in it is dropped:
 * a portal "Target URI" (`/openai/deployments/x/chat/completions?api-version=…`),
 * a project path, a trailing `/openai` or `/models`, query strings, fragments.
 */
export function normalizeAzureEndpoint(baseUrl: string): AzureEndpoint {
	const url = new URL(baseUrl.trim());
	return { origin: url.origin, isV1: AZURE_V1_PATH.test(url.pathname) };
}

/**
 * Two endpoint shapes exist. The classic endpoint routes by URL
 * (`<origin>/openai/deployments/<name>` plus `api-version`, model in the URL).
 * The v1 endpoint (`<origin>/openai/v1`) routes by the body's `model` and
 * rejects `api-version` outright. The portal hands v1 out project-scoped
 * (`…/api/projects/{project}/openai/v1`), but that base does not serve
 * `/embeddings` (404) while the resource-level base serves both chat and
 * embeddings, so it is collapsed to the resource level for every request.
 * The deployment name is trimmed here rather than by each caller, so a stray
 * space typed into the form cannot pass the test and then fail in the app.
 */
export function resolveAzureDeploymentTarget(
	baseUrl: string,
	deploymentName: string,
): AzureDeploymentTarget {
	const { origin, isV1 } = normalizeAzureEndpoint(baseUrl);
	const deployment = deploymentName.trim();
	if (isV1) {
		return {
			baseURL: `${origin}/openai/v1`,
			model: deployment,
			apiVersion: null,
		};
	}
	return {
		baseURL: `${origin}/openai/deployments/${encodeURIComponent(deployment)}`,
		model: "",
		apiVersion: AZURE_OPENAI_API_VERSION,
	};
}
