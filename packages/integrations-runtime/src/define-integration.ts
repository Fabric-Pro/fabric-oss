import type {
	EndpointDefinition,
	EndpointHandler,
	EndpointMeta,
	IntegrationPlugin,
	OAuthConfig,
	PluginPermissionsConfig,
	WebhookDefinition,
	WebhookSignatureVerifier,
} from "./types.js";

/**
 * Helper for plugin authors: returns a fully-typed `EndpointDefinition` from
 * `(handler, meta)` pairs. Keeps plugin source concise.
 */
export function endpoint<Args, Result>(
	handler: EndpointHandler<Args, Result>,
	meta: EndpointMeta,
): EndpointDefinition<Args, Result> {
	return { handler, meta };
}

export interface DefineIntegrationInput {
	slug: string;
	name: string;
	version?: string;
	endpoints: Record<string, EndpointDefinition<any, any>>;
	permissions?: PluginPermissionsConfig;
	oauth?: OAuthConfig;
	webhooks?: Record<string, WebhookDefinition>;
	verifyWebhookSignature?: WebhookSignatureVerifier;
}

/**
 * Define an integration plugin. The returned object is registered with an
 * `IntegrationRegistry` to make it callable via the executor or webhook
 * processor.
 */
export function defineIntegration(
	input: DefineIntegrationInput,
): IntegrationPlugin {
	if (!input.slug || !/^[a-z][a-z0-9-]*$/.test(input.slug)) {
		throw new Error(
			`defineIntegration: slug must be lowercase alphanumeric with hyphens (got "${input.slug}")`,
		);
	}
	if (!input.name) {
		throw new Error(
			`defineIntegration: name is required (slug: ${input.slug})`,
		);
	}
	return {
		slug: input.slug,
		name: input.name,
		version: input.version,
		endpoints: input.endpoints,
		permissions: input.permissions,
		oauth: input.oauth,
		webhooks: input.webhooks,
		verifyWebhookSignature: input.verifyWebhookSignature,
	};
}
