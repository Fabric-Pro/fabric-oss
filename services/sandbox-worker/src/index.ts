/**
 * Fabric Sandbox Worker - Entry Point
 *
 * Provides isolated code execution environment for AI agents.
 * Called from Fabric's Temporal workers via HTTP API.
 *
 * ISOLATION MODEL:
 * - Sessions are isolated by tenant context (userId + organizationId)
 * - Session IDs include tenant hash for namespacing
 * - All operations verify the caller matches the session owner
 * - Personal accounts (no org) are isolated from organization accounts
 * - Different organizations are fully isolated from each other
 */

import { Sandbox } from "@cloudflare/sandbox";
import { verifyAuth } from "./auth";
import { executeDynamicWorkerCode } from "./dynamic-worker-executor";
import { SessionDO } from "./SessionDO";
import type {
	CommitRequest,
	CreateSessionRequest,
	Env,
	ExecRequest,
	ExecuteCodeRequest,
	PushRequest,
	RunClaudeRequest,
} from "./types";
import { ExecRequestSchema } from "./types";
import {
	corsResponse,
	errorResponse,
	generateSessionId,
	successResponse,
} from "./utils";

// Export Durable Objects for Cloudflare
export { SessionDO };
export { Sandbox };

export default {
	async fetch(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Handle CORS preflight
		if (request.method === "OPTIONS") {
			return corsResponse();
		}

		// Health check (no auth required)
		if (url.pathname === "/health" && request.method === "GET") {
			return successResponse({
				status: "healthy",
				environment: env.ENVIRONMENT,
				timestamp: new Date().toISOString(),
			});
		}

		// All other routes require authentication
		const auth = await verifyAuth(request, env);
		if (!auth) {
			return errorResponse(
				"UNAUTHORIZED",
				"Authentication required",
				401,
			);
		}

		const { userId, organizationId } = auth;

		// Route handling
		try {
			// POST /execute - Execute JS/TS in a stateless Dynamic Worker
			if (url.pathname === "/execute" && request.method === "POST") {
				const body = (await request.json()) as ExecuteCodeRequest;

				if (!body.code?.trim()) {
					return errorResponse(
						"BAD_REQUEST",
						"code is required",
						400,
					);
				}

				if (
					body.language !== "javascript" &&
					body.language !== "typescript"
				) {
					return errorResponse(
						"BAD_REQUEST",
						"language must be javascript or typescript",
						400,
					);
				}

				// The Dynamic Worker Loader is a closed beta this account is not
				// allowlisted for, so the binding cannot be declared without
				// failing every deploy. Refuse with a reason rather than throwing
				// a binding error: the caller learns the capability is absent,
				// which is what it already experienced as a 404 from the last
				// deployable build.
				if (!env.LOADER) {
					return errorResponse(
						"NOT_IMPLEMENTED",
						"Dynamic code execution is unavailable: this deployment has no Dynamic Worker Loader binding.",
						501,
					);
				}

				const result = await executeDynamicWorkerCode(env, body);
				return successResponse(result);
			}

			// POST /sessions - Create new session
			if (url.pathname === "/sessions" && request.method === "POST") {
				const body = (await request.json()) as CreateSessionRequest;
				const sessionId = generateSessionId();

				// Get SessionDO stub
				const sessionDoId = env.SESSION_DO.idFromName(sessionId);
				const sessionStub = env.SESSION_DO.get(
					sessionDoId,
				) as DurableObjectStub & {
					createSession: (
						sessionId: string,
						userId: string,
						organizationId: string | undefined,
						request: CreateSessionRequest,
					) => Promise<unknown>;
				};

				const result = await sessionStub.createSession(
					sessionId,
					userId,
					organizationId,
					body,
				);

				return successResponse(result);
			}

			// Session-specific routes
			// All operations pass userId + organizationId for tenant verification
			const sessionMatch = url.pathname.match(
				/^\/sessions\/([^/]+)(\/.*)?$/,
			);
			if (sessionMatch) {
				const sessionId = sessionMatch[1];
				const subPath = sessionMatch[2] || "";

				// Get SessionDO stub with auth-aware methods
				const sessionDoId = env.SESSION_DO.idFromName(sessionId);
				const sessionStub = env.SESSION_DO.get(
					sessionDoId,
				) as DurableObjectStub & {
					getSessionInfo: (
						sessionId: string,
						userId: string,
						organizationId?: string,
					) => Promise<unknown>;
					runClaude: (
						sessionId: string,
						userId: string,
						organizationId: string | undefined,
						request: RunClaudeRequest,
						anthropicApiKey: string,
					) => Promise<unknown>;
					exec: (
						sessionId: string,
						userId: string,
						organizationId?: string,
						request?: ExecRequest,
					) => Promise<unknown>;
					getDiff: (
						sessionId: string,
						userId: string,
						organizationId?: string,
						staged?: boolean,
					) => Promise<unknown>;
					commit: (
						sessionId: string,
						userId: string,
						organizationId?: string,
						request?: CommitRequest,
					) => Promise<unknown>;
					push: (
						sessionId: string,
						userId: string,
						organizationId?: string,
						request?: PushRequest,
					) => Promise<unknown>;
					readFile: (
						sessionId: string,
						userId: string,
						organizationId?: string,
						path?: string,
					) => Promise<unknown>;
					writeFile: (
						sessionId: string,
						userId: string,
						organizationId: string | undefined,
						path: string,
						content: string,
					) => Promise<unknown>;
					destroySession: (
						sessionId: string,
						userId: string,
						organizationId?: string,
					) => Promise<void>;
				};

				// GET /sessions/:id - Get session info (verifies ownership)
				if (subPath === "" && request.method === "GET") {
					const info = await sessionStub.getSessionInfo(
						sessionId,
						userId,
						organizationId,
					);
					if (!info) {
						return errorResponse(
							"NOT_FOUND",
							"Session not found",
							404,
						);
					}
					return successResponse(info);
				}

				// POST /sessions/:id/claude - Run Claude Code
				if (subPath === "/claude" && request.method === "POST") {
					const body = (await request.json()) as RunClaudeRequest & {
						anthropicApiKey: string;
					};

					if (!body.anthropicApiKey) {
						return errorResponse(
							"BAD_REQUEST",
							"anthropicApiKey is required",
							400,
						);
					}

					const result = await sessionStub.runClaude(
						sessionId,
						userId,
						organizationId,
						body,
						body.anthropicApiKey,
					);
					return successResponse(result);
				}

				// POST /sessions/:id/exec - Execute shell command
				if (subPath === "/exec" && request.method === "POST") {
					// A rejected env var name or an oversized value is the caller's
					// mistake, not ours. Letting `.parse` throw sent it to the outer
					// catch, which answered 500 INTERNAL_ERROR with the raw Zod issue
					// list — the wrong status to retry on, and it published the
					// schema's internals to anyone who could reach the endpoint.
					const parsed = ExecRequestSchema.safeParse(
						await request.json(),
					);
					if (!parsed.success) {
						return errorResponse(
							"BAD_REQUEST",
							"Invalid exec request. `command` is required; env var names must match [A-Za-z_][A-Za-z0-9_]*, with at most 32 vars and 64KB total.",
							400,
						);
					}
					const body = parsed.data;
					const result = await sessionStub.exec(
						sessionId,
						userId,
						organizationId,
						body,
					);
					return successResponse(result);
				}

				// GET /sessions/:id/diff - Get git diff
				if (subPath === "/diff" && request.method === "GET") {
					const staged = url.searchParams.get("staged") === "true";
					const result = await sessionStub.getDiff(
						sessionId,
						userId,
						organizationId,
						staged,
					);
					return successResponse(result);
				}

				// POST /sessions/:id/commit - Commit changes
				if (subPath === "/commit" && request.method === "POST") {
					const body = (await request.json()) as CommitRequest;
					const result = await sessionStub.commit(
						sessionId,
						userId,
						organizationId,
						body,
					);
					return successResponse(result);
				}

				// POST /sessions/:id/push - Push to remote
				if (subPath === "/push" && request.method === "POST") {
					const body = (await request.json()) as PushRequest;
					const result = await sessionStub.push(
						sessionId,
						userId,
						organizationId,
						body,
					);
					return successResponse(result);
				}

				// GET /sessions/:id/files?path=... - Read file
				if (subPath === "/files" && request.method === "GET") {
					const path = url.searchParams.get("path");
					if (!path) {
						return errorResponse(
							"BAD_REQUEST",
							"path is required",
							400,
						);
					}
					const result = await sessionStub.readFile(
						sessionId,
						userId,
						organizationId,
						path,
					);
					return successResponse(result);
				}

				// POST /sessions/:id/files - Write file
				if (subPath === "/files" && request.method === "POST") {
					const body = (await request.json()) as {
						path: string;
						content: string;
					};
					if (!body.path || body.content === undefined) {
						return errorResponse(
							"BAD_REQUEST",
							"path and content are required",
							400,
						);
					}
					const result = await sessionStub.writeFile(
						sessionId,
						userId,
						organizationId,
						body.path,
						body.content,
					);
					return successResponse(result);
				}

				// DELETE /sessions/:id - Destroy session
				if (subPath === "" && request.method === "DELETE") {
					await sessionStub.destroySession(
						sessionId,
						userId,
						organizationId,
					);
					return successResponse({ success: true });
				}

				return errorResponse("NOT_FOUND", "Endpoint not found", 404);
			}

			return errorResponse("NOT_FOUND", "Endpoint not found", 404);
		} catch (error) {
			console.error("Request error:", error);
			const message =
				error instanceof Error ? error.message : "Internal error";
			return errorResponse("INTERNAL_ERROR", message, 500);
		}
	},
} satisfies ExportedHandler<Env>;
