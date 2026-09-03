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

import { createMCPClient, type OAuthClientProvider } from "@ai-sdk/mcp";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getMcpConfigById, getValidAccessToken } from "@repo/database";
import { getUnsafeUrlReason } from "@repo/utils/url-security";
import {
	createOAuthClientProvider,
	OAuthAuthorizationRequiredError,
} from "./oauth-provider";

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

	// SSRF guard (SOC 2 CC6.1/CC6.6): the server URL is tenant-supplied, so
	// block connections to internal/private hosts (cloud metadata, loopback,
	// private ranges) before we connect. Covers the HTTP and SSE transports and
	// the OAuth authProvider path (all use serverUrl). Gated so self-hosted
	// deployments can still reach private/localhost MCP servers: enforced only
	// in production, and overridable with MCP_ALLOW_PRIVATE_URLS=true.
	if (
		process.env.NODE_ENV === "production" &&
		process.env.MCP_ALLOW_PRIVATE_URLS !== "true"
	) {
		const unsafeReason = getUnsafeUrlReason(serverUrl);
		if (unsafeReason) {
			throw new McpClientError({
				message: `MCP server URL is not allowed: ${unsafeReason}`,
				code: "BLOCKED_URL",
			});
		}
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

	// If authProvider is provided, use the transport config pattern for AI SDK v6
	// This enables automatic token management and refresh
	if (authProvider) {
		const transportConfig = {
			type: (transport === "SSE" ? "sse" : "http") as "sse" | "http",
			url: serverUrl,
			headers:
				Object.keys(finalHeaders).length > 0 ? finalHeaders : undefined,
			authProvider,
		};

		try {
			return await createMCPClient({
				transport: transportConfig,
			});
		} catch (error) {
			// Check if this is an auth-required error
			if (error instanceof OAuthAuthorizationRequiredError) {
				throw error;
			}
			// Parse and enhance other errors
			const errorMessage =
				error instanceof Error ? error.message : String(error);

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

	// Legacy path: manual transport creation (for non-OAuth or API key auth)
	// Helper to create a fresh transport (must be new for each connection attempt)
	const createTransport = () => {
		return transport === "SSE"
			? new SSEClientTransport(url, {
					requestInit:
						Object.keys(finalHeaders).length > 0
							? { headers: finalHeaders }
							: undefined,
				})
			: new StreamableHTTPClientTransport(url, {
					requestInit:
						Object.keys(finalHeaders).length > 0
							? { headers: finalHeaders }
							: undefined,
				});
	};

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
): Promise<{
	client: McpClientType;
	serverName: string;
	serverUrl: string;
	transport: string;
}> {
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

	// Read before the breaker gate below, which is auth-type scoped.
	const authType = mcpConfig.authType;

	// The refresh circuit breaker (recordRefreshFailure) flips needsReauth after
	// persistent refresh failures, and only a successful re-auth
	// (updateMcpConfigTokens) clears it. Connecting before then would just
	// re-hammer a dead refresh token on every request.
	//
	// Scoped to OAUTH2 deliberately: the flag describes an OAuth GRANT, and the
	// only thing that clears it is an OAuth reconnect. A config edited to
	// API_KEY or NONE keeps whatever flag its OAuth life left on the row, so an
	// unscoped gate would refuse a working API key behind a reconnect flow the
	// config no longer has — with no user-reachable way to clear it. The edit
	// path clears the flag on that transition going forward; this scoping is
	// what rescues rows that already carry a stale one.
	if (authType === "OAUTH2" && mcpConfig.needsReauth) {
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

	// Handle STDIO transport via wrapper service
	if (transport === "STDIO") {
		return createStdioMcpClientForConfig({
			configId,
			userId,
			organizationId,
			mcpConfig,
			mcpServer,
		});
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

	// Use AI SDK v6 authProvider for OAuth2 authentication
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
	fromCache: boolean;
}> {
	const {
		configId,
		userId,
		organizationId,
		forceNew = false,
		redirectUri,
		onAuthorizationRequired,
	} = options;
	const cacheKey = getMcpCacheKey(configId, userId, organizationId);

	// Check cache first (unless forcing new)
	if (!forceNew) {
		const cached = mcpClientCache.get(cacheKey);
		if (cached) {
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
		const result = await createMcpClientForConfig({
			configId,
			userId,
			organizationId,
			redirectUri,
			onAuthorizationRequired,
		});

		// Cache it
		mcpClientCache.set(cacheKey, {
			client: result.client,
			serverName: result.serverName,
			serverUrl: result.serverUrl,
			transport: result.transport,
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

		// Build OAuth client keys JSON
		const clientSecret = mcpConfig.encryptedOauthClientSecret
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
		const refreshToken = mcpConfig.encryptedRefreshToken
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
