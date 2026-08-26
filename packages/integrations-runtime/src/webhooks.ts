import type { IntegrationRegistry } from "./registry.js";
import type {
	CredentialStore,
	IntegrationContext,
	SignatureVerificationResult,
} from "./types.js";

export interface WebhookProcessorOptions {
	registry: IntegrationRegistry;
	credentials?: CredentialStore;
	/**
	 * Behavior when a plugin has no `verifyWebhookSignature` configured.
	 *  - `"reject"`  → return 401 (default; safest)
	 *  - `"accept"` → forward to the handler unverified (development only)
	 */
	onUnverified?: "reject" | "accept";
}

export interface InboundWebhookRequest {
	pluginSlug: string;
	tenantId?: string;
	headers: Record<string, string>;
	rawBody: string | Uint8Array;
	parsedBody?: unknown;
}

export type WebhookOutcome =
	| {
			status: "delivered";
			pluginSlug: string;
			eventPath: string;
			response?: unknown;
	  }
	| { status: "no_match"; pluginSlug: string }
	| { status: "invalid_signature"; pluginSlug: string }
	| { status: "no_plugin"; pluginSlug: string };

/**
 * Verifies inbound webhook signatures and dispatches to the matching handler.
 * Stateless — keeps no per-request state, safe to share across requests.
 */
export class WebhookProcessor {
	private readonly registry: IntegrationRegistry;
	private readonly credentials?: CredentialStore;
	private readonly onUnverified: "reject" | "accept";

	constructor(options: WebhookProcessorOptions) {
		this.registry = options.registry;
		this.credentials = options.credentials;
		this.onUnverified = options.onUnverified ?? "reject";
	}

	async process(request: InboundWebhookRequest): Promise<WebhookOutcome> {
		const plugin = this.registry.get(request.pluginSlug);
		if (!plugin) {
			return { status: "no_plugin", pluginSlug: request.pluginSlug };
		}

		const verification = await this.verify(plugin, request);
		if (verification === "invalid") {
			return {
				status: "invalid_signature",
				pluginSlug: request.pluginSlug,
			};
		}
		if (verification === "unknown" && this.onUnverified === "reject") {
			return {
				status: "invalid_signature",
				pluginSlug: request.pluginSlug,
			};
		}

		const payload =
			request.parsedBody ??
			this.tryParseJson(request.rawBody) ??
			request.rawBody;

		if (!plugin.webhooks) {
			return { status: "no_match", pluginSlug: request.pluginSlug };
		}

		for (const [eventPath, def] of Object.entries(plugin.webhooks)) {
			if (def.matcher(payload, request.headers)) {
				const creds =
					request.tenantId && this.credentials
						? ((await this.credentials.get(
								request.tenantId,
								plugin.slug,
							)) ?? {})
						: {};
				const ctx: IntegrationContext = {
					pluginSlug: plugin.slug,
					endpoint: eventPath,
					tenantId: request.tenantId ?? "",
					credentials: creds,
				};
				const response = await def.handler(ctx, payload);
				return {
					status: "delivered",
					pluginSlug: plugin.slug,
					eventPath,
					response: response ?? undefined,
				};
			}
		}
		return { status: "no_match", pluginSlug: plugin.slug };
	}

	private async verify(
		plugin: {
			verifyWebhookSignature?: import("./types.js").WebhookSignatureVerifier;
		},
		request: InboundWebhookRequest,
	): Promise<SignatureVerificationResult> {
		if (!plugin.verifyWebhookSignature) {
			return "unknown";
		}
		const creds =
			request.tenantId && this.credentials
				? await this.credentials.get(
						request.tenantId,
						request.pluginSlug,
					)
				: undefined;
		return plugin.verifyWebhookSignature({
			headers: request.headers,
			rawBody: request.rawBody,
			tenantId: request.tenantId,
			credentials: creds,
		});
	}

	private tryParseJson(body: string | Uint8Array): unknown {
		try {
			const text =
				typeof body === "string"
					? body
					: new TextDecoder().decode(body);
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	}
}
