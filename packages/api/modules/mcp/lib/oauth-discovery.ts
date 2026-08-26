/**
 * OAuth Discovery Utilities for MCP
 *
 * Implements RFC 9728 (OAuth 2.0 Protected Resource Metadata) and
 * RFC 8414 (OAuth 2.0 Authorization Server Metadata) for proper
 * OAuth endpoint discovery.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 * @see https://datatracker.ietf.org/doc/html/rfc8414
 */

import crypto from "node:crypto";
import { safeFetchOutbound } from "@repo/utils/url-security";

// ============================================================================
// Types
// ============================================================================

/**
 * Protected Resource Metadata (RFC 9728)
 * Identifies the authorization server for a protected resource
 */
export interface ProtectedResourceMetadata {
	/** The protected resource identifier */
	resource?: string;
	/** List of authorization server URLs */
	authorization_servers?: string[];
	/** Scopes supported by this resource */
	scopes_supported?: string[];
	/** Bearer token methods supported */
	bearer_methods_supported?: string[];
	/** Resource documentation URL */
	resource_documentation?: string;
}

/**
 * Authorization Server Metadata (RFC 8414)
 * Contains OAuth endpoint URLs and capabilities
 */
export interface AuthorizationServerMetadata {
	/** Issuer identifier */
	issuer?: string;
	/** Authorization endpoint URL */
	authorization_endpoint?: string;
	/** Token endpoint URL */
	token_endpoint?: string;
	/** Dynamic Client Registration endpoint */
	registration_endpoint?: string;
	/** Token revocation endpoint */
	revocation_endpoint?: string;
	/** Introspection endpoint */
	introspection_endpoint?: string;
	/** JWKS URI */
	jwks_uri?: string;
	/** Scopes supported */
	scopes_supported?: string[];
	/** Response types supported */
	response_types_supported?: string[];
	/** Grant types supported */
	grant_types_supported?: string[];
	/** Token endpoint auth methods */
	token_endpoint_auth_methods_supported?: string[];
	/** PKCE code challenge methods */
	code_challenge_methods_supported?: string[];
	/** Service documentation */
	service_documentation?: string;
}

/**
 * Combined OAuth metadata after discovery
 */
export interface MCPOAuthMetadata {
	/** Resource identifier */
	resource?: string;
	/** Authorization server URL */
	authorizationServer?: string;
	/** Authorization endpoint */
	authorizationEndpoint?: string;
	/** Token endpoint */
	tokenEndpoint?: string;
	/** Registration endpoint (for DCR) */
	registrationEndpoint?: string;
	/** Revocation endpoint */
	revocationEndpoint?: string;
	/** Supported scopes */
	scopesSupported?: string[];
	/** PKCE methods supported */
	codeChallengeMethodsSupported?: string[];
	/** When this metadata was cached */
	cachedAt?: string;
}

/**
 * Result of OAuth discovery
 */
export interface OAuthDiscoveryResult {
	success: boolean;
	metadata?: MCPOAuthMetadata;
	error?: string;
	/** Whether protected resource metadata was found (RFC 9728) */
	hasProtectedResourceMetadata?: boolean;
	/** Whether authorization server metadata was found (RFC 8414) */
	hasAuthServerMetadata?: boolean;
}

// ============================================================================
// Discovery Functions
// ============================================================================

const DISCOVERY_TIMEOUT_MS = 10000;

/**
 * Fetch Protected Resource Metadata (RFC 9728)
 *
 * Tries to discover the authorization server from the protected resource.
 * This is the first step in the MCP OAuth flow per RFC 9728.
 *
 * @param resourceUrl - The MCP server base URL
 */
export async function fetchProtectedResourceMetadata(
	resourceUrl: string,
): Promise<ProtectedResourceMetadata | null> {
	try {
		const url = new URL(resourceUrl);
		const metadataUrl = `${url.origin}/.well-known/oauth-protected-resource`;

		const controller = new AbortController();
		const timeoutId = setTimeout(
			() => controller.abort(),
			DISCOVERY_TIMEOUT_MS,
		);

		try {
			const response = await safeFetchOutbound(metadataUrl, {
				method: "GET",
				headers: {
					Accept: "application/json",
				},
				signal: controller.signal,
			});

			if (!response.ok) {
				return null;
			}

			const metadata =
				(await response.json()) as ProtectedResourceMetadata;
			return metadata;
		} finally {
			clearTimeout(timeoutId);
		}
	} catch (error) {
		// Protected resource metadata is optional, so we silently fail
		if (process.env.NODE_ENV === "development") {
			console.log(
				`[OAuth Discovery] Protected resource metadata not found at ${resourceUrl}:`,
				error instanceof Error ? error.message : error,
			);
		}
		return null;
	}
}

