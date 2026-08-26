/**
 * Databricks service-principal (OAuth M2M) credential resolution for the
 * AI/LLM provider path.
 *
 * A Databricks AI provider config authenticates one of two ways, never both:
 *  - **PAT**: a static `dapi…` token in `encryptedApiKey` (the original mode).
 *  - **Service principal**: `clientId` + `encryptedClientSecret`, exchanged for
 *    a short-lived workspace access token via the OAuth 2.0 client-credentials
 *    grant.
 *
 * `resolveProviderApiKey` is the SINGLE chokepoint that turns a stored provider
 * config into the plaintext bearer token every downstream consumer already
 * expects. Because the minted access token flows onward AS the `apiKey` string,
 * nothing downstream changes: `createOpenAI`, the LangGraph agent relay route,
 * CopilotKit's OpenAI client and the Temporal agent executor all keep their
 * existing `Authorization: Bearer <apiKey>` injection.
 *
 * The token exchange itself is delegated to `createOAuthM2MProvider` from
 * `@repo/databricks` — the same implementation the Databricks vector-search
 * path uses — so token caching, the 10-minute refresh margin and single-flight
 * refresh behave identically across both subsystems.
 */

import { createHash } from "node:crypto";
import {
	createOAuthM2MProvider,
	type DatabricksTokenProvider,
} from "@repo/databricks";
import { logger } from "@repo/logs";
import { decryptApiKey, decryptApiKeyMaybe } from "@repo/utils";

/**
 * The credential-bearing subset of a stored AI provider config. Mirrors the
 * fields `@repo/database`'s `AiProviderConfig` exposes, so callers can pass
 * their resolved config straight through.
 */
export interface ProviderCredentialInput {
	/** Provider enum value, e.g. "DATABRICKS". */
	provider: string | null;
	/** Encrypted static API key / PAT, when the row uses key auth. */
	apiKey?: string | null;
	/** Tenant workspace URL — required for a service-principal exchange. */
	baseUrl?: string | null;
	/** Service-principal client id, when the row uses OAuth M2M. */
	clientId?: string | null;
	/** Encrypted service-principal secret, when the row uses OAuth M2M. */
	encryptedClientSecret?: string | null;
}

/**
 * Thrown when a Databricks service-principal token exchange fails. Distinct
 * from a generic provider error so callers (notably the connection tester) can
 * tell "your client id/secret is wrong" apart from "the workspace rejected the
 * request".
 */
export class DatabricksOAuthError extends Error {
	/**
	 * HTTP status from the token endpoint, when the failure came from it.
	 * Safe to surface to an admin (401/403 ⇒ fix the credential, 5xx ⇒ retry);
	 * the response BODY is deliberately not carried here — see the throw site.
	 */
	readonly status?: number;

	constructor(
		message: string,
		options?: { cause?: unknown; status?: number },
	) {
		// Only install a `cause` when one is genuinely supplied — the audit
		// middleware serializes the cause chain, so an empty link is noise.
		super(
			message,
			options && "cause" in options
				? { cause: options.cause }
				: undefined,
		);
		this.name = "DatabricksOAuthError";
		this.status = options?.status;
	}
}

/**
 * Module-level provider cache, keyed by workspace host + client id + a SHA-256
 * DIGEST of the secret, so that:
 *  - concurrent callers share one in-flight exchange (single-flight) and one
 *    cached access token, rather than minting a token per AI call;
 *  - rotating the secret produces a new key, so a stale provider closed over
 *    the OLD secret can never keep serving tokens.
 *
 * The digest matters: keying by the plaintext secret would retain every secret
 * a process has ever seen in a live Map key, where any heap dump or accidental
 * enumeration would expose it. The digest preserves the "rotation ⇒ new key"
 * property without holding the credential.
 *
 * BOUNDED, for the same reason `databricksProviderCache` in `model-factory.ts`
 * is: rotation makes the key set grow over the life of a long-running worker.
 * Stale entries are inert, so oldest-first eviction is sufficient.
 */
const OAUTH_PROVIDER_CACHE_MAX = 256;
const oauthProviderCache = new Map<string, DatabricksTokenProvider>();

/** Test seam: drop all cached token providers. */
export function __resetDatabricksOAuthCache(): void {
	oauthProviderCache.clear();
}

/** Test seam: current number of cached token providers. */
export function __databricksOAuthCacheSize(): number {
	return oauthProviderCache.size;
}

/**
 * Test seam: the live cache keys. Exists so a test can assert that no plaintext
 * client secret is retained in a key — the property that makes the SHA-256
 * digest load-bearing rather than cosmetic.
 */
