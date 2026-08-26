/**
 * External API Routes
 *
 * Hono route group for the external agent API gateway.
 * Authenticated via API keys (fab_* / org_*), not sessions.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { requireApiKey, requireScope } from "./middleware/api-key-auth";
import { externalApiRateLimit } from "./middleware/api-rate-limit";
import { usageLogger } from "./middleware/usage-logger";
import { executeAgent } from "./procedures/execute-agent";
import { getExposedAgent } from "./procedures/get-agent";
import { getExecution } from "./procedures/get-execution";
import { listExposedAgents } from "./procedures/list-agents";
import { generateOpenApiSpec } from "./procedures/openapi-docs";
import { createExecutionStreamHandler } from "./procedures/stream-execution";
import {
	handleFileUpload,
	validateFileIdTenant,
} from "./procedures/upload-file";
import type { ExternalApiVariables } from "./types";

export function createExternalApiRoutes() {
	const app = new Hono<{ Variables: ExternalApiVariables }>();

	// Relaxed CORS for external consumers (API key auth, not cookies)
	app.use(
		"*",
		cors({
			origin: "*",
			allowHeaders: [
				"Content-Type",
				"Authorization",
				"X-Correlation-ID",
				"X-Idempotency-Key",
			],
			allowMethods: ["POST", "GET", "OPTIONS"],
			exposeHeaders: [
				"X-Correlation-ID",
				"X-RateLimit-Limit",
				"X-RateLimit-Remaining",
				"X-RateLimit-Reset",
				"Retry-After",
				"X-Execution-Id",
			],
			maxAge: 3600,
			credentials: false,
		}),
	);

	// API key authentication on all routes
	app.use("*", requireApiKey());

	// Rate limiting (per API key)
	app.use("*", externalApiRateLimit("agent"));

	// Usage logging (fire-and-forget, after handler)
	app.use("*", usageLogger());

	// =========================================================================
	// Agent Endpoints
	// =========================================================================

	/**
	 * GET /agents — List all API-exposed agents for this key's tenant
	 */
	app.get("/agents", requireScope("agents:read"), async (c) => {
		const ctx = c.get("externalApiContext");
		const agents = await listExposedAgents(ctx);
		return c.json(agents);
	});

	/**
	 * GET /agents/:instanceId — Get agent metadata and input schema
	 */
	app.get("/agents/:instanceId", requireScope("agents:read"), async (c) => {
		const ctx = c.get("externalApiContext");
		const instanceId = c.req.param("instanceId")!;
		const agent = await getExposedAgent(instanceId, ctx);

		if (!agent) {
			return c.json({ error: "Agent not found" }, 404);
		}

		return c.json(agent);
	});

	/**
	 * POST /agents/files — Upload a file (image) for use in agent execution
	 */
	app.post("/agents/files", requireScope("agents:execute"), async (c) => {
		const ctx = c.get("externalApiContext");

		let formData: FormData;
		try {
			formData = await c.req.formData();
		} catch {
			return c.json({ error: "Invalid multipart/form-data body" }, 400);
		}

		const file = formData.get("file") as File | null;
		if (!file) {
			return c.json({ error: "No file provided" }, 400);
		}

		const result = await handleFileUpload(file, ctx);
		if ("error" in result) {
			return c.json({ error: result.error }, result.status);
		}

		return c.json(result.data);
	});

	/**
	 * POST /agents/:instanceId/execute — Trigger agent execution
	 */
	app.post(
		"/agents/:instanceId/execute",
		requireScope("agents:execute"),
		async (c) => {
			const ctx = c.get("externalApiContext");
			const instanceId = c.req.param("instanceId")!;

			let body: {
				input: Record<string, unknown>;
				priority?: string;
				idempotencyKey?: string;
				stream?: boolean;
				images?: Array<{
					fileId: string;
					mimeType: string;
					name?: string;
				}>;
			};
			try {
				body = await c.req.json();
			} catch {
				return c.json({ error: "Invalid JSON body" }, 400);
			}

			if (
				!body.input ||
				typeof body.input !== "object" ||
				Array.isArray(body.input)
			) {
				return c.json(
					{ error: "Request body must include an 'input' object" },
					400,
				);
			}

			// Validate and resolve image references
			let imageRefs:
				| Array<{
						storagePath: string;
						mimeType: string;
						name: string;
				  }>
				| undefined;

			const MAX_IMAGES_PER_REQUEST = 5;

			if (
				body.images &&
				Array.isArray(body.images) &&
				body.images.length > 0
			) {
				if (body.images.length > MAX_IMAGES_PER_REQUEST) {
					return c.json(
						{
							error: `Too many images: maximum ${MAX_IMAGES_PER_REQUEST} per request`,
						},
						400,
					);
				}
				imageRefs = [];
				for (const img of body.images) {
					if (!img.fileId || !img.mimeType) {
						return c.json(
							{
								error: "Each image must have fileId and mimeType",
							},
							400,
						);
					}

					const validation = validateFileIdTenant(img.fileId, ctx);
					if (!validation.valid) {
						return c.json({ error: validation.error }, 403);
					}

					imageRefs.push({
						storagePath: validation.storagePath,
						mimeType: img.mimeType,
						name: img.name || "image",
					});
				}
			}

			// Check stream scope before starting the execution to avoid
			// creating a workflow the caller can't actually stream
			if (body.stream) {
				const apiCtx = c.get("externalApiContext");
				if (
					!apiCtx.scopes.includes("agents:stream") &&
					!apiCtx.scopes.includes("*")
				) {
					return c.json(
						{ error: "Missing required scope: agents:stream" },
						403,
					);
				}
			}

			const result = await executeAgent(
				instanceId,
				{
					input: body.input,
					priority: body.priority as
						| "LOW"
						| "NORMAL"
						| "HIGH"
						| "CRITICAL",
					idempotencyKey:
						body.idempotencyKey ||
						c.req.header("X-Idempotency-Key") ||
						undefined,
					stream: body.stream,
					imageRefs,
				},
				ctx,
			);

			if ("error" in result) {
				return c.json({ error: result.error }, result.status);
			}

			// Set execution context for usage logger
			c.set("executionId", result.data.executionId);
			c.set("deploymentId", result.data.deploymentId);

			// If streaming requested, return SSE stream
			if (body.stream && result.status === 202) {
				const data = result.data as {
					executionId: string;
					workflowId?: string;
					workflowExecutionId?: string;
				};

				if (data.workflowId) {
					const { createExecutionEventStream } = await import(
						"./lib/execution-stream"
					);

					// Use the workflow's UUID executionId for Redis channel matching
					const streamExecutionId =
						data.workflowExecutionId || data.executionId;

					const eventStream = createExecutionEventStream(
						streamExecutionId,
						data.workflowId,
					);

					return new Response(eventStream, {
						headers: {
							"Content-Type": "text/event-stream",
							"Cache-Control": "no-cache",
							Connection: "keep-alive",
							"X-Execution-Id": data.executionId,
						},
					});
				}
			}

			return c.json(result.data, result.status);
		},
	);

	// =========================================================================
	// Execution Endpoints
	// =========================================================================

	/**
	 * GET /executions/:executionId — Poll execution status/result
	 */
	app.get(
		"/executions/:executionId",
		requireScope("agents:read"),
		async (c) => {
			const ctx = c.get("externalApiContext");
			const executionId = c.req.param("executionId")!;
			const execution = await getExecution(executionId, ctx);

			if (!execution) {
				return c.json({ error: "Execution not found" }, 404);
			}

			return c.json(execution);
		},
	);

	/**
	 * GET /executions/:executionId/stream — SSE stream for execution progress
	 */
	app.get(
		"/executions/:executionId/stream",
		requireScope("agents:stream"),
		createExecutionStreamHandler(),
	);

	// =========================================================================
	// Documentation
	// =========================================================================

	/**
	 * GET /docs/openapi.json — Dynamic OpenAPI spec for this key's agents
	 */
	app.get("/docs/openapi.json", requireScope("agents:read"), async (c) => {
		const ctx = c.get("externalApiContext");
		const spec = await generateOpenApiSpec(ctx);
		return c.json(spec);
	});

	return app;
}
