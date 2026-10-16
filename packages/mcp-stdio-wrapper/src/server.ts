/**
 * MCP STDIO Wrapper HTTP Server
 *
 * Exposes STDIO-based MCP servers via HTTP endpoints.
 * This wrapper is designed to run as an internal service in Azure Container Apps,
 * accessible only from other services in the same environment.
 *
 * Endpoints:
 * - POST /mcp/call - Execute an MCP method
 * - GET /health - Health check
 * - GET /stats - Pool statistics (internal use)
 *
 * Security:
 * - Internal-only middleware restricts access to private network
 * - Credentials passed in the request body, injected as env vars to spawned
 *   processes; a pooled process is replaced when they change
 * - Process-per-user isolation
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { registerHttpServerShutdown } from "@repo/observability/http-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { parse as parseShellArgs } from "shell-quote";
import { z } from "zod/v4";

import {
	internalApiKeyMiddleware,
	internalOnlyMiddleware,
} from "./middleware/internal-only";
import {
	type ResolvedCommand,
	resolvePreinstalledCommand,
} from "./preinstalled-command";
import {
	getProcessPool,
	hashCredentials,
	type ProcessPoolConfig,
	shutdownProcessPool,
} from "./process-pool";
import { createStdioTransport } from "./stdio-transport";

const TWILIO_PACKAGE = "@twilio-alpha/mcp";
const TWILIO_LAUNCHER = fileURLToPath(
	new URL("./launchers/twilio.cjs", import.meta.url),
);

// =============================================================================
// Request Schemas
// =============================================================================

const McpCallRequestSchema = z.object({
	/** MCP server command (e.g., 'npx @azure-devops/mcp') */
	command: z.string(),
	/** Arguments for the command (e.g., ['organization-name']) */
	args: z.array(z.string()).default([]),
	/** The MCP method to call (e.g., 'tools/list', 'tools/call') */
	method: z.string(),
	/** Parameters for the MCP method */
	params: z.any().optional(),
	/** User ID for tenant isolation */
	userId: z.string(),
	/** Organization ID for tenant isolation (null for personal context) */
	organizationId: z.string().nullable().optional(),
	/** Configuration ID for process caching */
	configId: z.string(),
	/** Credential environment variables (never logged) */
	credentials: z.record(z.string(), z.string()).optional(),
	/**
	 * How fresh `credentials` are, compared element by element
	 * (`compareCredentialsVersions`). A call whose credentials are older than
	 * the pooled process's gets a process of its own instead of replacing it.
	 */
	credentialsVersion: z.array(z.number().finite()).max(8).optional(),
});

export type McpCallRequest = z.infer<typeof McpCallRequestSchema>;

// =============================================================================
// Credential Materialization
// =============================================================================

/**
 * Materializes credential JSON content into temp files on the wrapper's filesystem.
 *
 * The web server passes Google Drive OAuth credentials as JSON strings
 * (__GDRIVE_OAUTH_KEYS_JSON, __GDRIVE_CREDENTIALS_JSON) instead of file paths,
 * since the web server and wrapper may run in different containers.
 *
 * This function writes those JSON strings to temp files and replaces the
 * credential keys with GDRIVE_OAUTH_PATH / GDRIVE_CREDENTIALS_PATH pointing
 * to the written files.
 *
 * @returns The resolved credentials and any temp paths that need cleanup.
 */
