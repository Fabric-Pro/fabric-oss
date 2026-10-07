/**
 * Shared MCP Client Factory
 *
 * Creates MCP clients using official MCP SDK transports for better compatibility
 * with various MCP servers. This is the single source of truth for MCP client creation.
 *
 * Supports both Streamable HTTP and SSE transports per MCP specification.
 * Implements MCP Session ID tracking for stateful connections.
 *
 * @see https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools
 * @see https://spec.modelcontextprotocol.io/specification/basic/transports/
 */

import { createMCPClient } from "@ai-sdk/mcp";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	credentialFingerprintMatches,
	getMcpConfigById,
	getMcpOAuthGrantGeneration,
	getValidAccessToken,
	markMcpOAuthReconnectRequired,
	parseMcpOAuthBinding,
	sameAuthorizationServer,
} from "@repo/database";
import {
	GITLAB_PM_ORIGIN_MISMATCH_MESSAGE,
	parseGitLabOrigin,
} from "@repo/integrations/gitlab";
import { classifyOAuthErrorCode } from "@repo/utils/oauth-refresh";
import {
	GitLabMcpCredentialError,
	type GitLabMcpFetch,
	getGitLabMcpTransportAuth,
	isCachedGitLabClientUsable,
	isGitLabPersonalMcpConfig,
} from "./gitlab-credential";
import {
	createOAuthClientProvider,
	OAuthAuthorizationRequiredError,
} from "./oauth-provider";
import {
	checkMcpConfigOrganizationAccess,
	type McpConfigAccess,
} from "./organization-access";
import { assertMcpServerUrlResolved, fetchMcpServer } from "./server-url-guard";

export type McpClientType = Awaited<ReturnType<typeof createMCPClient>>;

export type { CreateOAuthProviderOptions } from "./oauth-provider";
// Re-export OAuth provider types and errors
export { OAuthAuthorizationRequiredError } from "./oauth-provider";

/**
 * API Key authentication method
 */
export type ApiKeyMethod = "BEARER" | "HEADER" | "PLAIN";

export interface CreateMcpClientOptions {
	serverUrl: string;
	transport: "HTTP" | "SSE" | string;
	headers?: Record<string, string>;
	/** MCP Session ID for stateful connections */
	sessionId?: string;
	/**
	 * OAuth client provider for automatic token management.
	 * When provided, the transport will handle OAuth authentication automatically,
	 * including token refresh and re-authorization when needed.
	 */
	authProvider?: OAuthClientProvider;
	/**
	 * The fetch every transport request goes through. Defaults to
	 * `fetchMcpServer`. A GitLab personal server passes the fetch from
	 * `getGitLabMcpTransportAuth`, which keeps its credential on its own
	 * GitLab origin behind the GitLab outbound guard.
	 */
	fetch?: GitLabMcpFetch;
}

export interface CreateMcpClientForConfigOptions {
	configId: string;
	userId: string;
	organizationId?: string;
	/**
	 * Redirect URI for OAuth callbacks.
	 * Used for OAuth2 configs to enable automatic token refresh.
	 * If not provided, defaults to `${NEXT_PUBLIC_SITE_URL}/api/mcp/oauth/callback`.
	 */
	redirectUri?: string;
	/**
	 * Callback invoked when OAuth authorization is required.
	 * In browser contexts, this can redirect the user.
	 * In server contexts, this should throw or signal the need for auth.
	 */
	onAuthorizationRequired?: (authUrl: URL) => void | Promise<void>;
	/**
	 * The GitLab instance (origin) the caller's request must go to, for a
	 * caller acting on a project's GitLab PM container (a container id names
	 * a project on one instance only). A GitLab personal server whose endpoint
	 * is on any other instance is refused with `McpGitLabOriginMismatchError`
	 * before a token is read or a connection is made, and a cached client
	 * bound to another instance is refused before it is used. Other servers
	 * ignore it.
	 */
	expectedGitLabOrigin?: string;
	/**
	 * What the caller will do with the client, checked against the config
	 * owner's current role in `organizationId` before the config is read
	 * (`checkMcpConfigOrganizationAccess`): `read` for listing tools or
	 * resources and reading a resource (MCP_READ), `connect` for executing a
	 * tool (MCP_CONNECT). Defaults to `connect`, so a caller that does not say
	 * is held to the stricter check. A cached client is re-checked on every
	 * call. Ignored without an `organizationId` (the personal arm).
	 */
	access?: McpConfigAccess;
}

/**
 * Custom error class for MCP-related errors with additional context
 */
export class McpClientError extends Error {
	public readonly code: string;
	public readonly serverName?: string;
	public readonly isAuthError: boolean;
	public readonly isRateLimitError: boolean;
	public readonly retryAfter?: number;
	public readonly originalCause?: Error;

	constructor(options: {
		message: string;
		code: string;
		serverName?: string;
		isAuthError?: boolean;
		isRateLimitError?: boolean;
		retryAfter?: number;
		cause?: Error;
	}) {
		super(options.message);
		this.name = "McpClientError";
		this.code = options.code;
		this.serverName = options.serverName;
		this.isAuthError = options.isAuthError ?? false;
		this.isRateLimitError = options.isRateLimitError ?? false;
		this.retryAfter = options.retryAfter;
		this.originalCause = options.cause;
	}
}

/**
 * A GitLab personal MCP server on another GitLab instance than the caller's
 * `expectedGitLabOrigin`. Nothing was sent to it, and retrying cannot change
 * that: the config or the connection has to move back first.
 */
export class McpGitLabOriginMismatchError extends McpClientError {
	constructor(serverName?: string) {
		super({
			message: GITLAB_PM_ORIGIN_MISMATCH_MESSAGE,
			code: "GITLAB_PM_ORIGIN_MISMATCH",
			serverName,
		});
		this.name = "McpGitLabOriginMismatchError";
	}
}

/**
 * Refuses, with an `McpClientError` carrying `ORGANIZATION_MEMBERSHIP_REQUIRED`
 * or `MCP_PERMISSION_DENIED`, a caller whose current organization role does
 * not allow `access` (default `connect`) on their config in `organizationId`.
 * A failed permission read rejects with that read's error: it never allows.
 * No `organizationId` is the personal arm and is not checked.
 */
async function assertMcpConfigOrganizationAccess(args: {
	userId: string;
	organizationId?: string | null;
	access?: McpConfigAccess;
	serverName?: string;
}): Promise<void> {
	const refusal = await checkMcpConfigOrganizationAccess(args);
	if (refusal) {
		throw new McpClientError({
			message: refusal.message,
			code: refusal.code,
			serverName: args.serverName,
		});
	}
}

/**
 * The GitLab origin a client for this config connects to: the endpoint's
 * origin for a GitLab personal server (`null` when the endpoint is not an
 * allowed GitLab address), `undefined` for every other server. The endpoint
 * is the one the client is built for (`baseUrl`, else the server default),
 * and a GitLab personal transport keeps every request on it.
 */
function gitlabEndpointOrigin(config: {
	baseUrl?: string | null;
	mcpServer?: unknown;
}): string | null | undefined {
	const server = config.mcpServer as {
		key?: string | null;
		defaultUrl?: string | null;
	} | null;
	if (!isGitLabPersonalMcpConfig({ mcpServer: server })) {
		return undefined;
	}
	const checked = parseGitLabOrigin(config.baseUrl || server?.defaultUrl);
	return checked.ok ? checked.origin : null;
}

/** Refuses a GitLab client bound to another origin than `expected`. */
function assertGitLabOriginExpected(
	expected: string | undefined,
	actual: string | null | undefined,
	serverName: string | undefined,
): void {
	if (expected === undefined || actual === undefined) {
		return;
	}
	if (actual !== expected) {
		throw new McpGitLabOriginMismatchError(serverName);
	}
}

/**
 * Build authentication headers based on auth type and method
 *
 * @param authType - Type of authentication (API_KEY, OAUTH2, NONE)
 * @param token - The token/key to use
 * @param apiKeyMethod - How to send API key: BEARER (Authorization header) or HEADER (X-API-Key)
 */
