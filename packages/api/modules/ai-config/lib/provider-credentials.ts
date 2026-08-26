/**
 * Shared credential-shape validation for AI provider inputs.
 *
 * A provider config authenticates one of two ways, never both: a static API
 * key/PAT, or an OAuth M2M service principal (client ID + client secret).
 * `upsert` (which persists) and `testConnection` (which exercises) must agree
 * exactly — if the tester silently accepted a shape the writer rejects (or
 * quietly tested only half of what was sent), a user could get a green
 * connection test for a config that cannot be saved, or worse, one that saves
 * with different credentials than the ones actually verified.
 */

import type { z } from "zod";

export interface ProviderCredentialShape {
	provider: string;
	apiKey?: string;
	clientId?: string;
	clientSecret?: string;
	baseUrl?: string;
}

/**
 * Enforce the credential XOR on a zod input.
 *
 * @param supportsServicePrincipal - Whether this provider may use OAuth M2M at
 *   all. Callers resolve it from provider metadata (`upsert`) or from the
 *   provider identity (`testConnection`), so this module stays free of
 *   `@repo/database` imports.
 */
export function refineProviderCredentials(
	input: ProviderCredentialShape,
	ctx: z.RefinementCtx,
	supportsServicePrincipal: boolean,
	displayName?: string,
): void {
	const hasApiKey = Boolean(input.apiKey?.trim());
	const hasClientId = Boolean(input.clientId?.trim());
	const hasClientSecret = Boolean(input.clientSecret?.trim());
	const hasServicePrincipal = hasClientId && hasClientSecret;

	// Providers without OAuth M2M support still require an API key, and must
	// reject service-principal fields outright rather than ignoring them.
	if (!supportsServicePrincipal) {
		if (hasClientId || hasClientSecret) {
			ctx.addIssue({
				code: "custom",
				path: ["clientId"],
				message: `${displayName ?? input.provider} does not support service-principal authentication. Provide an API key instead.`,
			});
		}
		if (!hasApiKey) {
			ctx.addIssue({
				code: "custom",
				path: ["apiKey"],
				message: "An API key is required.",
			});
		}
		return;
	}

	// Exactly one auth mode. Accepting both would mean silently honouring one
	// and discarding the other.
	if (hasApiKey && (hasClientId || hasClientSecret)) {
		ctx.addIssue({
			code: "custom",
			path: ["apiKey"],
			message:
				"Provide either an API key or a service principal (client ID + client secret), not both.",
		});
		return;
	}

	if (!hasApiKey && !hasServicePrincipal) {
		// Half a service principal is the likeliest mistake — point at the
		// missing half rather than the whole form.
		if (hasClientId !== hasClientSecret) {
			ctx.addIssue({
				code: "custom",
				path: hasClientId ? ["clientSecret"] : ["clientId"],
				message:
					"Service-principal authentication requires both a client ID and a client secret.",
			});
			return;
		}
		ctx.addIssue({
			code: "custom",
			path: ["apiKey"],
			message:
				"Provide an API key, or a service principal (client ID + client secret).",
		});
		return;
	}

	// The OAuth token endpoint lives at the workspace root, so a service
	// principal is unusable without a base URL.
	if (hasServicePrincipal && !input.baseUrl?.trim()) {
		ctx.addIssue({
			code: "custom",
			path: ["baseUrl"],
			message:
				"Service-principal authentication requires the workspace URL, which hosts the OAuth token endpoint.",
		});
	}
}
