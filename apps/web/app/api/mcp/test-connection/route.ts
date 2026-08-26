import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth } from "@repo/auth";
import { getMcpConfigByIdInternal, getValidAccessToken } from "@repo/database";
import { type ApiKeyMethod, buildAuthHeaders } from "@repo/mcp";
import { decryptApiKey } from "@repo/utils";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

// Schema for test connection request
const TestConnectionSchema = z.object({
	baseUrl: z.string().url({ message: "Base URL must be a valid URL" }),
	transport: z.enum(["HTTP", "SSE"]).default("HTTP"),
	authType: z.enum(["NONE", "API_KEY", "OAUTH2"]).default("NONE"),
	apiKeyMethod: z.enum(["BEARER", "HEADER", "PLAIN"]).optional(),
	apiKey: z.string().optional(),
	oauthClientId: z.string().optional(),
	oauthClientSecret: z.string().optional(),
	// When testing OAuth2 connections, the client can either supply:
	// 1. A configId to automatically retrieve and use stored OAuth tokens
	// 2. An oauthAccessToken directly (legacy behavior)
	configId: z.string().optional(),
	oauthAccessToken: z.string().optional(),
});

type TestConnectionInput = z.infer<typeof TestConnectionSchema>;

interface TestResult {
	success: boolean;
	message: string;
	details?: {
		protocolVersion?: string;
		serverInfo?: {
			name?: string;
			version?: string;
		};
		capabilities?: Record<string, unknown>;
		responseTime?: number;
		transport?: string;
		authType?: string;
		apiKeyMethod?: string;
	};
	error?: {
		type: string;
		message: string;
		statusCode?: number;
	};
}

function unauthorizedMcpConfigResponse(): NextResponse {
	return NextResponse.json(
		{
			success: false,
			message: "Unauthorized",
			error: {
				type: "UNAUTHORIZED",
				message: "You do not have access to this MCP configuration.",
			},
		} satisfies TestResult,
		{ status: 403 },
	);
}

