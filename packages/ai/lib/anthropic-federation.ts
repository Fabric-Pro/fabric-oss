import type { DefaultAzureCredential } from "@azure/identity";
import {
	ANTHROPIC_FEDERATION_UNAVAILABLE,
	getAnthropicFederationConfig,
} from "@repo/database/prisma/queries/anthropic-federation";

export const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
const REFRESH_MARGIN_MS = 30_000;

export interface AnthropicBearerToken {
	kind: "bearer";
	token: string;
	expiresAt: number;
}

export type AnthropicBearerSource = () => Promise<AnthropicBearerToken>;

type FederationConfig = NonNullable<
	ReturnType<typeof getAnthropicFederationConfig>
>;

let entra: DefaultAzureCredential | undefined;
// One process-level federation configuration. Tenant eligibility is checked
// independently of the shared exchange, including when joining a refresh.
let cache:
	| {
			key: string;
			token?: AnthropicBearerToken;
			pending?: Promise<AnthropicBearerToken>;
	  }
	| undefined;

function requireConfig(organizationId: string) {
	const config = getAnthropicFederationConfig(organizationId);
	if (!config) {
		throw new Error(ANTHROPIC_FEDERATION_UNAVAILABLE);
	}
	return config;
}

async function exchange(
	config: FederationConfig,
	organizationId: string,
): Promise<AnthropicBearerToken> {
	try {
		if (!entra) {
			const { DefaultAzureCredential } = await import("@azure/identity");
			entra ??= new DefaultAzureCredential();
		}
		const assertion = await entra.getToken(
			`api://${config.audience}/.default`,
		);
		if (
			!assertion?.token ||
			JSON.stringify(requireConfig(organizationId)) !==
				JSON.stringify(config)
		) {
			throw new Error("Anthropic identity assertion is unavailable.");
		}
		const startedAt = Date.now();
		const response = await fetch(`${ANTHROPIC_ORIGIN}/v1/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
			body: JSON.stringify({
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion: assertion.token,
				federation_rule_id: config.federationRuleId,
				organization_id: config.organizationId,
				service_account_id: config.serviceAccountId,
				workspace_id: config.workspaceId,
			}),
		});
		if (!response.ok) {
			throw new Error("Anthropic rejected the assertion.");
		}
		const result = (await response.json()) as {
			access_token?: unknown;
			expires_in?: unknown;
			token_type?: unknown;
		};
		const expiresAt = startedAt + Number(result.expires_in) * 1000;
		if (
			typeof result.access_token !== "string" ||
			!result.access_token.trim() ||
			result.token_type !== "Bearer" ||
			typeof result.expires_in !== "number" ||
			!Number.isFinite(expiresAt) ||
			expiresAt <= Date.now()
		) {
			throw new Error("Invalid exchange response.");
		}
		return { kind: "bearer", token: result.access_token, expiresAt };
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw error;
		}
		throw new Error("Anthropic identity token exchange failed.");
	}
}

export async function getAnthropicFederatedToken(
	organizationId: string,
): Promise<AnthropicBearerToken> {
	const config = requireConfig(organizationId);
	const key = JSON.stringify(config);
	if (cache?.key !== key) {
		cache = { key };
	}
	const entry = cache;
	let token = entry.token;
	if (!token || token.expiresAt <= Date.now() + REFRESH_MARGIN_MS) {
		entry.pending ??= exchange(config, organizationId)
			.then((value) => {
				entry.token = value;
				return value;
			})
			.catch((error) => {
				entry.token = undefined;
				throw error;
			})
			.finally(() => {
				entry.pending = undefined;
			});
		token = await entry.pending;
	}
	if (
		JSON.stringify(requireConfig(organizationId)) !== key ||
		token.expiresAt <= Date.now()
	) {
		throw new Error(ANTHROPIC_FEDERATION_UNAVAILABLE);
	}
	return token;
}

/** Resolve a fresh Bearer token immediately before sending the provider request. */
export function anthropicBearerFetch(
	source: AnthropicBearerSource,
): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		if (new URL(request.url).origin !== ANTHROPIC_ORIGIN) {
			throw new Error(
				"Anthropic Bearer credentials require the Anthropic API endpoint.",
			);
		}
		const credential = await source();
		if (credential.expiresAt <= Date.now()) {
			throw new Error("Anthropic Bearer credential has expired.");
		}
		request.headers.delete("x-api-key");
		request.headers.set("authorization", `Bearer ${credential.token}`);
		try {
			return await fetch(request, { redirect: "error" });
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw error;
			}
			throw new Error("Anthropic API request failed.");
		}
	};
}

export function getAnthropicBearerSource(config: {
	federatedOrganizationId?: string | null;
}): AnthropicBearerSource | undefined {
	const organizationId = config.federatedOrganizationId;
	return organizationId
		? () => getAnthropicFederatedToken(organizationId)
		: undefined;
}