export function buildAuthHeaders(
	authType: "API_KEY" | "OAUTH2" | "NONE" | string,
	token?: string | null,
	apiKeyMethod: ApiKeyMethod = "BEARER",
): Record<string, string> {
	const headers: Record<string, string> = {};

	if (!token) {
		return headers;
	}

	if (authType === "OAUTH2") {
		// OAuth always uses Bearer token
		headers.Authorization = `Bearer ${token}`;
	} else if (authType === "API_KEY") {
		// API key can be sent via Authorization header or X-API-Key header
		if (apiKeyMethod === "HEADER") {
			headers["X-API-Key"] = token;
		} else if (apiKeyMethod === "PLAIN") {
			headers.Authorization = token;
		} else {
			// Default: BEARER
			headers.Authorization = `Bearer ${token}`;
		}
	}

	return headers;
}

/**
 * MCP servers and AI SDK helpers may expose schemas in either raw JSON Schema
 * form or wrapped as `{ jsonSchema: {...} }`. Normalize both to raw JSON Schema.
 */
export function unwrapMcpInputSchema(
	inputSchema?: Record<string, unknown>,
): Record<string, unknown> {
	if (
		inputSchema &&
		typeof inputSchema === "object" &&
		"jsonSchema" in inputSchema &&
		inputSchema.jsonSchema &&
		typeof inputSchema.jsonSchema === "object"
	) {
		return inputSchema.jsonSchema as Record<string, unknown>;
	}

	return (
		inputSchema ?? {
			type: "object",
			properties: {},
		}
	);
}

/**
 * Whether the guarded MCP fetch refused a redirect.
 *
 * `fetch(url, { redirect: "error" })` rejects with a bare
 * `TypeError: fetch failed` and puts the real reason — `unexpected redirect` —
 * on `cause`, so the top-level message alone cannot tell a redirecting server
 * from an unreachable one. The chain is walked because the transport may wrap
 * the fetch failure again before it reaches us.
 */
function isRedirectRefusal(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; current instanceof Error && depth < 5; depth++) {
		if (current.message.toLowerCase().includes("unexpected redirect")) {
			return true;
		}
		current = current.cause;
	}
	return false;
}

/**
 * The SDK (1.32+) sends its OAuth requests with `redirect: "manual"` and then
 * follows a same-origin redirect itself, re-sending the request. A token
 * request carries a refresh token or authorization code and the client
 * credentials, so for those — and for anything else the SDK sends off the MCP
 * server's own origin — the redirect is refused outright instead
 * (`redirect: "error"`): credentials go to the bound token endpoint and
 * nowhere it points. The MCP server's own requests keep the SDK's
 * same-origin redirect handling.
 */
export function oauthRequestsRefuseRedirects(
	serverUrl: URL,
	baseFetch: GitLabMcpFetch,
): GitLabMcpFetch {
	return (input, init) => {
		let offOrigin = true;
		try {
			offOrigin =
				new URL(typeof input === "string" ? input : input.toString())
					.origin !== serverUrl.origin;
		} catch {
			offOrigin = true;
		}
		const tokenRequest = init?.body instanceof URLSearchParams;
		if (tokenRequest) {
			return baseFetch(input, { ...init, redirect: "error" }).then(
				sanitizeTokenErrorResponse,
			);
		}
		if (offOrigin) {
			return baseFetch(input, { ...init, redirect: "error" });
		}
		return baseFetch(input, init);
	};
}