/**
 * Fetch Authorization Server Metadata (RFC 8414)
 *
 * Retrieves OAuth endpoints from the authorization server's well-known endpoint.
 *
 * @param authServerUrl - The authorization server URL
 */
export async function fetchAuthorizationServerMetadata(
	authServerUrl: string,
): Promise<AuthorizationServerMetadata | null> {
	try {
		const url = new URL(authServerUrl);
		// Try RFC 8414 path first
		const metadataUrl = `${url.origin}/.well-known/oauth-authorization-server`;

		const controller = new AbortController();
		const timeoutId = setTimeout(
			() => controller.abort(),
			DISCOVERY_TIMEOUT_MS,
		);

		try {
			let response = await safeFetchOutbound(metadataUrl, {
				method: "GET",
				headers: {
					Accept: "application/json",
				},
				signal: controller.signal,
			});

			// Fallback to OpenID Connect discovery if RFC 8414 fails
			if (!response.ok) {
				const oidcUrl = `${url.origin}/.well-known/openid-configuration`;
				response = await safeFetchOutbound(oidcUrl, {
					method: "GET",
					headers: {
						Accept: "application/json",
					},
					signal: controller.signal,
				});
			}

			if (!response.ok) {
				return null;
			}

			const metadata =
				(await response.json()) as AuthorizationServerMetadata;
			return metadata;
		} finally {
			clearTimeout(timeoutId);
		}
	} catch (error) {
		if (process.env.NODE_ENV === "development") {
			console.log(
				`[OAuth Discovery] Authorization server metadata not found at ${authServerUrl}:`,
				error instanceof Error ? error.message : error,
			);
		}
		return null;
	}
}

/**
 * Discover OAuth endpoints using RFC 9728 + RFC 8414
 *
 * This implements the full MCP OAuth discovery flow:
 * 1. Try to fetch Protected Resource Metadata (RFC 9728) from the MCP server
 * 2. If found, use the authorization_servers to determine the auth server
 * 3. Fetch Authorization Server Metadata (RFC 8414) from the auth server
 * 4. If step 1 fails, fall back to direct RFC 8414 discovery from MCP server
 *
 * @param mcpServerUrl - The MCP server base URL
 */
export async function discoverOAuthEndpoints(
	mcpServerUrl: string,
): Promise<OAuthDiscoveryResult> {
	try {
		const baseUrl = new URL(mcpServerUrl);
		const baseOrigin = baseUrl.origin;

		// Step 1: Try Protected Resource Metadata (RFC 9728)
		const protectedResourceMetadata =
			await fetchProtectedResourceMetadata(baseOrigin);

		let authServerMetadata: AuthorizationServerMetadata | null = null;
		let authServerUrl = baseOrigin;

		// Step 2: If we have authorization_servers, use the first one
		if (protectedResourceMetadata?.authorization_servers?.length) {
			authServerUrl = protectedResourceMetadata.authorization_servers[0];
			authServerMetadata =
				await fetchAuthorizationServerMetadata(authServerUrl);
		}

		// Step 3: Fallback to direct discovery if no protected resource metadata
		if (!authServerMetadata) {
			authServerMetadata =
				await fetchAuthorizationServerMetadata(baseOrigin);
		}

		// Build combined metadata
		if (!authServerMetadata) {
			return {
				success: false,
				error: "Could not discover OAuth endpoints. The server may not support OAuth or the discovery endpoints are not available.",
				hasProtectedResourceMetadata: !!protectedResourceMetadata,
				hasAuthServerMetadata: false,
			};
		}

		const metadata: MCPOAuthMetadata = {
			resource: protectedResourceMetadata?.resource || baseOrigin,
			authorizationServer:
				authServerMetadata.issuer || authServerUrl || baseOrigin,
			authorizationEndpoint: authServerMetadata.authorization_endpoint,
			tokenEndpoint: authServerMetadata.token_endpoint,
			registrationEndpoint: authServerMetadata.registration_endpoint,
			revocationEndpoint: authServerMetadata.revocation_endpoint,
			scopesSupported:
				protectedResourceMetadata?.scopes_supported ||
				authServerMetadata.scopes_supported,
			codeChallengeMethodsSupported:
				authServerMetadata.code_challenge_methods_supported,
			cachedAt: new Date().toISOString(),
		};

		return {
			success: true,
			metadata,
			hasProtectedResourceMetadata: !!protectedResourceMetadata,
			hasAuthServerMetadata: true,
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "OAuth discovery failed",
			hasProtectedResourceMetadata: false,
			hasAuthServerMetadata: false,
		};
	}
}