/**
 * Test MCP server connection with proper protocol compliance
 * POST /api/mcp/test-connection
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
	try {
		// Require authentication
		const session = await auth.api.getSession({ headers: req.headers });
		if (!session?.user) {
			return NextResponse.json(
				{
					success: false,
					message: "Unauthorized",
					error: {
						type: "UNAUTHORIZED",
						message:
							"Authentication required to test MCP connections",
					},
				} satisfies TestResult,
				{ status: 401 },
			);
		}

		// Parse and validate request body
		const body = await req.json();
		const input = TestConnectionSchema.parse(body);

		// If configId is provided, retrieve credentials from the stored config
		let effectiveInput = input;
		if (input.configId) {
			try {
				// Use internal version - authorization is done below based on config ownership
				const cfg = await getMcpConfigByIdInternal(input.configId);
				if (!cfg) {
					return NextResponse.json(
						{
							success: false,
							message: "MCP config not found",
							error: {
								type: "CONFIG_NOT_FOUND",
								message:
									"The specified MCP configuration was not found.",
							},
						} satisfies TestResult,
						{ status: 404 },
					);
				}

				const sessionOrganizationId =
					session.session?.activeOrganizationId ?? undefined;

				// Tenant is derived from the session — body `organizationId`
				// is no longer trusted. The config's org pin (if any) must
				// match the caller's active org, and the config's user (if
				// any) must match the caller.
				const configMismatch =
					(cfg.userId && cfg.userId !== session.user.id) ||
					(cfg.organizationId &&
						cfg.organizationId !== sessionOrganizationId);
				if (configMismatch) {
					return unauthorizedMcpConfigResponse();
				}

				// Handle different auth types
				if (input.authType === "OAUTH2") {
					// Pass the config's own scope. `sessionOrganizationId` may
					// be a sticky active org while the user is testing a
					// personal config (cfg.organizationId === null), which
					// would make getValidAccessToken reject on org mismatch.
					const accessToken = await getValidAccessToken({
						configId: input.configId,
						userId: session.user.id,
						organizationId: cfg.organizationId,
					});

					if (!accessToken) {
						return NextResponse.json(
							{
								success: false,
								message:
									"OAuth2 test connection requires an access token. Please connect OAuth first.",
								error: {
									type: "OAUTH_ACCESS_TOKEN_REQUIRED",
									message:
										"OAuth2 test connection requires an access token. Please connect OAuth first.",
									statusCode: 400,
								},
							} satisfies TestResult,
							{ status: 400 },
						);
					}

					// Use the retrieved access token
					effectiveInput = {
						...input,
						oauthAccessToken: accessToken,
					};
				} else if (input.authType === "API_KEY") {
					// Decrypt and use the stored API key
					if (!cfg.encryptedApiKey) {
						return NextResponse.json(
							{
								success: false,
								message:
									"API key not found in configuration. Please configure the API key first.",
								error: {
									type: "API_KEY_NOT_FOUND",
									message:
										"API key not found in configuration. Please configure the API key first.",
									statusCode: 400,
								},
							} satisfies TestResult,
							{ status: 400 },
						);
					}

					try {
						const apiKey = decryptApiKey(cfg.encryptedApiKey);
						effectiveInput = {
							...input,
							apiKey,
							// Prefer the request's apiKeyMethod (user may have changed it in the UI),
							// fall back to the stored config value, then default to BEARER
							apiKeyMethod:
								input.apiKeyMethod ||
								(cfg.apiKeyMethod as
									| "BEARER"
									| "HEADER"
									| "PLAIN") ||
								"BEARER",
						};
					} catch (error) {
						console.error("Error decrypting API key:", error);
						return NextResponse.json(
							{
								success: false,
								message: "Failed to decrypt API key",
								error: {
									type: "API_KEY_DECRYPT_ERROR",
									message:
										error instanceof Error
											? error.message
											: "Failed to decrypt API key",
								},
							} satisfies TestResult,
							{ status: 500 },
						);
					}
				}
			} catch (error) {
				console.error("Error retrieving config credentials:", error);
				return NextResponse.json(
					{
						success: false,
						message: "Failed to retrieve configuration credentials",
						error: {
							type: "CONFIG_CREDENTIALS_ERROR",
							message:
								error instanceof Error
									? error.message
									: "Failed to retrieve configuration credentials",
						},
					} satisfies TestResult,
					{ status: 500 },
				);
			}
		}

		// Basic SSRF protection: block private / local addresses
		if (isPrivateOrLocalAddress(effectiveInput.baseUrl)) {
			return NextResponse.json(
				{
					success: false,
					message: "Base URL is not allowed",
					error: {
						type: "URL_NOT_ALLOWED",
						message:
							"Testing connections to private, loopback, or local network addresses is not allowed.",
					},
				} satisfies TestResult,
				{ status: 400 },
			);
		}

		// Perform the connection test with a hard timeout so the server never hangs
		const TIMEOUT_MS = 28_000;
		const result = await Promise.race([
			testMcpConnection(effectiveInput),
			new Promise<TestResult>((resolve) =>
				setTimeout(
					() =>
						resolve({
							success: false,
							message:
								"Connection test timed out after 28 seconds",
							error: {
								type: "TIMEOUT",
								message:
									"The MCP server did not respond within 28 seconds. Check the server URL and ensure it is running.",
							},
						}),
					TIMEOUT_MS,
				),
			),
		]);

		return NextResponse.json(result, {
			status: result.success ? 200 : 400,
		});
	} catch (error) {
		if (error instanceof z.ZodError) {
			return NextResponse.json(
				{
					success: false,
					message: "Invalid request parameters",
					error: {
						type: "VALIDATION_ERROR",
						message: error.issues
							.map((issue) => issue.message)
							.join(", "),
					},
				} satisfies TestResult,
				{ status: 400 },
			);
		}

		return NextResponse.json(
			{
				success: false,
				message: "Internal server error",
				error: {
					type: "INTERNAL_ERROR",
					message:
						error instanceof Error ? error.message : String(error),
				},
			} satisfies TestResult,
			{ status: 500 },
		);
	}
}

function isPrivateOrLocalAddress(urlString: string): boolean {
	try {
		const url = new URL(urlString);

		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return true;
		}

		// Allow Fabric-hosted MCP routes under `/api/mcp/*` — these resolve to
		// the same Fabric instance, so loopback/localhost is expected and safe.
		// (The legacy in-process GitLab MCP shim that lived at `/api/mcp/gitlab`
		// has been removed in favor of GitLab's official remote MCP server, but
		// other Fabric-hosted MCP routes may still appear under this prefix.)
		if (url.pathname.startsWith("/api/mcp/")) {
			const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
			try {
				if (siteUrl) {
					const allowed = new URL(siteUrl);
					if (
						allowed.host === url.host &&
						allowed.protocol === url.protocol
					) {
						return false;
					}
				}
			} catch {
				// fall through to normal SSRF check
			}
		}

		const hostname = url.hostname.toLowerCase();

		// Localhost and loopback
		if (
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "::1"
		) {
			return true;
		}

		// Simple IPv4 private range checks
		const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
		if (ipv4Match) {
			const octets = ipv4Match.slice(1).map((o) => Number(o));
			const [a, b] = octets;

			if (Number.isNaN(a) || Number.isNaN(b)) {
				return true;
			}

			// 10.0.0.0/8
			if (a === 10) {
				return true;
			}
			// 127.0.0.0/8
			if (a === 127) {
				return true;
			}
			// 172.16.0.0/12
			if (a === 172 && b >= 16 && b <= 31) {
				return true;
			}
			// 192.168.0.0/16
			if (a === 192 && b === 168) {
				return true;
			}
			// 169.254.0.0/16 (link-local)
			if (a === 169 && b === 254) {
				return true;
			}
		}

		// Block obvious local-only hostnames
		if (hostname.endsWith(".local")) {
			return true;
		}

		return false;
	} catch {
		// Treat invalid URLs as unsafe
		return true;
	}
}

/**
 * Test MCP server connection using raw MCP SDK Client
 * This allows us to access server info (name, version) from the handshake
 */