function jsonError(code: string, status: number): Response {
	return new Response(JSON.stringify({ error: code }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * The SDK turns a token endpoint's error response into the message of the
 * error it throws (`error_description`, or the raw body when it is not an
 * OAuth error), and that error then travels into Fabric's messages, `cause`
 * chains and logs. A token endpoint can echo what it was sent — a refresh
 * token, a code, a client secret — so before the SDK sees an error response
 * it is reduced to the classified `error` code alone (`classifyOAuthErrorCode`;
 * the SDK's error classes still key on it, e.g. `invalid_grant`). A 2xx body
 * that is an OAuth error, or not JSON at all, is reduced the same way.
 * Successful token responses pass through unchanged.
 */
export async function sanitizeTokenErrorResponse(
	response: Response,
): Promise<Response> {
	let text = "";
	try {
		text = await response.clone().text();
	} catch {
		text = "";
	}
	let parsed: unknown = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = null;
	}
	const body =
		parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	if (response.ok) {
		if (!body) {
			return jsonError("server_error", 502);
		}
		if (body.error !== undefined && body.access_token === undefined) {
			return jsonError(classifyOAuthErrorCode(body.error), 400);
		}
		return response;
	}
	return jsonError(
		body && body.error !== undefined
			? classifyOAuthErrorCode(body.error)
			: "server_error",
		response.status,
	);
}

/**
 * Creates an MCP client with the appropriate transport.
 * Uses official MCP SDK transports for better compatibility.
 *
 * @param options.serverUrl - The MCP server URL
 * @param options.transport - Transport type: "HTTP" (Streamable HTTP) or "SSE"
 * @param options.headers - Optional headers (e.g., for authentication)
 * @param options.sessionId - Optional MCP Session ID for stateful connections
 */
export async function createMcpClient(
	options: CreateMcpClientOptions,
): Promise<McpClientType> {
	const {
		serverUrl,
		transport,
		headers = {},
		sessionId,
		authProvider,
		fetch: transportFetch = fetchMcpServer,
	} = options;

	// Validate URL
	let url: URL;
	try {
		url = new URL(serverUrl);
	} catch {
		throw new McpClientError({
			message: `Invalid server URL: ${serverUrl}`,
			code: "INVALID_URL",
		});
	}

	// SSRF guard (SOC 2 CC6.1/CC6.6): the server URL is tenant-supplied and
	// persisted, so refuse internal destinations — cloud metadata, loopback,
	// private ranges — before anything connects. The check resolves the
	// hostname, so a public name that resolves to a private address is
	// refused too. The block is unconditional; the only exception is the
	// operator's MCP_SERVER_ALLOWED_HOSTS (loopback by default outside
	// production, none in production). Nothing in the request can widen it.
	try {
		await assertMcpServerUrlResolved(serverUrl);
	} catch (error) {
		throw new McpClientError({
			message: `MCP server URL is not allowed: ${error instanceof Error ? error.message : String(error)}`,
			code: "BLOCKED_URL",
			cause: error instanceof Error ? error : undefined,
		});
	}

	// Only log in development mode (avoid exposing server details in production)
	if (process.env.NODE_ENV === "development") {
		console.log(
			`[MCP Client] Creating client for ${serverUrl} with transport ${transport}${authProvider ? " (with OAuth)" : ""}`,
		);
	}

	// Build final headers including MCP Session ID if provided
	const finalHeaders = { ...headers };
	if (sessionId) {
		finalHeaders["Mcp-Session-Id"] = sessionId;
	}

	// Helper to create a fresh transport (must be new for each connection
	// attempt). Every request the transport makes — initialize, the SSE
	// stream, each JSON-RPC POST, and on the OAuth path the metadata
	// discovery, token refresh and token exchange the SDK's `auth()` performs
	// — goes through the guarded fetch, which re-checks the destination at
	// DNS-lookup time and refuses redirects. The `@ai-sdk/mcp` transport
	// config is not used for OAuth because it accepts no fetch implementation:
	// the SDK would resolve and connect on its own, and a name that answered
	// a public address to the check above could answer a private one to it.
	const guardedFetch = authProvider
		? oauthRequestsRefuseRedirects(url, transportFetch)
		: transportFetch;
	const createTransport = () => {
		const requestInit =
			Object.keys(finalHeaders).length > 0
				? { headers: finalHeaders }
				: undefined;
		return transport === "SSE"
			? new SSEClientTransport(url, {
					fetch: guardedFetch,
					requestInit,
					authProvider,
				})
			: new StreamableHTTPClientTransport(url, {
					fetch: guardedFetch,
					requestInit,
					authProvider,
				});
	};

	// OAuth: the SDK transport carries the provider, so tokens are attached,
	// refreshed on 401 and, when no valid token can be obtained,
	// `redirectToAuthorization` raises OAuthAuthorizationRequiredError.
	if (authProvider) {
		try {
			return await createMCPClient({
				transport: createTransport(),
			});
		} catch (error) {
			// Check if this is an auth-required error
			if (error instanceof OAuthAuthorizationRequiredError) {
				throw error;
			}
			// Parse and enhance other errors
			const errorMessage =
				error instanceof Error ? error.message : String(error);

			// A refused redirect surfaces as an opaque `TypeError: fetch
			// failed`; the reason is only on the cause chain. Left unmapped it
			// reads as an unreachable server, which sends whoever configured
			// the integration looking for an outage instead of a URL to fix.
			if (isRedirectRefusal(error)) {
				throw new McpClientError({
					message:
						"MCP server redirected the request. Redirects are not followed; configure the server with the URL it redirects to.",
					code: "CONNECTION_ERROR",
					cause: error instanceof Error ? error : undefined,
				});
			}

			if (
				errorMessage.includes("401") ||
				errorMessage.includes("Unauthorized")
			) {
				throw new McpClientError({
					message:
						"OAuth authentication required. Please authenticate in MCP Settings.",
					code: "OAUTH_AUTH_REQUIRED",
					isAuthError: true,
					cause: error instanceof Error ? error : undefined,
				});
			}

			throw new McpClientError({
				message: `Failed to connect to MCP server: ${errorMessage}`,
				code: "CONNECTION_ERROR",
				cause: error instanceof Error ? error : undefined,
			});
		}
	}

	// Non-OAuth (none / API key) path with retries for transient failures.
	// Retry configuration for transient failures
	const MAX_RETRIES = 2;
	const RETRY_DELAY_MS = 1000;
	const CONNECTION_TIMEOUT_MS = 15000; // 15 seconds

	const attemptConnection = async (): Promise<McpClientType> => {
		// Create fresh transport for each attempt (transports cannot be reused)
		const mcpTransport = createTransport();

		const clientPromise = createMCPClient({
			transport: mcpTransport,
		});

		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => {
				reject(
					new McpClientError({
						message: `Connection timeout after ${CONNECTION_TIMEOUT_MS / 1000}s connecting to ${serverUrl}`,
						code: "CONNECTION_TIMEOUT",
					}),
				);
			}, CONNECTION_TIMEOUT_MS);
		});

		return await Promise.race([clientPromise, timeoutPromise]);
	};

	// Helper to check if error is retryable (transient network issues)
	const isRetryableError = (error: unknown): boolean => {
		if (error instanceof Error) {
			const msg = error.message.toLowerCase();
			const cause = (error as { cause?: Error }).cause;
			const causeMsg = cause?.message?.toLowerCase() || "";

			// Retryable: socket closed, connection reset, network errors
			return (
				msg.includes("socket") ||
				msg.includes("fetch failed") ||
				msg.includes("econnreset") ||
				msg.includes("econnrefused") ||
				msg.includes("other side closed") ||
				causeMsg.includes("socket") ||
				causeMsg.includes("other side closed")
			);
		}
		return false;
	};

	let lastError: unknown;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			return await attemptConnection();
		} catch (error) {
			lastError = error;

			// Don't retry non-retryable errors
			if (!isRetryableError(error)) {
				break;
			}

			// Don't retry after last attempt
			if (attempt < MAX_RETRIES) {
				if (process.env.NODE_ENV === "development") {
					console.log(
						`[MCP Client] Retry ${attempt + 1}/${MAX_RETRIES} after transient error`,
					);
				}
				await new Promise((resolve) =>
					setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)),
				);
			}
		}
	}

	// All retries failed, throw the last error with better messaging
	const error = lastError;
	// Parse and re-throw with better error messages
	const errorMessage = error instanceof Error ? error.message : String(error);

	// Check for rate limiting
	if (
		errorMessage.includes("Too many requests") ||
		errorMessage.includes("429")
	) {
		const retryMatch = errorMessage.match(/retryAfter[":]\s*(\d+)/);
		const retryAfter = retryMatch
			? Number.parseInt(retryMatch[1], 10)
			: undefined;
		throw new McpClientError({
			message: `Rate limit exceeded. Please wait ${retryAfter || "a moment"} seconds before retrying.`,
			code: "RATE_LIMIT",
			isRateLimitError: true,
			retryAfter,
			cause: error instanceof Error ? error : undefined,
		});
	}

	// Check for authentication errors
	if (errorMessage.includes("401") || errorMessage.includes("Unauthorized")) {
		throw new McpClientError({
			message:
				"Authentication failed. Please re-authenticate your MCP server in Settings.",
			code: "AUTH_FAILED",
			isAuthError: true,
			cause: error instanceof Error ? error : undefined,
		});
	}

	// Check for OAuth-related errors (the startsWith error)
	if (
		errorMessage.includes("startsWith") ||
		errorMessage.includes("Cannot read properties of undefined")
	) {
		throw new McpClientError({
			message:
				"MCP server authentication error. The server may require OAuth re-authentication.",
			code: "OAUTH_ERROR",
			isAuthError: true,
			cause: error instanceof Error ? error : undefined,
		});
	}

	// Generic connection error
	throw new McpClientError({
		message: `Failed to connect to MCP server: ${errorMessage}`,
		code: "CONNECTION_ERROR",
		cause: error instanceof Error ? error : undefined,
	});
}

/**
 * Creates an MCP client from a stored configuration.
 * Handles authentication and server URL resolution.
 *
 * @param options.configId - The MCP configuration ID
 * @param options.userId - The user ID for authentication
 */
export async function createMcpClientForConfig(
	options: CreateMcpClientForConfigOptions,
): Promise<McpClientForConfig> {
	return buildMcpClientForConfig(options, {
		organizationAccessChecked: false,
	});
}

interface McpClientForConfig {
	client: McpClientType;
	serverName: string;
	serverUrl: string;
	transport: string;
	/** See `gitlabEndpointOrigin`; `undefined` for a non-GitLab server. */
	gitlabOrigin?: string | null;
	/**
	 * For a GitLab personal server over OAuth: the generation of the GitLab
	 * connection whose token the client carries. `undefined` otherwise.
	 */
	gitlabConnectionGeneration?: number;
	/**
	 * For an OAuth2 config served by the database-backed provider: the grant
	 * generation the client was built for. `undefined` otherwise.
	 */
	oauthGrantGeneration?: number;
}

/**
 * `createMcpClientForConfig`, with the organization check skipped only when
 * `getCachedMcpClientForConfig` has just made it for this same call (so an
 * uncached call pays one permission read, not two).
 */
async function buildMcpClientForConfig(
	options: CreateMcpClientForConfigOptions,
	internal: { organizationAccessChecked: boolean },
): Promise<McpClientForConfig> {
	const {
		configId,
		userId,
		organizationId,
		redirectUri,
		onAuthorizationRequired,
	} = options;

	// Avoid logging config IDs in production
	if (process.env.NODE_ENV === "development") {
		console.log("[MCP Client] Creating client for config", { configId });
	}

	// Before the config (and its credential) is read: the owner must still be
	// a member of the organization with a role that allows this access.
	if (!internal.organizationAccessChecked) {
		await assertMcpConfigOrganizationAccess({
			userId,
			organizationId,
			access: options.access,
		});
	}

	const mcpConfig = await getMcpConfigById(configId, {
		userId,
		organizationId,
	});
	if (!mcpConfig) {
		throw new McpClientError({
			message:
				"MCP configuration not found. Please configure your MCP server in Settings.",
			code: "CONFIG_NOT_FOUND",
		});
	}

	if (!mcpConfig.enabled) {
		throw new McpClientError({
			message: `MCP server "${mcpConfig.displayName || "Unknown"}" is disabled. Please enable it in Settings.`,
			code: "CONFIG_DISABLED",
			serverName: mcpConfig.displayName || undefined,
		});
	}

	// Bound to a GitLab PM container's instance: refuse a GitLab server on
	// another one before any token is read or anything is connected.
	const gitlabOrigin = gitlabEndpointOrigin(mcpConfig);
	assertGitLabOriginExpected(
		options.expectedGitLabOrigin,
		gitlabOrigin,
		mcpConfig.displayName || undefined,
	);

	// Read before the breaker gate below, which is auth-type scoped.
	const authType = mcpConfig.authType;

	// The refresh circuit breaker (recordRefreshFailure) flips needsReauth after
	// persistent refresh failures, and only a successful re-auth
	// (a new grant through the connect flow) clears it. Connecting before then would just
	// re-hammer a dead refresh token on every request.
	//
	// Scoped to OAUTH2 deliberately: the flag describes an OAuth GRANT, and the
	// only thing that clears it is an OAuth reconnect. A config edited to
	// API_KEY or NONE keeps whatever flag its OAuth life left on the row, so an
	// unscoped gate would refuse a working API key behind a reconnect flow the
	// config no longer has — with no user-reachable way to clear it. The edit
	// path clears the flag on that transition going forward; this scoping is
	// what rescues rows that already carry a stale one.
	// GitLab personal servers carry no credential of their own (see
	// `./gitlab-credential`): their `needsReauth` column describes a legacy
	// token copy, not the person's GitLab connection, so it does not gate
	// them — the connection's own state does, below. Keyed on the server,
	// not `authType`: an API-key or no-auth config of a GitLab personal
	// server still resolves through the connection and never sends a key
	// stored on its row.
	const isGitLabPersonal = isGitLabPersonalMcpConfig(mcpConfig);
	if (authType === "OAUTH2" && !isGitLabPersonal && mcpConfig.needsReauth) {
		throw new McpClientError({
			message: `Authentication expired for "${mcpConfig.displayName || "MCP server"}". Please re-authenticate in MCP Settings.`,
			code: "OAUTH_AUTH_REQUIRED",
			serverName: mcpConfig.displayName || undefined,
			isAuthError: true,
		});
	}

	const mcpServer = mcpConfig.mcpServer as {
		defaultUrl?: string;
		name?: string;
		transport?: string;
		command?: string;
	} | null;

	// Determine transport type
	const configTransport = mcpConfig.transport?.toString().toUpperCase();
	const serverTransport = mcpServer?.transport?.toUpperCase();
	const transport = configTransport || serverTransport || "HTTP";

	// Handle STDIO transport via wrapper service. Not for a GitLab personal
	// server: the wrapper is handed the config's own stored key, and these
	// configs hold none — their credential is the person's connection, which
	// only travels over HTTP to its own GitLab origin.
	if (transport === "STDIO" && isGitLabPersonal) {
		throw new McpClientError({
			message:
				"GitLab MCP servers connect over HTTP with your GitLab connection; a STDIO transport is not supported for them.",
			code: "OAUTH_AUTH_REQUIRED",
			serverName: mcpConfig.displayName || undefined,
			isAuthError: true,
		});
	}
	if (transport === "STDIO") {
		const stdio = await createStdioMcpClientForConfig({
			configId,
			userId,
			organizationId,
			mcpConfig,
			mcpServer,
		});
		return { ...stdio, gitlabOrigin };
	}

	const serverUrl = mcpConfig.baseUrl || mcpServer?.defaultUrl;
	if (!serverUrl) {
		throw new McpClientError({
			message:
				"No server URL configured. Please update the MCP server configuration in Settings.",
			code: "NO_SERVER_URL",
			serverName: mcpConfig.displayName || mcpServer?.name || undefined,
		});
	}

	const serverName =
		mcpConfig.displayName || mcpServer?.name || "Unknown Server";

	const apiKeyMethod = (mcpConfig.apiKeyMethod as ApiKeyMethod) || "BEARER";

	// Avoid logging auth type in production
	if (process.env.NODE_ENV === "development") {
		console.log(
			`[MCP Client] Server: ${serverName}, Auth type: ${authType}, API Key Method: ${apiKeyMethod}`,
		);
	}

	// GitLab personal servers: the caller's GitLab connection token as a
	// bearer header. `getMcpConfigById` above already scoped the config to
	// this user in this tenant context; `getGitLabMcpTransportAuth` re-checks
	// ownership, refuses an endpoint on another GitLab origin, and hands back
	// the fetch that keeps every request on that origin behind the GitLab
	// outbound guard.
	if (isGitLabPersonal) {
		let gitlabAuth: Awaited<ReturnType<typeof getGitLabMcpTransportAuth>>;
		try {
			gitlabAuth = await getGitLabMcpTransportAuth({
				config: mcpConfig,
				userId,
				organizationId,
				endpoint: serverUrl,
			});
		} catch (error) {
			if (error instanceof GitLabMcpCredentialError) {
				throw new McpClientError({
					message: error.message,
					code: "OAUTH_AUTH_REQUIRED",
					serverName,
					isAuthError: true,
					cause: error,
				});
			}
			throw error;
		}
		const client = await createMcpClient({
			serverUrl,
			transport,
			headers: { Authorization: `Bearer ${gitlabAuth.accessToken}` },
			fetch: gitlabAuth.fetch,
		});
		return {
			client,
			serverName,
			serverUrl,
			transport,
			gitlabOrigin,
			gitlabConnectionGeneration: gitlabAuth.generation,
		};
	}

	// Use AI SDK v7 authProvider for OAuth2 authentication
	// This enables automatic token management and mid-session refresh
	if (authType === "OAUTH2") {
		// Build default redirectUri if not provided
		// This allows OAuth2 configs to work for tool listing without explicit redirectUri
		const effectiveRedirectUri =
			redirectUri ||
			`${process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3001"}/api/mcp/oauth/callback`;

		try {
			const authProvider = await createOAuthClientProvider({
				configId,
				userId,
				organizationId,
				redirectUri: effectiveRedirectUri,
				onAuthorizationRequired,
				// The grant of the same read `serverUrl` came from: the
				// provider refuses a row that has moved on since.
				expectedGrantGeneration: mcpConfig.oauthGrantGeneration,
			});

			const client = await createMcpClient({
				serverUrl,
				transport,
				authProvider,
			});

			return {
				client,
				serverName,
				serverUrl,
				transport,
				gitlabOrigin,
				oauthGrantGeneration: mcpConfig.oauthGrantGeneration,
			};
		} catch (error) {
			// Re-throw OAuth authorization required errors
			if (error instanceof OAuthAuthorizationRequiredError) {
				throw error;
			}
			if (error instanceof McpClientError) {
				error.serverName ?? serverName;
				throw error;
			}
			throw new McpClientError({
				message: `OAuth connection failed for "${serverName}": ${error instanceof Error ? error.message : "Unknown error"}`,
				code: "OAUTH_CONNECTION_ERROR",
				serverName,
				isAuthError: true,
				cause: error instanceof Error ? error : undefined,
			});
		}
	}

	// API_KEY auth: use header-based authentication
	let headers: Record<string, string> = {};

	if (authType === "API_KEY") {
		try {
			const accessToken = await getValidAccessToken({
				configId,
				userId,
				organizationId,
			});

			if (accessToken) {
				// Build auth headers using the appropriate method
				headers = buildAuthHeaders(authType, accessToken, apiKeyMethod);
			} else {
				throw new McpClientError({
					message: `API key not configured for "${serverName}". Please add your API key in MCP Settings.`,
					code: "API_KEY_MISSING",
					serverName,
					isAuthError: true,
				});
			}
		} catch (error) {
			if (error instanceof McpClientError) {
				throw error;
			}
			console.error(
				`[MCP Client] Failed to get API key for ${serverName}:`,
				error,
			);
			throw new McpClientError({
				message: `Authentication error for "${serverName}": ${error instanceof Error ? error.message : "Unknown error"}`,
				code: "AUTH_ERROR",
				serverName,
				isAuthError: true,
				cause: error instanceof Error ? error : undefined,
			});
		}
	}
	// NONE auth type: no headers needed

	try {
		const client = await createMcpClient({
			serverUrl,
			transport,
			headers,
		});

		return {
			client,
			serverName,
			serverUrl,
			transport,
			gitlabOrigin,
		};
	} catch (error) {
		// Enhance error with server name context
		if (error instanceof McpClientError) {
			error.serverName ?? serverName;
			throw error;
		}
		throw new McpClientError({
			message: `Failed to connect to "${serverName}": ${error instanceof Error ? error.message : "Unknown error"}`,
			code: "CONNECTION_ERROR",
			serverName,
			cause: error instanceof Error ? error : undefined,
		});
	}
}

/**
 * Safely closes an MCP client
 *
 * @param client - The MCP client to close (can be undefined)
 */
export async function closeMcpClient(
	client: McpClientType | undefined,
): Promise<void> {
	if (client) {
		try {
			await client.close();
		} catch {
			// Ignore close errors
		}
	}
}

// =============================================================================
// MCP Client Cache - Worker-level caching for performance
// =============================================================================

interface CachedMcpClient {
	client: McpClientType;
	serverName: string;
	serverUrl: string;
	transport: string;
	/** The GitLab origin the client is bound to (see `gitlabEndpointOrigin`). */
	gitlabOrigin?: string | null;
	/**
	 * Set for a GitLab personal server's client, which carries the person's
	 * GitLab connection token as a fixed bearer header: the connection
	 * generation of that token. Such a client is re-checked before every
	 * cached use (`isCachedGitLabClientUsable`).
	 */
	gitlabConnectionGeneration?: number;
	/**
	 * Set for an OAuth2 client built on the database-backed provider: the
	 * config's grant generation at build time. A client whose config has
	 * since been reconnected, revoked or re-registered is dropped before use
	 * (its provider would refuse every call anyway).
	 */
	oauthGrantGeneration?: number;
	createdAt: number;
	lastUsedAt: number;
}

// Cache MCP clients by configId+userId to avoid reconnecting per step
const mcpClientCache = new Map<string, CachedMcpClient>();

// Cache TTL in milliseconds (10 minutes - long enough for agent loop executions)
const MCP_CLIENT_CACHE_TTL = 10 * 60 * 1000;

// Maximum cache size
const MCP_CLIENT_CACHE_MAX_SIZE = 20;

/**
 * Get cache key for MCP client
 * Includes organizationId to ensure proper tenant isolation
 */
function getMcpCacheKey(
	configId: string,
	userId: string,
	organizationId?: string,
): string {
	return `${configId}:${userId}:${organizationId ?? "personal"}`;
}

/**
 * Creates or retrieves a cached MCP client for a configuration.
 * This significantly improves performance for multi-step workflows
 * by reusing connections instead of reconnecting per step.
 *
 * @param options.configId - The MCP configuration ID
 * @param options.userId - The user ID for authentication
 * @param options.organizationId - The organization ID for tenant isolation (optional)
 * @param options.forceNew - Force creating a new connection (default: false)
 */
export async function getCachedMcpClientForConfig(
	options: CreateMcpClientForConfigOptions & { forceNew?: boolean },
): Promise<{
	client: McpClientType;
	serverName: string;
	serverUrl: string;
	transport: string;
	gitlabOrigin?: string | null;
	fromCache: boolean;
}> {
	const {
		configId,
		userId,
		organizationId,
		forceNew = false,
		redirectUri,
		onAuthorizationRequired,
		expectedGitLabOrigin,
		access,
	} = options;
	const cacheKey = getMcpCacheKey(configId, userId, organizationId);
	// Set once this call has passed the organization check, so a client built
	// below (after a cached one was dropped) does not ask again.
	let organizationAccessChecked = false;

	// Check cache first (unless forcing new)
	if (!forceNew) {
		let cached = mcpClientCache.get(cacheKey);
		// Every server's cached client is re-checked against the owner's
		// current organization role before it is used: membership or a role
		// can be lost while the client sits in the cache. A refused (or
		// unprovable: the read failed) client is closed and dropped, and the
		// call fails as an uncached call would.
		if (cached) {
			try {
				await assertMcpConfigOrganizationAccess({
					userId,
					organizationId,
					access,
					serverName: cached.serverName,
				});
				organizationAccessChecked = true;
			} catch (error) {
				// Only this entry: a concurrent call may already have
				// replaced it with a freshly built client.
				if (mcpClientCache.get(cacheKey) === cached) {
					mcpClientCache.delete(cacheKey);
				}
				try {
					await cached.client.close();
				} catch {
					// Ignore close errors
				}
				throw error;
			}
		}
		// A GitLab personal server's client keeps the token it was built
		// with for the whole cache lifetime. Once the caller has left the
		// config's organization, the config is turned off (the tile's
		// Delete), or the connection is disconnected, needs reconnecting or
		// was replaced by a reconnect, that client must not be used again:
		// it is closed and dropped here, and the connection is built anew
		// below, which refuses a non-member, a disabled config or an
		// unusable connection with the same errors as an uncached call. A
		// check that could not be made (a read failed) drops it the same
		// way: an unproven client is never reused.
		if (cached && cached.gitlabConnectionGeneration !== undefined) {
			let usable = false;
			try {
				usable = await isCachedGitLabClientUsable({
					configId,
					userId,
					organizationId,
					generation: cached.gitlabConnectionGeneration,
				});
			} catch (error) {
				console.warn(
					`[MCP Client Cache] Could not re-check the cached GitLab client for ${cached.serverName}; dropping it`,
					error instanceof Error ? error.message : error,
				);
			}
			if (!usable) {
				// Only this entry: a concurrent call may already have
				// replaced it with a freshly built client.
				if (mcpClientCache.get(cacheKey) === cached) {
					mcpClientCache.delete(cacheKey);
				}
				try {
					await cached.client.close();
				} catch {
					// Ignore close errors
				}
				cached = undefined;
			}
		}
		// An OAuth2 client serves the grant it was built for. Once the config's
		// credentials changed (reconnect, revoke, re-registration), drop it so
		// the next client is built on the current grant. A failed read drops
		// it too: an unproven client is never reused.
		if (cached && cached.oauthGrantGeneration !== undefined) {
			let current: number | null = null;
			try {
				current = await getMcpOAuthGrantGeneration(configId);
			} catch (error) {
				console.warn(
					`[MCP Client Cache] Could not re-check the cached OAuth client for ${cached.serverName}; dropping it`,
					error instanceof Error ? error.message : error,
				);
			}
			if (current !== cached.oauthGrantGeneration) {
				if (mcpClientCache.get(cacheKey) === cached) {
					mcpClientCache.delete(cacheKey);
				}
				try {
					await cached.client.close();
				} catch {
					// Ignore close errors
				}
				cached = undefined;
			}
		}
		if (cached) {
			// A cached client stays bound to the instance it was built for,
			// even after the config or the connection moved. Refuse it for a
			// caller bound elsewhere before it is used (the health check
			// below already sends a request).
			assertGitLabOriginExpected(
				expectedGitLabOrigin,
				cached.gitlabOrigin,
				cached.serverName,
			);
			const age = Date.now() - cached.createdAt;
			const timeSinceLastUse = Date.now() - cached.lastUsedAt;

			if (age < MCP_CLIENT_CACHE_TTL) {
				// If the connection was used recently (within 30 seconds), assume it's still alive
				// MCP servers typically have idle timeouts of 30-60 seconds
				const HEALTH_CHECK_THRESHOLD_MS = 30 * 1000;

				if (timeSinceLastUse < HEALTH_CHECK_THRESHOLD_MS) {
					// Recently used - assume healthy
					cached.lastUsedAt = Date.now();
					return {
						client: cached.client,
						serverName: cached.serverName,
						serverUrl: cached.serverUrl,
						transport: cached.transport,
						gitlabOrigin: cached.gitlabOrigin,
						fromCache: true,
					};
				}

				// Not recently used - validate the connection is still alive
				// This prevents using stale connections that will fail during tool execution
				try {
					// Use a short timeout for the health check
					const healthCheckPromise = cached.client.tools();
					const timeoutPromise = new Promise<never>((_, reject) => {
						setTimeout(
							() => reject(new Error("Health check timeout")),
							3000,
						);
					});
					await Promise.race([healthCheckPromise, timeoutPromise]);

					// Connection is healthy - update last used time and return
					cached.lastUsedAt = Date.now();
					return {
						client: cached.client,
						serverName: cached.serverName,
						serverUrl: cached.serverUrl,
						transport: cached.transport,
						gitlabOrigin: cached.gitlabOrigin,
						fromCache: true,
					};
				} catch {
					// Connection is stale - invalidate and create new
					console.log(
						`[MCP Client Cache] Cached connection to ${cached.serverName} is stale, creating new connection`,
					);
					try {
						await cached.client.close();
					} catch {
						// Ignore close errors
					}
					mcpClientCache.delete(cacheKey);
					// Fall through to create new connection
				}
			} else {
				// Expired - close and remove
				try {
					await cached.client.close();
				} catch {
					// Ignore close errors
				}
				mcpClientCache.delete(cacheKey);
			}
		}
	}

	// Evict old entries if cache is full
	if (mcpClientCache.size >= MCP_CLIENT_CACHE_MAX_SIZE) {
		// Find and remove least recently used
		let oldestKey: string | null = null;
		let oldestTime = Date.now();
		for (const [key, entry] of mcpClientCache) {
			if (entry.lastUsedAt < oldestTime) {
				oldestTime = entry.lastUsedAt;
				oldestKey = key;
			}
		}
		if (oldestKey) {
			const old = mcpClientCache.get(oldestKey);
			if (old) {
				try {
					await old.client.close();
				} catch {
					// Ignore
				}
			}
			mcpClientCache.delete(oldestKey);
		}
	}

	// Create new client with proper error handling
	try {
		const result = await buildMcpClientForConfig(
			{
				configId,
				userId,
				organizationId,
				redirectUri,
				onAuthorizationRequired,
				expectedGitLabOrigin,
				access,
			},
			{ organizationAccessChecked },
		);

		// Cache it
		mcpClientCache.set(cacheKey, {
			client: result.client,
			serverName: result.serverName,
			serverUrl: result.serverUrl,
			transport: result.transport,
			gitlabOrigin: result.gitlabOrigin,
			gitlabConnectionGeneration: result.gitlabConnectionGeneration,
			oauthGrantGeneration: result.oauthGrantGeneration,
			createdAt: Date.now(),
			lastUsedAt: Date.now(),
		});

		return {
			...result,
			fromCache: false,
		};
	} catch (error) {
		// Log but don't crash - let the caller handle the error
		console.error(
			"[MCP Client Cache] Failed to create client for config:",
			{ configId },
			error,
		);
		throw error;
	}
}

/**
 * Clear the MCP client cache (useful for cleanup or testing)
 */
export async function clearMcpClientCache(): Promise<void> {
	for (const [, entry] of mcpClientCache) {
		try {
			await entry.client.close();
		} catch {
			// Ignore close errors
		}
	}
	mcpClientCache.clear();
}

/**
 * Invalidate a specific MCP client cache entry by config ID and tenant context.
 * This should be called when tool execution fails to force a fresh connection on next use.
 *
 * @param configId - The MCP configuration ID
 * @param userId - The user ID
 * @param organizationId - The organization ID (optional)
 */
export async function invalidateMcpClientCache(
	configId: string,
	userId: string,
	organizationId?: string,
): Promise<void> {
	const cacheKey = getMcpCacheKey(configId, userId, organizationId);
	const cached = mcpClientCache.get(cacheKey);
	if (cached) {
		console.log("[MCP Client Cache] Invalidating cache", {
			serverName: cached.serverName,
			configId,
		});
		try {
			await cached.client.close();
		} catch {
			// Ignore close errors
		}
		mcpClientCache.delete(cacheKey);
	}
}

/**
 * Get MCP client cache stats (for debugging)
 */
export function getMcpClientCacheStats(): {
	size: number;
	maxSize: number;
	ttlMs: number;
	entries: Array<{ key: string; serverName: string; ageMs: number }>;
} {
	const now = Date.now();
	return {
		size: mcpClientCache.size,
		maxSize: MCP_CLIENT_CACHE_MAX_SIZE,
		ttlMs: MCP_CLIENT_CACHE_TTL,
		entries: Array.from(mcpClientCache.entries()).map(([key, entry]) => ({
			key,
			serverName: entry.serverName,
			ageMs: now - entry.createdAt,
		})),
	};
}

// =============================================================================
// STDIO Transport Support via HTTP Wrapper
// =============================================================================

/**
 * STDIO MCP Wrapper Client
 *
 * This client wraps STDIO-based MCP servers by routing calls through
 * the mcp-stdio-wrapper HTTP service. This enables multi-user support
 * with proper tenant isolation for STDIO servers like Azure DevOps.
 *
 * The wrapper handles:
 * - Process spawning with credential injection via env vars
 * - Process pooling and lifecycle management
 * - JSON-RPC message passing
 */
interface StdioWrapperClient {
	tools(): Promise<unknown>;
	callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
	readResource(uri: string): Promise<unknown>;
	listResources(cursor?: string): Promise<unknown>;
	close(): Promise<void>;
}

/**
 * Google's authorization server and token endpoint, as pinned for Google in
 * Fabric's provider table (`PINNED_OAUTH_PROVIDERS` in
 * packages/api/modules/mcp/lib/oauth-authorization-server.ts) and allowlisted
 * by the binding backfill: where the Google Drive STDIO server refreshes.
 */
const GOOGLE_PINNED_OAUTH = {
	authorizationServerUrl: "https://accounts.google.com",
	tokenEndpoint: "https://oauth2.googleapis.com/token",
} as const;

/**
 * Configuration for STDIO MCP client creation
 */
interface CreateStdioMcpClientOptions {
	configId: string;
	userId: string;
	organizationId?: string;
	mcpConfig: {
		displayName?: string | null;
		encryptedApiKey?: string | null;
		apiKeyMethod?: string | null;
		commandArgs?: string[] | null;
		authType?: string | null;
		oauthClientId?: string | null;
		encryptedOauthClientSecret?: string | null;
		encryptedAccessToken?: string | null;
		encryptedRefreshToken?: string | null;
		tokenExpiresAt?: Date | null;
		oauthBinding?: unknown;
		oauthGrantGeneration?: number;
	};
	mcpServer: {
		name?: string;
		command?: string;
	} | null;
}

/**
 * Creates a client for STDIO-based MCP servers via the wrapper service.
 *
 * The wrapper service (mcp-stdio-wrapper) runs as a sidecar/internal service
 * and handles process spawning with proper credential isolation.
 */
async function createStdioMcpClientForConfig(
	options: CreateStdioMcpClientOptions,
): Promise<{
	client: McpClientType;
	serverName: string;
	serverUrl: string;
	transport: string;
}> {
	const { configId, userId, organizationId, mcpConfig, mcpServer } = options;

	const serverName =
		mcpConfig.displayName || mcpServer?.name || "Unknown STDIO Server";
	const command = mcpServer?.command;

	if (!command) {
		throw new McpClientError({
			message: `No command configured for STDIO server "${serverName}". The server definition must include a command field.`,
			code: "NO_STDIO_COMMAND",
			serverName,
		});
	}

	if (mcpConfig.authType === "OAUTH2" && !mcpConfig.encryptedAccessToken) {
		throw new McpClientError({
			message: `Authentication required for "${serverName}". Please authenticate in MCP Settings.`,
			code: "OAUTH_AUTH_REQUIRED",
			serverName,
			isAuthError: true,
		});
	}

	// Get the wrapper service URL
	const wrapperUrl = process.env.MCP_STDIO_WRAPPER_URL;
	if (!wrapperUrl) {
		throw new McpClientError({
			message:
				"MCP_STDIO_WRAPPER_URL environment variable is not configured. STDIO MCP servers require the wrapper service.",
			code: "STDIO_WRAPPER_NOT_CONFIGURED",
			serverName,
		});
	}

	// Get credentials (API key/PAT) for the server
	let credentials: Record<string, string> = {};
	if (mcpConfig.encryptedApiKey) {
		// Decrypt the API key
		const { decryptApiKey } = await import("@repo/utils");
		const decryptedKey = decryptApiKey(mcpConfig.encryptedApiKey);

		// The credential environment variable name depends on the server
		// For Azure DevOps, it's ADO_MCP_AUTH_TOKEN (per their auth.ts)
		if (command.includes("azure-devops")) {
			credentials = { ADO_MCP_AUTH_TOKEN: decryptedKey };
		} else if (command.includes("github")) {
			credentials = { GITHUB_TOKEN: decryptedKey };
		} else if (command.includes("figma")) {
			credentials = { FIGMA_API_KEY: decryptedKey };
		} else if (
			command.includes("server-slack") ||
			command.includes("slack")
		) {
			credentials = { SLACK_BOT_TOKEN: decryptedKey };
			// @modelcontextprotocol/server-slack also requires SLACK_TEAM_ID
			// Fetch it from Slack's auth.test API using the bot token
			try {
				const authResponse = await fetch(
					"https://slack.com/api/auth.test",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/x-www-form-urlencoded",
							Authorization: `Bearer ${decryptedKey}`,
						},
					},
				);
				const authData = (await authResponse.json()) as {
					ok: boolean;
					team_id?: string;
				};
				if (authData.ok && authData.team_id) {
					credentials.SLACK_TEAM_ID = authData.team_id;
				}
			} catch (e) {
				console.warn("[MCP Client] Failed to fetch Slack team_id:", e);
			}
		} else {
			// Generic fallback - use API_KEY
			credentials = { API_KEY: decryptedKey };
		}
	}

	// Handle Google Drive OAuth2 credentials
	// The @modelcontextprotocol/server-gdrive package expects file-based credentials:
	// - GDRIVE_OAUTH_PATH: JSON with {installed: {client_id, client_secret, redirect_uris}}
	// - GDRIVE_CREDENTIALS_PATH: JSON with {access_token, refresh_token, token_type, expiry_date}
	if (
		mcpConfig.authType === "OAUTH2" &&
		command.includes("server-gdrive") &&
		mcpConfig.encryptedAccessToken
	) {
		const { decryptApiKey } = await import("@repo/utils");

		// The wrapper's server refreshes with the client secret and refresh
		// token on its own, so both are handed over only for a grant bound
		// to its authorization server and still the credential set that
		// binding was written with (`credentialFingerprint`). A mismatch —
		// a writer outside the credential module replaced one of them —
		// sends nothing and flags the config for reconnect. An unbound or
		// bearer-only grant gets the access token alone, as the HTTP
		// transports serve it.
		const binding = parseMcpOAuthBinding(mcpConfig.oauthBinding);
		const storedCredentials = {
			oauthClientId: mcpConfig.oauthClientId ?? null,
			encryptedOauthClientSecret:
				mcpConfig.encryptedOauthClientSecret ?? null,
			encryptedRefreshToken: mcpConfig.encryptedRefreshToken ?? null,
		};
		if (
			binding &&
			!credentialFingerprintMatches(binding, storedCredentials)
		) {
			await markMcpOAuthReconnectRequired({
				configId,
				expectedGeneration: mcpConfig.oauthGrantGeneration ?? 0,
				reason: "Reconnect required: the stored OAuth credentials do not match the connection they were bound with.",
			});
			throw new McpClientError({
				message: `Authentication required for "${serverName}". Please reconnect it in MCP Settings.`,
				code: "OAUTH_AUTH_REQUIRED",
				serverName,
				isAuthError: true,
			});
		}
		// The child process refreshes at Google's token endpoint, which it
		// chooses itself: hand it the secret and refresh token only for a
		// binding that names exactly that AS and endpoint (Fabric's pinned
		// Google entry). A grant bound anywhere else gets the access token
		// alone.
		const handOverRefreshCredentials =
			!!binding &&
			sameAuthorizationServer(
				binding.authorizationServerUrl,
				GOOGLE_PINNED_OAUTH.authorizationServerUrl,
			) &&
			binding.tokenEndpoint === GOOGLE_PINNED_OAUTH.tokenEndpoint;

		// Build OAuth client keys JSON
		const clientSecret =
			handOverRefreshCredentials && mcpConfig.encryptedOauthClientSecret
				? decryptApiKey(mcpConfig.encryptedOauthClientSecret)
				: "";
		const oauthKeys = {
			web: {
				client_id: mcpConfig.oauthClientId ?? "",
				client_secret: clientSecret,
				redirect_uris: ["http://localhost"],
			},
		};

		// Build credentials (tokens) JSON
		const accessToken = decryptApiKey(mcpConfig.encryptedAccessToken);
		const refreshToken =
			handOverRefreshCredentials && mcpConfig.encryptedRefreshToken
				? decryptApiKey(mcpConfig.encryptedRefreshToken)
				: "";
		const creds = {
			access_token: accessToken,
			refresh_token: refreshToken,
			token_type: "Bearer",
			expiry_date: mcpConfig.tokenExpiresAt?.getTime() ?? null,
		};

		// Pass JSON content to the wrapper instead of file paths.
		// The wrapper will materialize these into temp files on its own filesystem.
		credentials = {
			...credentials,
			__GDRIVE_OAUTH_KEYS_JSON: JSON.stringify(oauthKeys),
			__GDRIVE_CREDENTIALS_JSON: JSON.stringify(creds),
		};

		console.log(
			"[MCP Client] Google Drive creds prepared (JSON content):",
			{
				hasAccessToken: !!accessToken,
				hasRefreshToken: !!refreshToken,
				tokenExpiry: mcpConfig.tokenExpiresAt?.toISOString(),
				oauthClientId: mcpConfig.oauthClientId ? "present" : "missing",
				clientSecret: clientSecret ? "present" : "missing",
			},
		);
	}

	if (process.env.NODE_ENV === "development") {
		console.log(
			`[MCP Client] Creating STDIO client for ${serverName} via wrapper at ${wrapperUrl}`,
		);
	}

	// Get command arguments (e.g., organization name for Azure DevOps)
	let args = mcpConfig.commandArgs || [];

	// For Azure DevOps with PAT auth, add --authentication envvar flag
	// This prevents the server from launching a browser for interactive auth
	if (command.includes("azure-devops") && mcpConfig.encryptedApiKey) {
		// Only add if not already present
		if (!args.includes("--authentication")) {
			args = [...args, "--authentication", "envvar"];
			if (process.env.NODE_ENV === "development") {
				console.log(
					"[MCP Client] Added --authentication envvar flag for Azure DevOps",
				);
			}
		}
	}

	// Create a wrapper client that routes calls to the HTTP wrapper service
	const wrapperClient = createStdioWrapperClient({
		wrapperUrl,
		command,
		args,
		userId,
		organizationId,
		configId,
		credentials,
		serverName,
	});

	// Cast to McpClientType - the wrapper client implements the same interface
	return {
		client: wrapperClient as unknown as McpClientType,
		serverName,
		serverUrl: wrapperUrl,
		transport: "STDIO",
	};
}