// ============================================================================
// PKCE Utilities (RFC 7636) - Enhanced with 96-byte verifier
// ============================================================================

/**
 * Base64URL encode a buffer (no padding)
 */
export function base64UrlEncode(buffer: Buffer | Uint8Array): string {
	const base64 = Buffer.from(buffer).toString("base64");
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Generate a cryptographically secure code verifier
 *
 * Uses 96 bytes of randomness for 128-character base64url output.
 * This exceeds the RFC 7636 minimum (43 chars) for maximum security.
 *
 * @returns 128-character base64url-encoded verifier
 */
export function generateCodeVerifier(): string {
	// 96 bytes → 128 base64url characters (more secure than 32 bytes → 43 chars)
	const randomBytes = crypto.randomBytes(96);
	return base64UrlEncode(randomBytes);
}

/**
 * Generate PKCE code challenge from verifier using S256 method
 *
 * @param verifier - The code verifier string
 * @returns SHA-256 hash of verifier, base64url-encoded
 */
export function generateCodeChallenge(verifier: string): string {
	const hash = crypto.createHash("sha256").update(verifier).digest();
	return base64UrlEncode(hash);
}

// ============================================================================
// State Parameter Utilities - Structured Payload
// ============================================================================

/**
 * State payload structure for CSRF protection and context
 */
export interface OAuthStatePayload {
	/** MCP server ID */
	serverId: string;
	/** MCP config ID */
	configId: string;
	/** User ID */
	userId: string;
	/** Organization ID (optional) */
	organizationId?: string;
	/** Random nonce for uniqueness */
	nonce: string;
	/** Timestamp for expiration validation */
	timestamp: number;
}

/**
 * Generate a structured state parameter
 *
 * Encodes context (configId, userId, etc.) into the state parameter
 * for validation without DB lookup and CSRF protection.
 *
 * @param payload - State payload data
 * @returns Base64URL-encoded state string
 */
export function generateStructuredState(payload: {
	serverId: string;
	configId: string;
	userId: string;
	organizationId?: string;
}): string {
	const statePayload: OAuthStatePayload = {
		...payload,
		nonce: crypto.randomBytes(16).toString("hex"),
		timestamp: Date.now(),
	};

	const jsonString = JSON.stringify(statePayload);
	return base64UrlEncode(Buffer.from(jsonString, "utf-8"));
}

/**
 * Parse and validate a structured state parameter
 *
 * @param state - The state string from OAuth callback
 * @param maxAgeMs - Maximum age in milliseconds (default: 10 minutes)
 * @returns Parsed payload or null if invalid/expired
 */
export function parseStructuredState(
	state: string,
	maxAgeMs: number = 10 * 60 * 1000,
): OAuthStatePayload | null {
	try {
		// Decode base64url
		const base64 = state.replace(/-/g, "+").replace(/_/g, "/");
		const jsonString = Buffer.from(base64, "base64").toString("utf-8");
		const payload = JSON.parse(jsonString) as OAuthStatePayload;

		// Validate required fields
		if (
			!payload.serverId ||
			!payload.configId ||
			!payload.userId ||
			!payload.nonce ||
			!payload.timestamp
		) {
			return null;
		}

		// Validate timestamp (not expired)
		const age = Date.now() - payload.timestamp;
		if (age > maxAgeMs) {
			return null;
		}

		return payload;
	} catch {
		return null;
	}
}
// ============================================================================
// Exports
// ============================================================================