export function __databricksOAuthCacheKeys(): string[] {
	return Array.from(oauthProviderCache.keys());
}

/** True when the config carries a usable service-principal credential pair. */
export function hasServicePrincipalCredentials(
	config: Pick<ProviderCredentialInput, "clientId" | "encryptedClientSecret">,
): boolean {
	return Boolean(config.clientId && config.encryptedClientSecret);
}

/**
 * True when the config carries ANY usable credential — a static key or a
 * service principal. Read paths use this in place of a bare `if (apiKey)`
 * check, which would otherwise treat an OAuth-only row as unconfigured.
 */
export function hasProviderCredentials(
	config: Pick<
		ProviderCredentialInput,
		"apiKey" | "clientId" | "encryptedClientSecret"
	>,
): boolean {
	return Boolean(config.apiKey) || hasServicePrincipalCredentials(config);
}

/**
 * Make an untrusted value safe to interpolate into a single log line: collapse
 * all whitespace (so a newline-bearing value cannot forge extra log entries)
 * and truncate to `max` characters.
 */
function forLog(value: string, max: number): string {
	const flattened = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return flattened.length > max
		? `${flattened.slice(0, max)}…(truncated)`
		: flattened;
}

/**
 * Resolve a stored base URL to the bare HTTPS origin the OIDC token endpoint
 * lives on, STRICTLY.
 *
 * Deliberately does NOT use `toDatabricksWorkspaceHost`, whose best-effort
 * suffix-stripping fallback for unparseable input is fine for building an
 * inference URL but wrong here: this is the one path that POSTs the client
 * secret, so a malformed or non-HTTPS value must fail closed rather than be
 * coerced into something that happens to resolve. Plaintext HTTP is rejected
 * outright — the secret would otherwise cross the wire in the clear.
 */
function toStrictHttpsOrigin(baseUrl: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "") ?? "";
	if (!trimmed) {
		throw new DatabricksOAuthError(
			"Databricks service-principal auth requires a workspace URL. Configure the base URL for this provider in Settings → AI Providers.",
		);
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new DatabricksOAuthError(
			"The configured Databricks workspace URL is not a valid absolute URL.",
		);
	}

	if (parsed.protocol !== "https:") {
		throw new DatabricksOAuthError(
			"The Databricks workspace URL must use HTTPS for service-principal authentication.",
		);
	}

	return parsed.origin;
}

/**
 * Get (or lazily create) the cached token provider for a service principal and
 * resolve a workspace access token from it.
 *
 * @param baseUrl - The tenant's stored Databricks base URL. Normalized to the
 *   bare workspace host before hitting `/oidc/v1/token`.
 * @param clientId - Service-principal client id (application id).
 * @param clientSecret - PLAINTEXT service-principal secret (already decrypted).
 */
