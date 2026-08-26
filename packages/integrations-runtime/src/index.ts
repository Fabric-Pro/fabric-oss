/**
 * @fabricorg/integrations-runtime
 *
 * Plugin contract and runtime for Fabric integrations. Lets you declare a
 * vendor integration once (`defineIntegration`) and call its endpoints
 * through a permission-gated executor (`IntegrationExecutor`) that resolves
 * credentials and approvals from injectable stores.
 *
 * Portions derived from Corsair (https://github.com/corsairdotdev/corsair)
 * under Apache-2.0. See THIRD_PARTY_NOTICES.md at the repository root.
 */

export {
	type DefineIntegrationInput,
	defineIntegration,
	endpoint,
} from "./define-integration.js";
export {
	type CallOptions,
	IntegrationExecutor,
	type IntegrationExecutorOptions,
} from "./executor.js";
export {
	MemoryApprovalStore,
	MemoryCredentialStore,
} from "./memory-stores.js";
export {
	evaluatePermission,
	PERMISSION_MATRIX,
	parseDurationMs,
} from "./permissions.js";
export { IntegrationRegistry } from "./registry.js";
export type {
	ApprovalStore,
	CredentialStore,
	EndpointDefinition,
	EndpointHandler,
	EndpointMeta,
	EndpointRiskLevel,
	ExecuteResult,
	IntegrationContext,
	IntegrationPlugin,
	OAuthConfig,
	PendingApproval,
	PermissionMode,
	PermissionPolicy,
	PluginPermissionsConfig,
	SignatureVerificationResult,
	WebhookDefinition,
	WebhookHandler,
	WebhookSignatureVerifier,
} from "./types.js";
export {
	type InboundWebhookRequest,
	type WebhookOutcome,
	WebhookProcessor,
	type WebhookProcessorOptions,
} from "./webhooks.js";
