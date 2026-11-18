/**
 * MCP STDIO Wrapper HTTP Server
 *
 * Exposes STDIO-based MCP servers via HTTP endpoints.
 *
 * Endpoints:
 * - POST /mcp/call - Execute an MCP method
 * - GET /health - Health check
 * - GET /stats - Pool statistics (internal use)
 *
 * Security:
 * - Protected routes require an API key in production
 * - Credentials passed in the request body, injected as env vars to spawned
 *   processes; a pooled process is replaced when they change
 * - Process-per-user isolation
 */

import { serve } from "@hono/node-server";
import { registerHttpServerShutdown } from "@repo/observability/http-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { z } from "zod/v4";

import { CatalogLaunchError, validateCatalogLaunch } from "./catalog-command";
import { internalOnlyMiddleware } from "./middleware/internal-only";
import {
	getProcessPool,
	hashCredentials,
	type ProcessPoolConfig,
	shutdownProcessPool,
} from "./process-pool";
import { createStdioTransport, StdioRpcError } from "./stdio-transport";

// =============================================================================
// Request Schemas
// =============================================================================

const McpCallRequestSchema = z.object({
	/** Pinned catalog command (e.g., 'npx -y @azure-devops/mcp@2.8.0') */
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
	// Preserve the supplied names so the catalog policy can reject unknown keys.
	credentials: z
		.custom<Record<string, string>>(
			(value) =>
				typeof value === "object" &&
				value !== null &&
				!Array.isArray(value) &&
				Object.values(value).every((item) => typeof item === "string"),
			"Expected credential names mapped to strings.",
		)
		.optional(),
	/**
	 * How fresh `credentials` are, compared element by element
	 * (`compareCredentialsVersions`). A call whose credentials are older than
	 * the pooled process's gets a process of its own instead of replacing it.
	 */
	credentialsVersion: z.array(z.number().finite()).max(8).optional(),
});

export type McpCallRequest = z.infer<typeof McpCallRequestSchema>;

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
	/** Override the key used to authenticate protected routes. */
	internalApiKey?: string;
}

/**
 * Create the Hono application.
 */
export function createServer(config: ServerConfig = {}): Hono {
	const app = new Hono();
	const pool = getProcessPool(config.poolConfig);

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

	// Protect the MCP route subtree and pool statistics with the same middleware.
	const requireInternalAccess = internalOnlyMiddleware(config.internalApiKey);
	app.use("/mcp/*", requireInternalAccess);
	app.use("/stats", requireInternalAccess);

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
			const launch = { command, args, credentials };
			// Validate before pool lookup so a warm process cannot serve an invalid request.
			validateCatalogLaunch(launch);
			// Changes to the catalog command or arguments also require a new child.
			const launchHash = hashCredentials({
				...credentials,
				command,
				args: JSON.stringify(args),
			});

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

					const newTransport = await createStdioTransport(launch);
					try {
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
						await newTransport.close().catch(() => {});
						throw error;
					}

					return newTransport;
				},
				launchHash,
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
			if (error instanceof CatalogLaunchError) {
				return c.json({ success: false, error: error.message }, 400);
			}
			console.error("[MCP Call] Error:", error);
			if (error instanceof StdioRpcError) {
				return c.json({ success: false, error: error.message });
			}

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
