/**
 * VS Code Extension Integration Routes
 *
 * Provides endpoints for the Fabric Code VS Code extension:
 * - Device auth flow (code-based login)
 * - User profile
 * - AI model defaults
 * - OpenRouter-compatible proxy (models + chat completions)
 *
 * All endpoints except device auth initiation require:
 *   Authorization: Bearer fab_<prefix>_<secret>
 */

import { createHash, randomBytes } from "node:crypto";
import { getAIModelWithMetadata } from "@repo/ai/model-selector";
import { createUserApiKey, db } from "@repo/database";
import { streamText } from "ai";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { verifyUserApiKey } from "../users/procedures/api-keys/verify";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateDeviceCode(): string {
	const a = randomBytes(3).toString("hex").toUpperCase();
	const b = randomBytes(3).toString("hex").toUpperCase();
	return `${a}-${b}`; // e.g. "A1B2C3-D4E5F6"
}

function generateApiKey(): {
	rawKey: string;
	keyHash: string;
	keyPrefix: string;
} {
	const secret = randomBytes(24).toString("base64url");
	const prefix = randomBytes(4).toString("hex");
	const rawKey = `fab_${prefix}_${secret}`;
	const keyHash = createHash("sha256").update(rawKey).digest("hex");
	return { rawKey, keyHash, keyPrefix: `fab_${prefix}` };
}