/**
 * Normalize args for the Excalidraw MCP server's `create_view` tool.
 *
 * The server expects `elements` as a JSON-**string**, not an array.
 * LLMs often pass an array directly, which causes a -32602 validation error.
 */
function normalizeExcalidrawCreateViewArgs(
	args: Record<string, unknown>,
): Record<string, unknown> {
	const elements = args.elements;
	if (Array.isArray(elements)) {
		return { ...args, elements: JSON.stringify(elements) };
	}
	// Already a string — pass through unchanged
	return args;
}

/**
 * Coerce tool arguments to match the expected JSON Schema types.
 *
 * LLMs commonly output wrong types for tool arguments:
 * - Arrays as stringified JSON: `"[\"Fabric\"]"` instead of `["Fabric"]`
 * - Numbers as strings: `"20"` instead of `20`
 * - Booleans as strings: `"true"` instead of `true`
 * - Objects as stringified JSON: `"{\"key\":\"val\"}"` instead of `{key: "val"}`
 *
 * This function uses the JSON Schema property definitions to coerce values
 * to their expected types before passing them to the MCP server.
 */
function coerceToolArguments(
	args: Record<string, unknown>,
	schema: Record<string, unknown>,
): Record<string, unknown> {
	const properties = (
		schema as { properties?: Record<string, Record<string, unknown>> }
	).properties;
	if (!properties) {
		return args;
	}

	const coerced = { ...args };
	for (const [key, value] of Object.entries(coerced)) {
		const propSchema = properties[key];
		if (!propSchema || value === null || value === undefined) {
			continue;
		}

		const expectedType = propSchema.type as string | undefined;

		if (expectedType === "array" && typeof value === "string") {
			try {
				const parsed = JSON.parse(value);
				if (Array.isArray(parsed)) {
					coerced[key] = parsed;
				} else {
					// Parsed but not an array (e.g., a number or object) — wrap in array
					coerced[key] = [parsed];
				}
			} catch {
				// Not valid JSON — LLM sent a plain string like "Fabric"
				// instead of ["Fabric"]. Wrap single value in an array.
				coerced[key] = [value];
			}
		} else if (expectedType === "array" && !Array.isArray(value)) {
			// Non-string, non-array value (e.g., number) — wrap in array
			coerced[key] = [value];
		} else if (
			(expectedType === "number" || expectedType === "integer") &&
			typeof value === "string"
		) {
			const num = Number(value);
			if (!Number.isNaN(num)) {
				coerced[key] = num;
			}
		} else if (expectedType === "boolean" && typeof value === "string") {
			if (value === "true") {
				coerced[key] = true;
			} else if (value === "false") {
				coerced[key] = false;
			}
		} else if (expectedType === "object" && typeof value === "string") {
			try {
				const parsed = JSON.parse(value);
				if (
					typeof parsed === "object" &&
					parsed !== null &&
					!Array.isArray(parsed)
				) {
					coerced[key] = parsed;
				}
			} catch {
				// Not valid JSON - leave as-is
			}
		}
	}

	return coerced;
}