export async function getDatabricksOAuthToken(
	baseUrl: string,
	clientId: string,
	clientSecret: string,
	options?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<string> {
	const host = toStrictHttpsOrigin(baseUrl);

	// Digest, never the plaintext secret — see the cache doc comment.
	const secretDigest = createHash("sha256")
		.update(clientSecret)
		.digest("hex");
	const cacheKey = `${host}::${clientId}::${secretDigest}`;
	let provider = oauthProviderCache.get(cacheKey);
	if (!provider) {
		// Evict oldest-first before inserting. Map preserves insertion order, so
		// the first key is the least recently CREATED — good enough here, since
		// entries age out because their secret rotated, not because they went cold.
		while (oauthProviderCache.size >= OAUTH_PROVIDER_CACHE_MAX) {
			const oldest = oauthProviderCache.keys().next();
			if (oldest.done) {
				break;
			}
			oauthProviderCache.delete(oldest.value);
		}
		provider = createOAuthM2MProvider(
			host,
			clientId,
			clientSecret,
			options?.fetchImpl ?? globalThis.fetch,
		);
		oauthProviderCache.set(cacheKey, provider);
	}

	try {
		return await provider.getToken(options?.signal);
	} catch (error) {
		// A caller-originated abort is NOT an exchange failure. `waitAbortable`
		// in @repo/databricks stops only THIS caller's wait and deliberately
		// leaves the shared fetch running, so other coalesced callers still
		// receive a valid token and the provider's own cache stays warm.
		// Evicting here would throw away a healthy provider and force the next
		// caller into a redundant exchange. Rethrow the abort unchanged too —
		// the caller asked to stop, so they should see their AbortError rather
		// than a synthesized "authentication failed".
		if (
			options?.signal?.aborted === true ||
			(error instanceof Error && error.name === "AbortError")
		) {
			throw error;
		}

		// Genuine failure (bad credentials, timeout, transport error): drop the
		// cached provider so it can't wedge this credential — the next call
		// rebuilds it and retries the exchange.
		oauthProviderCache.delete(cacheKey);

		const raw = error instanceof Error ? error.message : String(error);
		const status = extractOAuthStatus(error);

		// Tenant-identifying context for the server log only. EVERY interpolated
		// part is bounded and flattened, including `clientId` — it is
		// user-supplied, so a long or newline-bearing value would otherwise
		// produce an oversized or multi-line entry that breaks log parsing.
		// The upstream body is already sanitized at its source in
		// `@repo/databricks` and never reaches here.
		logger.warn(
			`[databricks-oauth] Service-principal token exchange failed for ${forLog(host, 256)} (clientId=${forLog(clientId, 128)}): ${forLog(raw, 512)}`,
		);

		// NO `cause`. The oRPC audit middleware walks `Error.cause` and persists
		// the chain into org-admin-readable audit rows, so anything attached
		// here escapes the server. The upstream error carries no body today, but
		// this path handles a CREDENTIAL, so it does not depend on that staying
		// true — the status is lifted onto this error and the chain is cut.
		throw new DatabricksOAuthError(
			status
				? `Databricks service-principal token exchange failed (status ${status}).`
				: "Databricks service-principal token exchange failed.",
			{ status },
		);
	}
}

/**
 * Read the HTTP status off a token-fetch failure. Prefers the typed `status`
 * field that `DatabricksTokenFetchError` carries, falling back to parsing the
 * message for any other error shape. The status alone is safe to surface — it
 * tells an admin whether to re-check the credential (401/403) or retry (5xx) —
 * while the response body is not.
 */
function extractOAuthStatus(error: unknown): number | undefined {
	const typed = (error as { status?: unknown } | null)?.status;
	if (typeof typed === "number" && Number.isFinite(typed)) {
		return typed;
	}
	const message = error instanceof Error ? error.message : String(error);
	const match = message.match(/status (\d{3})/i);
	return match ? Number(match[1]) : undefined;
}

/**
 * Resolve a stored provider config to the PLAINTEXT bearer token to send
 * upstream.
 *
 * - Static key / PAT present → decrypt and return it. PAT wins when both are
 *   somehow set, matching `createDatabricksTokenProvider`'s precedence in
 *   `@repo/databricks`.
 * - Databricks + service principal → decrypt the secret and exchange it for a
 *   cached workspace access token.
 *
 * Every site that used to call `decryptApiKey(config.apiKey)` for an AI
 * provider must route through here instead, or OAuth-configured tenants break.
 */
export async function resolveProviderApiKey(
	config: ProviderCredentialInput,
	options?: {
		fetchImpl?: typeof fetch;
		signal?: AbortSignal;
		/**
		 * Tolerate a stored key that is not in encrypted form, returning it
		 * as-is instead of throwing. Set ONLY by call sites that already had
		 * this leniency (the gateway model listing, for legacy rows whose
		 * plaintext key lives in the JSON `config.apiKey`). The AI inference
		 * paths stay strict, as they were before.
		 */
		lenientDecrypt?: boolean;
	},
): Promise<string> {
	if (config.apiKey) {
		return options?.lenientDecrypt
			? decryptApiKeyMaybe(config.apiKey)
			: decryptApiKey(config.apiKey);
	}

	if (!hasServicePrincipalCredentials(config)) {
		throw new DatabricksOAuthError(
			"No credentials configured for this AI provider. Add an API key or a service principal in Settings → AI Providers.",
		);
	}

	if (config.provider !== "DATABRICKS") {
		throw new DatabricksOAuthError(
			`Service-principal authentication is not supported for provider ${config.provider ?? "unknown"}.`,
		);
	}

	if (!config.baseUrl) {
		throw new DatabricksOAuthError(
			"Databricks service-principal auth requires a workspace URL. Configure the base URL for this provider in Settings → AI Providers.",
		);
	}

	// `clientId` / `encryptedClientSecret` are non-null here — guarded by
	// `hasServicePrincipalCredentials` above.
	const clientSecret = decryptApiKey(config.encryptedClientSecret as string);
	return await getDatabricksOAuthToken(
		config.baseUrl,
		config.clientId as string,
		clientSecret,
		options,
	);
}