async function materializeCredentialFiles(
	credentials: Record<string, string>,
	configId: string,
): Promise<{ resolved: Record<string, string>; cleanupPaths: string[] }> {
	const oauthKeysJson = credentials.__GDRIVE_OAUTH_KEYS_JSON;
	const credentialsJson = credentials.__GDRIVE_CREDENTIALS_JSON;

	if (!oauthKeysJson && !credentialsJson) {
		return { resolved: credentials, cleanupPaths: [] };
	}

	// A unique directory per creation: two creations for one config can run
	// at once (each set of credentials gets its own process), and must not
	// write over or delete each other's files. mkdtemp creates it with 0o700.
	const tmpDir = await mkdtemp(join(tmpdir(), `gdrive-mcp-${configId}-`));
	try {
		const resolved = { ...credentials };
		// Remove the JSON content keys — they should not be passed as env vars
		delete resolved.__GDRIVE_OAUTH_KEYS_JSON;
		delete resolved.__GDRIVE_CREDENTIALS_JSON;

		if (oauthKeysJson) {
			const oauthKeysPath = join(tmpDir, "gcp-oauth.keys.json");
			await writeFile(oauthKeysPath, oauthKeysJson, { mode: 0o600 });
			resolved.GDRIVE_OAUTH_PATH = oauthKeysPath;
		}

		if (credentialsJson) {
			const credentialsPath = join(tmpDir, "credentials.json");
			await writeFile(credentialsPath, credentialsJson, { mode: 0o600 });
			resolved.GDRIVE_CREDENTIALS_PATH = credentialsPath;
		}

		console.log(`[MCP Call] Materialized credential files in ${tmpDir}`);

		return { resolved, cleanupPaths: [tmpDir] };
	} catch (error) {
		await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

/**
 * Deadline for the handshake with a freshly spawned server. It covers process
 * startup — npx resolution, a first download, module loading — which on a
 * 0.5 vCPU replica with several cold spawns at once runs well past the
 * ordinary 30 s request timeout. A server that exits still fails at once.
 */
const INITIALIZE_TIMEOUT_MS = 120_000;

// =============================================================================
// Server Factory
// =============================================================================

export interface ServerConfig {
	/** Port to listen on (default: 3100) */
	port?: number;
	/** Process pool configuration */
	poolConfig?: ProcessPoolConfig;
	/** Internal API key for additional security (optional) */
	internalApiKey?: string;
	/** Command resolver override (used in tests) */
	resolveCommand?: (
		commandParts: readonly string[],
	) => Promise<ResolvedCommand | null>;
}

/**
 * Create the Hono application.
 */
export function createServer(config: ServerConfig = {}): Hono {
	const app = new Hono();
	const pool = getProcessPool(config.poolConfig);
	const resolveCommand = config.resolveCommand ?? resolvePreinstalledCommand;

	// ==========================================================================
	// Middleware
	// ==========================================================================

	// Request logging (but redact credentials)
	app.use(
		"*",
		logger((message: string) => {
			// Redact anything that looks like a credential
			const redacted = message.replace(
				/(key|token|secret|password|pat)["']?\s*[:=]\s*["']?[^"'\s,}]+/gi,
				"$1=[REDACTED]",
			);
			console.log(redacted);
		}),
	);

	// Internal-only access (defense-in-depth)
	// Note: In production, this service runs as a SIDECAR of temporal-worker,
	// so all traffic comes via localhost. The middleware is kept for:
	// 1. Local development scenarios
	// 2. Defense-in-depth if architecture changes
	app.use("/mcp/*", internalOnlyMiddleware());
	app.use("/stats", internalOnlyMiddleware());

	// API key authentication (defense in depth)
	// Both /mcp/* and /stats require API key when configured
	// In sidecar mode, this authenticates temporal-worker -> mcp-stdio-wrapper calls
	const isProduction = process.env.NODE_ENV === "production";
	if (config.internalApiKey) {
		app.use("/mcp/*", internalApiKeyMiddleware(config.internalApiKey));
		app.use("/stats", internalApiKeyMiddleware(config.internalApiKey));
	} else if (isProduction) {
		// Warn but don't fail - sidecar mode means localhost-only access
		console.warn(
			"[Security] MCP_WRAPPER_API_KEY not set in production. " +
				"API key auth provides defense-in-depth and is strongly recommended.",
		);
	}

	// ==========================================================================
	// Health Check
	// ==========================================================================

	app.get("/health", (c) => {
		return c.json({
			status: "healthy",
			timestamp: new Date().toISOString(),
			pool: {
				size: pool.getStats().size,
				maxProcesses: pool.getStats().maxProcesses,
			},
		});
	});

	// ==========================================================================
	// Pool Statistics (for debugging/monitoring)
	// ==========================================================================

	app.get("/stats", (c) => {
		const stats = pool.getStats();
		// Redact user IDs for logging purposes
		return c.json({
			...stats,
			entries: stats.entries.map((e) => ({
				key: e.key.replace(/^[^:]+/, "[user]"), // Redact userId
				ageMs: e.ageMs,
				idleMs: e.idleMs,
				configId: e.configId,
			})),
		});
	});

	// ==========================================================================
	// MCP Call Endpoint
	// ==========================================================================

	app.post("/mcp/call", async (c) => {
		let request: McpCallRequest;

		try {
			const body = await c.req.json();
			request = McpCallRequestSchema.parse(body);
		} catch (error) {
			return c.json(
				{
					error: "Invalid request",
					message:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
				400,
			);
		}

		const {
			command,
			args,
			method,
			params,
			userId,
			organizationId,
			configId,
			credentials,
			credentialsVersion,
		} = request;

		console.log(
			`[MCP Call] method=${method}, configId=${configId}, userId=${userId.slice(0, 8)}...`,
		);

		// Set once the pool hands back a process, so a failure removes that
		// process only (not a replacement started with newer credentials).
		let transport: Awaited<ReturnType<typeof pool.getOrCreate>> | undefined;
		try {
			// Get or create transport using the pool's race-condition-safe
			// method. A pooled process started with other credentials (a
			// refreshed token, a revoke or a reconnect) is replaced.
			transport = await pool.getOrCreate(
				userId,
				organizationId ?? undefined,
				configId,
				async () => {
					console.log(
						`[MCP Call] Creating new transport for config: ${configId}`,
					);

					// Parse command properly handling quoted args and paths with spaces
					const parsedCommand = parseShellArgs(command);
					// Filter out any non-string entries (shell-quote can return objects for operators)
					const commandParts = parsedCommand.filter(
						(part): part is string => typeof part === "string",
					);
					const preinstalled = await resolveCommand(commandParts);
					if (preinstalled) {
						console.log(
							`[MCP Call] Running preinstalled ${preinstalled.packageName}@${preinstalled.version} instead of npx`,
						);
					}
					const executable =
						preinstalled?.executable ?? commandParts[0];
					// Twilio reads credentials only from argv; its launcher adds them in-process.
					const commandArgs =
						preinstalled?.packageName === TWILIO_PACKAGE
							? [TWILIO_LAUNCHER, ...preinstalled.args, ...args]
							: [
									...(preinstalled?.args ??
										commandParts.slice(1)),
									...args,
								];

					let cleanupPaths: string[] = [];
					let newTransport: Awaited<
						ReturnType<typeof createStdioTransport>
					> | null = null;
					try {
						// Only the request that creates the pooled process needs credential
						// files. Calls reusing that process must not create orphaned copies.
						const materialized = await materializeCredentialFiles(
							credentials ?? {},
							configId,
						);
						cleanupPaths = materialized.cleanupPaths;
						newTransport = await createStdioTransport({
							command: executable,
							args: commandArgs,
							env: materialized.resolved,
						});

						// MCP connections must initialize successfully before use.
						await newTransport.request(
							"initialize",
							{
								protocolVersion: "2025-03-26",
								capabilities: {
									tools: {},
									elicitation: {},
								},
								clientInfo: {
									name: "fabric-mcp-stdio-wrapper",
									version: "1.0.0",
								},
							},
							INITIALIZE_TIMEOUT_MS,
						);
						await newTransport.notify("notifications/initialized");
					} catch (error) {
						await newTransport?.close().catch(() => {});
						await Promise.all(
							cleanupPaths.map((path) =>
								rm(path, {
									recursive: true,
									force: true,
								}).catch(() => {}),
							),
						);
						throw error;
					}

					return { transport: newTransport, cleanupPaths };
				},
				hashCredentials(credentials),
				credentialsVersion,
			);

			// Execute the MCP method
			const result = await transport.request(method, params);

			// Log tool names when listing tools
			if (
				method === "tools/list" &&
				result &&
				typeof result === "object"
			) {
				const toolsResult = result as {
					tools?: Array<{ name: string }>;
				};
				if (toolsResult.tools && Array.isArray(toolsResult.tools)) {
					console.log(
						`[MCP Call] tools/list returned ${toolsResult.tools.length} tools:`,
						toolsResult.tools.map((t) => t.name).join(", "),
					);
				}
			}

			return c.json({
				success: true,
				result,
			});
		} catch (error) {
			console.error("[MCP Call] Error:", error);

			// If the transport failed, remove it from pool so next request
			// creates a fresh one. A failed creation pooled nothing: the factory
			// already closed its process and deleted its files.
			if (transport) {
				await pool
					.remove(
						userId,
						organizationId ?? undefined,
						configId,
						transport,
					)
					.catch(() => {});
			}

			return c.json(
				{
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
				500,
			);
		} finally {
			// Return the lease `getOrCreate` took: a process replaced while
			// this request ran is closed once its last request is done.
			if (transport) {
				await pool.release(transport).catch(() => {});
			}
		}
	});

	// ==========================================================================
	// Error Handler
	// ==========================================================================

	app.onError((err, c) => {
		console.error("[Server Error]", err);
		return c.json(
			{
				error: "Internal server error",
				message:
					process.env.NODE_ENV === "development"
						? err.message
						: "An unexpected error occurred",
			},
			500,
		);
	});

	// ==========================================================================
	// 404 Handler
	// ==========================================================================

	app.notFound((c) => {
		return c.json(
			{
				error: "Not found",
				message: `Route ${c.req.method} ${c.req.path} not found`,
			},
			404,
		);
	});

	return app;
}

/**
 * Start the HTTP server.
 */
export function startServer(
	config: ServerConfig = {},
): ReturnType<typeof serve> {
	const port = config.port ?? Number(process.env.PORT) ?? 3100;
	const app = createServer(config);

	console.log(`[MCP STDIO Wrapper] Starting server on port ${port}`);

	const server = serve({
		fetch: app.fetch,
		port,
	});

	registerHttpServerShutdown(server, shutdownProcessPool);

	console.log(`[MCP STDIO Wrapper] Server ready at http://0.0.0.0:${port}`);

	return server;
}

// =============================================================================
// Main Entry Point
// =============================================================================

// Start server if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
	startServer({
		port: Number(process.env.PORT) || 3100,
		internalApiKey: process.env.MCP_WRAPPER_API_KEY,
		poolConfig: {
			maxProcesses: Number(process.env.MAX_PROCESSES) || 50,
			idleTtlMs: Number(process.env.IDLE_TTL_MS) || 60000,
		},
	});
}