async function testMcpConnection(
	input: TestConnectionInput,
): Promise<TestResult> {
	const startTime = Date.now();
	let client: Client | undefined;

	try {
		// Prepare authentication headers using the buildAuthHeaders utility
		let headers: Record<string, string> = {};

		if (input.authType === "API_KEY" && input.apiKey) {
			// Use the buildAuthHeaders utility to properly format based on method
			headers = buildAuthHeaders(
				"API_KEY",
				input.apiKey,
				(input.apiKeyMethod || "BEARER") as ApiKeyMethod,
			);
		} else if (input.authType === "OAUTH2") {
			if (!input.oauthAccessToken) {
				return {
					success: false,
					message:
						"OAuth2 test connection requires an access token. Please connect OAuth first.",
					error: {
						type: "OAUTH_ACCESS_TOKEN_REQUIRED",
						message:
							"OAuth2 test connection requires an access token. Please connect OAuth first.",
						statusCode: 400,
					},
				} satisfies TestResult;
			}
			headers = buildAuthHeaders("OAUTH2", input.oauthAccessToken);
		}

		// Log the request for debugging (only in development)
		if (process.env.NODE_ENV === "development") {
			console.log("[MCP Test] Testing connection to:", input.baseUrl);
			console.log("[MCP Test] Transport:", input.transport);
			console.log("[MCP Test] Auth Type:", input.authType);
			console.log("[MCP Test] Has Auth Header:", !!headers.Authorization);
		}

		// Create URL object
		const url = new URL(input.baseUrl);

		// Create transport based on type
		const transport =
			input.transport === "SSE"
				? new SSEClientTransport(url, {
						requestInit:
							Object.keys(headers).length > 0
								? { headers }
								: undefined,
					})
				: new StreamableHTTPClientTransport(url, {
						requestInit:
							Object.keys(headers).length > 0
								? { headers }
								: undefined,
					});

		// Create raw MCP SDK client to access server info
		client = new Client(
			{ name: "fabric-mcp-test", version: "1.0.0" },
			{ capabilities: {} },
		);

		// Connect to the server - this performs the MCP handshake
		await client.connect(transport);

		// Get server info from the handshake response
		const serverVersion = client.getServerVersion();
		const serverCapabilities = client.getServerCapabilities();

		// Get tools to validate the connection works
		const toolsResponse = await client.listTools();
		const tools = toolsResponse.tools || [];
		const toolNames = tools.map((t) => t.name);

		const responseTime = Date.now() - startTime;

		if (process.env.NODE_ENV === "development") {
			console.log(
				"[MCP Test] Successfully connected, found",
				toolNames.length,
				"tools",
			);
			console.log("[MCP Test] Server info:", serverVersion);
		}

		// For authenticated connections, verify the API key/token actually works
		// by executing a lightweight read-only tool call.
		// Some MCP servers (e.g., Fizzy) don't validate auth on connect/list-tools
		// but only on tool execution, causing false-positive "connection successful" results.
		let authVerified = true;
		let authWarning: string | undefined;

		if (
			(input.authType === "API_KEY" || input.authType === "OAUTH2") &&
			tools.length > 0
		) {
			// Pick the most reliable read-only tool. Prefer cheap identity-style
			// probes ("whoami", "get_authenticated_user", "current_user") over
			// generic list_* calls — those occasionally 500 (e.g. GitLab list_projects
			// when the upstream rate-limits) and we don't want to blame auth
			// for a transient server error.
			const preferredNames = [
				"get_authenticated_user",
				"get_current_user",
				"whoami",
				"get_me",
				"me",
			];
			const safeToolPatterns = [
				/^(list|get|read|fetch|show|describe)_/i,
				/_(list|get|accounts|status)$/i,
			];
			const safeTool =
				tools.find((t) => preferredNames.includes(t.name)) ||
				tools.find((t) => safeToolPatterns.some((p) => p.test(t.name)));

			if (safeTool) {
				try {
					await client.callTool({
						name: safeTool.name,
						arguments: {},
					});
					// Tool call succeeded - auth is verified
				} catch (toolError) {
					const errMsg =
						toolError instanceof Error
							? toolError.message
							: String(toolError);

					// Check if the error is auth-related
					const isAuthFailure =
						/\b401\b/.test(errMsg) ||
						/unauthorized/i.test(errMsg) ||
						/access denied/i.test(errMsg) ||
						/authentication failed/i.test(errMsg) ||
						/token.*(?:expired|revoked|invalid)/i.test(errMsg);

					if (isAuthFailure) {
						authVerified = false;
						authWarning =
							input.authType === "OAUTH2"
								? "Your OAuth token appears to be expired or revoked. Please reconnect in MCP Settings."
								: "Your API key appears to be expired or revoked. Please update it in MCP Settings.";

						if (process.env.NODE_ENV === "development") {
							console.warn(
								"[MCP Test] Auth verification failed:",
								errMsg,
							);
						}
					}
					// Non-auth errors (missing params, etc.) are expected and ignored
				}
			}
		}

		if (!authVerified) {
			return {
				success: false,
				message:
					"MCP server is reachable but authentication failed during tool execution.",
				error: {
					type: "AUTH_VERIFICATION_FAILED",
					message:
						authWarning || "API key or token verification failed.",
				},
				details: {
					protocolVersion: serverCapabilities
						? "2025-03-26"
						: "unknown",
					serverInfo: {
						name: serverVersion?.name || "MCP Server",
						version: serverVersion?.version || undefined,
					},
					capabilities: {
						toolCount: toolNames.length,
						tools: toolNames.slice(0, 10),
						hasResources: !!serverCapabilities?.resources,
						hasPrompts: !!serverCapabilities?.prompts,
					},
					responseTime: Date.now() - startTime,
					transport: input.transport,
					authType: input.authType,
				},
			};
		}

		return {
			success: true,
			message:
				toolNames.length === 0
					? "Connected to MCP server, but no tools were discovered. The server may not be a fully-featured MCP endpoint."
					: `Successfully connected to MCP server. Found ${toolNames.length} tool${toolNames.length !== 1 ? "s" : ""}.`,
			details: {
				protocolVersion: serverCapabilities ? "2025-03-26" : "unknown",
				serverInfo: {
					name: serverVersion?.name || "MCP Server",
					version: serverVersion?.version || undefined,
				},
				capabilities: {
					toolCount: toolNames.length,
					tools: toolNames.slice(0, 10), // Show first 10 tool names
					hasResources: !!serverCapabilities?.resources,
					hasPrompts: !!serverCapabilities?.prompts,
				},
				responseTime,
				transport: input.transport,
				authType: input.authType,
			},
		};
	} catch (error) {
		const responseTime = Date.now() - startTime;

		if (process.env.NODE_ENV === "development") {
			console.error("[MCP Test] Connection failed:", error);
		}

		// Parse error for better messaging with auth-specific guidance
		let errorMessage = "Unknown error";
		let errorType = "UNKNOWN_ERROR";
		let authGuidance = "";

		if (error instanceof Error) {
			errorMessage = error.message;

			// Check for ZodError (protocol/response parsing issues)
			if (
				error.name === "ZodError" ||
				error.constructor.name === "ZodError"
			) {
				const zodErr = error as {
					errors?: Array<{ message?: string; keys?: string[] }>;
				};
				const hasUnrecognizedError = zodErr.errors?.some(
					(e) =>
						e.message?.includes("Unrecognized key") &&
						e.keys?.includes("error"),
				);

				if (hasUnrecognizedError) {
					errorType = "AUTHENTICATION_ERROR";
					errorMessage =
						"MCP server returned an error. This usually indicates authentication failure.";

					// Provide auth-specific guidance
					if (input.authType === "API_KEY") {
						authGuidance =
							input.apiKeyMethod === "HEADER"
								? "Try switching to 'Bearer' authentication method, or verify your API key is correct."
								: "Try switching to 'X-API-Key Header' authentication method, or verify your API key is correct.";
					} else if (input.authType === "OAUTH2") {
						authGuidance =
							"Your OAuth token may be expired or invalid. Please re-authenticate in MCP Settings.";
					} else {
						authGuidance =
							"This server may require authentication. Try configuring an API key or OAuth.";
					}
				} else {
					errorType = "PROTOCOL_ERROR";
					errorMessage =
						"Protocol error: The server response doesn't match the expected MCP format.";
				}
			} else if (
				error.message.includes("401") ||
				error.message.includes("Unauthorized")
			) {
				errorType = "AUTHENTICATION_ERROR";
				errorMessage = "Authentication failed (401 Unauthorized).";

				// Detect known OAuth-only servers that don't accept API keys
				const isFigmaMcp = /^https?:\/\/mcp\.figma\.com/i.test(
					input.baseUrl,
				);

				if (isFigmaMcp) {
					authGuidance =
						"Figma's remote MCP server (mcp.figma.com) only supports OAuth2 with pre-approved clients (Claude, Cursor). " +
						"It does not accept API keys or Personal Access Tokens. " +
						"Use the community Figma MCP server (npx figma-developer/figma-mcp) with a Figma Personal Access Token instead.";
				} else if (input.authType === "API_KEY") {
					authGuidance =
						`Current method: ${input.apiKeyMethod === "HEADER" ? "X-API-Key header" : "Bearer token"}. ` +
						"Try the other method or verify your API key is correct.";
				} else if (input.authType === "OAUTH2") {
					authGuidance =
						"Your OAuth token is expired or invalid. Please re-authenticate in MCP Settings.";
				} else {
					authGuidance =
						"This server requires authentication. Please configure an API key or OAuth.";
				}
			} else if (
				error.message.includes("403") ||
				error.message.includes("Forbidden")
			) {
				errorType = "AUTHORIZATION_ERROR";
				errorMessage = "Authorization failed (403 Forbidden).";

				const isFigmaMcp403 = /^https?:\/\/mcp\.figma\.com/i.test(
					input.baseUrl,
				);
				if (isFigmaMcp403) {
					authGuidance =
						"Figma's remote MCP server only allows pre-approved OAuth clients (Claude, Cursor). " +
						"Third-party apps cannot register. Use the community Figma MCP server (npx figma-developer/figma-mcp) with a Personal Access Token instead.";
				} else {
					authGuidance =
						"Your credentials are valid but you don't have permission to access this resource. Check your account permissions.";
				}
			} else if (
				error.message.includes("fetch failed") ||
				error.message.includes("ECONNREFUSED")
			) {
				errorType = "CONNECTION_ERROR";
				errorMessage =
					"Could not establish connection to the server. Please check the base URL and ensure the server is running.";
			} else if (
				error.name === "AbortError" ||
				error.message.includes("timeout")
			) {
				errorType = "TIMEOUT";
				errorMessage =
					"The server did not respond in time. Please check if the server is running and accessible.";
			}
		}

		const fullMessage = authGuidance
			? `${errorMessage}\n\nSuggestion: ${authGuidance}`
			: errorMessage;

		return {
			success: false,
			message: `Connection test failed: ${errorMessage}`,
			error: {
				type: errorType,
				message: fullMessage,
			},
			details: {
				responseTime,
				transport: input.transport,
				authType: input.authType,
				apiKeyMethod: input.apiKeyMethod,
			},
		};
	} finally {
		// Always close the MCP client
		if (client) {
			try {
				await client.close();
			} catch {
				// Ignore close errors
			}
		}
	}
}