const DEVICE_AUTH_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Bearer token → verified userId, or null */
async function authFromBearer(
	authHeader: string | undefined,
): Promise<string | null> {
	if (!authHeader?.startsWith("Bearer ")) {
		return null;
	}
	const token = authHeader.slice(7);
	if (!token.startsWith("fab_")) {
		return null;
	}
	const result = await verifyUserApiKey(token);
	return result.valid && result.userId ? result.userId : null;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function createVscodeAuthRoutes() {
	const app = new Hono();

	app.use(
		"*",
		cors({
			origin: "*",
			allowHeaders: ["Content-Type", "Authorization"],
			allowMethods: ["POST", "GET", "OPTIONS"],
			maxAge: 3600,
			credentials: false,
		}),
	);

	// =========================================================================
	// Device Auth (no API key required — code is the shared secret)
	// =========================================================================

	/**
	 * POST /api/device-auth/codes
	 * Initiate a device authorization. Returns code + verification URL.
	 */
	app.post("/device-auth/codes", async (c) => {
		const code = generateDeviceCode();
		const expiresAt = new Date(Date.now() + DEVICE_AUTH_TTL_MS);

		await db.verification.create({
			data: {
				identifier: `vscode-device-auth:${code}`,
				value: JSON.stringify({ status: "pending" }),
				expiresAt,
			},
		});

		// Resolve base URL — same logic as getBaseUrl() in @repo/utils
		const baseUrl =
			process.env.NEXT_PUBLIC_SITE_URL ||
			(process.env.NEXT_PUBLIC_VERCEL_URL
				? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`
				: `http://localhost:${process.env.PORT ?? 3001}`);

		return c.json({
			code,
			verificationUrl: `${baseUrl}/vscode-auth?code=${code}`,
			expiresIn: Math.floor(DEVICE_AUTH_TTL_MS / 1000),
		});
	});

	/**
	 * GET /api/device-auth/codes/:code
	 * Poll for authorization status.
	 * Returns 202 (pending), 200 (approved with token), 403 (denied), 410 (expired/not found).
	 */
	app.get("/device-auth/codes/:code", async (c) => {
		const code = c.req.param("code");

		const record = await db.verification.findFirst({
			where: { identifier: `vscode-device-auth:${code}` },
		});

		if (!record) {
			return c.json({ status: "expired" }, 410);
		}

		if (record.expiresAt < new Date()) {
			// Clean up expired record
			await db.verification
				.delete({ where: { id: record.id } })
				.catch(() => {});
			return c.json({ status: "expired" }, 410);
		}

		let payload: { status: string; token?: string; userEmail?: string };
		try {
			payload = JSON.parse(record.value);
		} catch {
			return c.json({ status: "expired" }, 410);
		}

		if (payload.status === "pending") {
			return c.json({ status: "pending" }, 202);
		}

		if (payload.status === "denied") {
			await db.verification
				.delete({ where: { id: record.id } })
				.catch(() => {});
			return c.json({ status: "denied" }, 403);
		}

		if (payload.status === "approved") {
			// Delete the record so it can only be consumed once
			await db.verification
				.delete({ where: { id: record.id } })
				.catch(() => {});
			return c.json({
				status: "approved",
				token: payload.token,
				userEmail: payload.userEmail,
			});
		}

		return c.json({ status: "pending" }, 202);
	});

	// =========================================================================
	// Profile (requires fab_* API key)
	// =========================================================================

	/**
	 * GET /api/profile
	 * Returns user profile and organization list.
	 */
	app.get("/profile", async (c) => {
		const userId = await authFromBearer(c.req.header("Authorization"));
		if (!userId) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const [user, memberships] = await Promise.all([
			db.user.findUnique({
				where: { id: userId },
				select: { id: true, email: true, name: true },
			}),
			db.member.findMany({
				where: { userId },
				include: { organization: { select: { id: true, name: true } } },
			}),
		]);

		if (!user) {
			return c.json({ error: "User not found" }, 404);
		}

		const organizations = memberships.map((m) => ({
			id: m.organization.id,
			name: m.organization.name,
			role: m.role,
		}));

		return c.json({
			user: { email: user.email, name: user.name ?? undefined },
			organizations,
		});
	});

	/**
	 * GET /api/profile/balance
	 * Returns account balance (AI credits). Always zero: Fabric no longer sells
	 * or grants AI credits — a user-facing AI call runs on a provider the tenant
	 * configured, or it does not run (Fizzy #1875).
	 *
	 * The route itself stays. It is consumed by released versions of the VS Code
	 * extension that this repository cannot upgrade, and its own contract already
	 * anticipated this outcome ("returns 0 for plans without credits"), so
	 * answering zero keeps every deployed client working. Deleting it would turn
	 * a well-defined zero into a 404 for clients that have no way to know better.
	 */
	app.get("/profile/balance", async (c) => {
		const userId = await authFromBearer(c.req.header("Authorization"));
		if (!userId) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		return c.json({ balance: 0 });
	});

	// =========================================================================
	// Model Defaults (requires fab_* API key)
	// =========================================================================

	/**
	 * GET /api/defaults
	 * Returns default model IDs for authenticated user.
	 */
	app.get("/defaults", async (c) => {
		const userId = await authFromBearer(c.req.header("Authorization"));
		if (!userId) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		return c.json({
			defaultModel: "fabric/auto",
			defaultFreeModel: "fabric/fast",
		});
	});

	/**
	 * GET /api/organizations/:orgId/defaults
	 * Returns default model IDs for an organization context.
	 */
	app.get("/organizations/:orgId/defaults", async (c) => {
		const userId = await authFromBearer(c.req.header("Authorization"));
		if (!userId) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		return c.json({
			defaultModel: "fabric/auto",
			defaultFreeModel: "fabric/fast",
		});
	});

	// =========================================================================
	// OpenRouter-compatible Proxy (requires fab_* API key)
	// =========================================================================

	/** Map fabric/ model IDs to task complexity */
	function modelToComplexity(modelId: string): {
		taskType: "CHAT";
		complexity: "simple" | "medium" | "complex";
	} {
		if (modelId === "fabric/fast" || modelId === "fabric/simple") {
			return { taskType: "CHAT", complexity: "simple" };
		}
		if (modelId === "fabric/smart" || modelId === "fabric/frontier") {
			return { taskType: "CHAT", complexity: "complex" };
		}
		// fabric/auto and everything else → medium
		return { taskType: "CHAT", complexity: "medium" };
	}

	/**
	 * GET /api/openrouter/models
	 * Returns available models in OpenRouter format.
	 * The extension uses this to populate the model picker.
	 */
	app.get("/openrouter/models", async (c) => {
		const userId = await authFromBearer(c.req.header("Authorization"));
		if (!userId) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const models = [
			{
				id: "fabric/auto",
				name: "Fabric Auto",
				description:
					"Automatically selects the best model for your task",
				context_length: 200000,
				max_completion_tokens: 8192,
				pricing: { prompt: "0", completion: "0" },
				architecture: {
					input_modalities: ["text"],
					output_modalities: ["text"],
					tokenizer: "unknown",
				},
				supported_parameters: ["tools", "temperature"],
				preferredIndex: 0,
			},
			{
				id: "fabric/fast",
				name: "Fabric Fast",
				description: "Speed-optimized model for quick responses",
				context_length: 100000,
				max_completion_tokens: 4096,
				pricing: { prompt: "0", completion: "0" },
				architecture: {
					input_modalities: ["text"],
					output_modalities: ["text"],
					tokenizer: "unknown",
				},
				supported_parameters: ["tools", "temperature"],
				preferredIndex: 1,
			},
			{
				id: "fabric/smart",
				name: "Fabric Smart",
				description: "Most capable model for complex reasoning",
				context_length: 200000,
				max_completion_tokens: 16384,
				pricing: { prompt: "0", completion: "0" },
				architecture: {
					input_modalities: ["text", "image"],
					output_modalities: ["text"],
					tokenizer: "unknown",
				},
				supported_parameters: ["tools", "temperature"],
				preferredIndex: 2,
			},
		];

		return c.json({ data: models });
	});

	/**
	 * POST /api/openrouter/chat/completions
	 * OpenAI-compatible streaming chat endpoint.
	 * Resolves the user's configured AI provider and streams back completions.
	 */
	app.post("/openrouter/chat/completions", async (c) => {
		// Auth
		const authHeader = c.req.header("Authorization");
		const orgHeader = c.req.header("x-fabriccode-organizationid");

		if (!authHeader?.startsWith("Bearer ")) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const token = authHeader.slice(7);
		if (!token.startsWith("fab_")) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const authResult = await verifyUserApiKey(token);
		if (!authResult.valid || !authResult.userId) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const userId = authResult.userId;
		const organizationId = orgHeader || undefined;

		// Parse request body
		let body: {
			model?: string;
			messages?: Array<{
				role: string;
				content: string | Array<{ type: string; text?: string }>;
			}>;
			stream?: boolean;
			temperature?: number;
			max_tokens?: number;
		};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const {
			model: modelId = "fabric/auto",
			messages = [],
			stream = true,
		} = body;

		if (!messages.length) {
			return c.json({ error: "messages array is required" }, 400);
		}

		// Resolve AI model from user's configured provider
		const { taskType, complexity } = modelToComplexity(modelId);
		let aiModelResult: Awaited<ReturnType<typeof getAIModelWithMetadata>>;
		try {
			aiModelResult = await getAIModelWithMetadata(
				{ taskType, complexity },
				{ userId, organizationId },
			);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "No AI provider configured";
			return c.json({ error: message }, 400);
		}

		const { model: aiModel, metadata, trackUsage } = aiModelResult;

		// Normalize messages to ModelMessage format (AI SDK v6)
		const modelMessages = messages.map((m) => ({
			role: m.role as "system" | "user" | "assistant",
			content:
				typeof m.content === "string"
					? m.content
					: m.content
							.filter((p) => p.type === "text")
							.map((p) => p.text ?? "")
							.join(""),
		}));

		if (!stream) {
			// Non-streaming fallback
			try {
				const { generateText } = await import("ai");
				const result = await generateText({
					model: aiModel,
					messages: modelMessages,
				});
				trackUsage();
				return c.json({
					id: `chatcmpl-${Date.now()}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: metadata.modelString,
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: result.text,
							},
							finish_reason: "stop",
						},
					],
				});
			} catch (err) {
				return c.json(
					{ error: err instanceof Error ? err.message : "AI error" },
					500,
				);
			}
		}

		// Streaming response in OpenAI SSE format
		const completionId = `chatcmpl-${Date.now()}`;
		const created = Math.floor(Date.now() / 1000);
		const resolvedModel = metadata.modelString;

		let textStream: ReturnType<typeof streamText>;
		try {
			textStream = streamText({
				model: aiModel,
				messages: modelMessages,
				maxRetries: 0,
				onFinish() {
					trackUsage();
				},
			});
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "AI provider error";
			return c.json({ error: message }, 500);
		}

		const readableStream = new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();

				const send = (data: object) => {
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
					);
				};

				let promptTokens = 0;
				let completionTokens = 0;

				try {
					for await (const delta of textStream.textStream) {
						send({
							id: completionId,
							object: "chat.completion.chunk",
							created,
							model: resolvedModel,
							choices: [
								{
									index: 0,
									delta: { content: delta },
									finish_reason: null,
								},
							],
						});
					}
					// Resolve usage after stream completes — avoids NaN in CLI token accounting
					const usage = await textStream.usage;
					promptTokens = usage.inputTokens ?? 0;
					completionTokens = usage.outputTokens ?? 0;
				} catch {
					// Stream error — close gracefully
				}

				// Final stop chunk — include usage so CLI token counts are never NaN
				send({
					id: completionId,
					object: "chat.completion.chunk",
					created,
					model: resolvedModel,
					choices: [
						{
							index: 0,
							delta: {},
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: promptTokens,
						completion_tokens: completionTokens,
						total_tokens: promptTokens + completionTokens,
					},
				});

				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});

		return new Response(readableStream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			},
		});
	});

	return app;
}

// ---------------------------------------------------------------------------
// Server Action helpers (used by the /vscode-auth Next.js page)
// ---------------------------------------------------------------------------

export interface ApproveDeviceCodeResult {
	ok: boolean;
	error?: string;
}

/**
 * Approve a device auth code for the given user.
 * Creates a fab_* API key scoped to VS Code use and marks the code as approved.
 * Called from the /vscode-auth page server action.
 */
export async function approveDeviceCode(
	code: string,
	userId: string,
	userEmail: string,
): Promise<ApproveDeviceCodeResult> {
	const record = await db.verification.findFirst({
		where: { identifier: `vscode-device-auth:${code}` },
	});

	if (!record) {
		return { ok: false, error: "Code not found or expired" };
	}

	if (record.expiresAt < new Date()) {
		await db.verification
			.delete({ where: { id: record.id } })
			.catch(() => {});
		return { ok: false, error: "Code has expired" };
	}

	let payload: { status: string };
	try {
		payload = JSON.parse(record.value);
	} catch {
		return { ok: false, error: "Invalid code record" };
	}

	if (payload.status !== "pending") {
		return { ok: false, error: "Code already used" };
	}

	// Create a dedicated API key for this VS Code installation
	const { rawKey, keyHash, keyPrefix } = generateApiKey();
	await createUserApiKey({
		userId,
		name: "Fabric Code - VS Code",
		keyHash,
		keyPrefix,
		// The extension needs MCP, and `mcp:read` / `mcp:write` reach every MCP
		// tool. `"*"` reached rather more: the audit log, agent execution, and
		// system health, none of which this key was issued to do. It also meant
		// the broadest credential in the product was the one handed out with a
		// single click, to anyone, with no screen that could list or revoke it.
		//
		// Safe to narrow: this module's own routes authenticate through
		// `verifyUserApiKey` with no required scope (see `authFromBearer`), so
		// nothing the extension already calls reads scopes at all.
		scopes: ["mcp:read", "mcp:write"],
	});

	// Mark the code as approved
	await db.verification.update({
		where: { id: record.id },
		data: {
			value: JSON.stringify({
				status: "approved",
				token: rawKey,
				userEmail,
			}),
		},
	});

	return { ok: true };
}

/**
 * Deny a device auth code.
 * Called from the /vscode-auth page server action.
 */
export async function denyDeviceCode(
	code: string,
): Promise<ApproveDeviceCodeResult> {
	const record = await db.verification.findFirst({
		where: { identifier: `vscode-device-auth:${code}` },
	});

	if (!record) {
		return { ok: false, error: "Code not found or already used" };
	}

	await db.verification.update({
		where: { id: record.id },
		data: { value: JSON.stringify({ status: "denied" }) },
	});

	return { ok: true };
}
