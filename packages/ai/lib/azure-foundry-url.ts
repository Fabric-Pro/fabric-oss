/**
 * Azure AI Foundry request-target resolution lives in `@repo/agent-types` so the
 * agent bundle can share it without importing this package; re-exported here for
 * the model factory and the AI Providers connection tester.
 */
export {
	AZURE_OPENAI_API_VERSION,
	type AzureDeploymentTarget,
	type AzureEndpoint,
	normalizeAzureEndpoint,
	resolveAzureDeploymentTarget,
} from "@repo/agent-types";