/**
 * Create a wrapper client that routes MCP calls to the HTTP wrapper service.
 * Returns tools in AI SDK compatible format with proper schema and execute functions.
 */
function createStdioWrapperClient(options: {
	wrapperUrl: string;
	command: string;
	args: string[];
	userId: string;
	organizationId?: string;
	configId: string;
	credentials: Record<string, string>;
	serverName: string;
}): StdioWrapperClient {
	const {
		wrapperUrl,
		command,
		args,
		userId,
		organizationId,
		configId,
		credentials,
		serverName,
	} = options;

	/**
	 * Make a request to the wrapper service.
	 */
	async function callWrapper(
		method: string,
		params?: unknown,
	): Promise<unknown> {
		// Build headers - include internal API key if configured
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		const internalApiKey = process.env.MCP_WRAPPER_API_KEY;
		if (internalApiKey) {
			headers["x-internal-api-key"] = internalApiKey;
		}

		let response: Response;
		try {
			response = await fetch(`${wrapperUrl}/mcp/call`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					command,
					args,
					method,
					params,
					userId,
					organizationId: organizationId ?? null,
					configId,
					credentials,
				}),
			});
		} catch (error) {
			throw new McpClientError({
				message: `MCP STDIO wrapper service is not reachable at ${wrapperUrl}. Ensure the mcp-stdio-wrapper service is running. Original error: ${error instanceof Error ? error.message : String(error)}`,
				code: "STDIO_WRAPPER_UNREACHABLE",
				serverName,
				cause: error instanceof Error ? error : undefined,
			});
		}

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new McpClientError({
				message: `STDIO wrapper error: ${(error as { error?: string }).error || response.statusText}`,
				code: "STDIO_WRAPPER_ERROR",
				serverName,
			});
		}

		const result = (await response.json()) as {
			success: boolean;
			result?: unknown;
			error?: string;
		};
		if (!result.success) {
			throw new McpClientError({
				message: `MCP call failed: ${result.error || "Unknown error"}`,
				code: "MCP_CALL_FAILED",
				serverName,
			});
		}

		return result.result;
	}

	return {
		async tools(): Promise<Record<string, unknown>> {
			// Import AI SDK helpers - use dynamicTool + jsonSchema from @ai-sdk/provider-utils
			// (re-exported via "ai") to match exactly how @ai-sdk/mcp creates tools internally
			const { dynamicTool, jsonSchema } = await import("ai");

			// MCP protocol returns: { tools: [{ name, description, inputSchema, _meta? }, ...] }
			const result = (await callWrapper("tools/list", {})) as {
				tools?: Array<{
					name: string;
					description?: string;
					inputSchema?: Record<string, unknown>;
					_meta?: { ui?: { resourceUri?: string } };
				}>;
			};

			// Convert MCP format to AI SDK tool format
			// Uses the same pattern as @ai-sdk/mcp's createMCPClient.tools()
			const toolsMap: Record<string, unknown> = {};
			if (result?.tools && Array.isArray(result.tools)) {
				for (const mcpTool of result.tools) {
					const originalJsonSchema = unwrapMcpInputSchema(
						mcpTool.inputSchema,
					);

					const toolName = mcpTool.name;

					// Patch create_view: the MCP server may declare `elements` as a JSON
					// string, or the schema may be incomplete. The AI SDK strips array
					// values for string-typed fields, which produces args: {}. Always
					// expose `elements` as a required array so the LLM can emit it
					// naturally; normalizeExcalidrawCreateViewArgs() converts it to the
					// server's expected JSON string before the MCP call.
					let patchedSchema: Record<string, unknown> =
						originalJsonSchema;
					if (toolName === "create_view") {
						const props = ((originalJsonSchema as any).properties ??
							{}) as Record<string, Record<string, unknown>>;
						const existingDesc = props.elements?.description as
							| string
							| undefined;
						const required = Array.isArray(
							(originalJsonSchema as any).required,
						)
							? ([
									...(originalJsonSchema as any).required,
								] as string[])
							: [];
						if (!required.includes("elements")) {
							required.push("elements");
						}
						patchedSchema = {
							...originalJsonSchema,
							type: "object",
							properties: {
								...props,
								elements: {
									type: "array",
									items: { type: "object" },
									description:
										existingDesc ||
										"Array of Excalidraw elements to render (rectangles, arrows, text, etc.)",
								},
							},
							required,
						};
					}

					const aiSdkTool = dynamicTool({
						description: mcpTool.description || `Tool: ${toolName}`,
						inputSchema: jsonSchema({
							...patchedSchema,
							properties: (patchedSchema as any).properties ?? {},
							additionalProperties: false,
						}),
						execute: async (toolArgs: unknown) => {
							// Coerce arguments to match expected schema types
							// LLMs often output strings for arrays/numbers/booleans
							let coercedArgs = coerceToolArguments(
								toolArgs as Record<string, unknown>,
								originalJsonSchema,
							);
							// Normalize Excalidraw create_view args — LLMs generate minimal
							// element objects but the server requires ~20 required fields each.
							if (
								toolName === "create_view" &&
								(coercedArgs as Record<string, unknown>)
									.elements
							) {
								coercedArgs = normalizeExcalidrawCreateViewArgs(
									coercedArgs as Record<string, unknown>,
								) as typeof coercedArgs;
							}
							// Call the tool via the wrapper service
							const toolResult = await callWrapper("tools/call", {
								name: toolName,
								arguments: coercedArgs,
							});
							return toolResult;
						},
					});

					// Preserve _meta from the raw MCP tool definition for MCP App support.
					// MCP Apps declare ui:// resource URIs via _meta.ui.resourceUri.
					if (mcpTool._meta) {
						(
							aiSdkTool as unknown as Record<string, unknown>
						)._meta = mcpTool._meta;
					}

					toolsMap[toolName] = aiSdkTool;
				}
			}
			return toolsMap;
		},

		async callTool(
			name: string,
			toolArgs: Record<string, unknown>,
		): Promise<unknown> {
			return callWrapper("tools/call", { name, arguments: toolArgs });
		},

		async readResource(uri: string): Promise<unknown> {
			return callWrapper("resources/read", { uri });
		},

		async listResources(cursor?: string): Promise<unknown> {
			return callWrapper("resources/list", cursor ? { cursor } : {});
		},

		async close(): Promise<void> {
			// The wrapper handles process lifecycle and credential cleanup via TTL mechanism.
		},
	};
}
