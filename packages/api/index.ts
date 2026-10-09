import { auth } from "@repo/auth";
import {
	clearLockout,
	recordFailedLogin,
	recordSuccessfulLogin,
} from "@repo/auth/lib/brute-force";
import { getTrustedClientIp } from "@repo/auth/lib/client-ip";
import { config } from "@repo/config";
import { db } from "@repo/database";
import { initAuditLogging, logger } from "@repo/logs";
import { webhookHandler as paymentsWebhookHandler } from "@repo/payments";
import { getBaseUrl } from "@repo/utils";
import { type ErrorHandler, Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { wireAuditObservability } from "./lib/audit";
import { authRateLimitMiddleware } from "./lib/auth-rate-limit";
import {
	asyncCorrelationMiddleware,
	correlationIdMiddleware,
} from "./lib/correlation-id";
import { applicationCorsMiddleware } from "./lib/cors-policy";
import { internalErrorBody } from "./lib/error-response";
import { lazyRoutes } from "./lib/lazy-routes";
import { generateRouterOpenApiSchema } from "./lib/openapi-generator";
import { mergeOpenApiSchemas } from "./lib/openapi-schema";
import { syncProviderRegistryOnce } from "./lib/provider-registry-sync";
import {
	getAuditLogOpenApiSpec,
	publicApiDocsEnabled,
} from "./modules/audit/rest/openapi-spec";
import { createVscodeAuthRoutes } from "./modules/vscode-auth/routes";
import { openApiHandler, rpcHandler } from "./orpc/handler";

// Initialize audit logging with external transport if configured
initAuditLogging();
// Wire audit-log Prometheus counters from @repo/observability into @repo/database.
// Must run before any procedure can fire a recordAudit/recordAuditTx call.
wireAuditObservability();

// Azure Application Insights (`initAppInsights()`) is initialised by the host
// (apps/web API route), after it has set the cloud role: initialising it here,
// at import, would build the client under the wrong role.

// Global error handler: always return JSON so oRPC client can parse errors
// (avoids "Cannot parse response body" when HTML error pages are returned)
const handleApiError: ErrorHandler = (err, c) => {
	logger.error("[API] Unhandled error:", err);
	return c.json(internalErrorBody(err), 500, {
		"Content-Type": "application/json",
	});
};

export const app = new Hono()
	.onError(handleApiError)
	.basePath("/api")
	// Correlation ID middleware - must be first for tracing
	.use(correlationIdMiddleware)
	.use(asyncCorrelationMiddleware)
	// Logger middleware
	.use(honoLogger((message, ...rest) => logger.log(message, ...rest)))
	// Boot-time provider registry sync, once the first request is handled
	.use(async (_c, next) => {
		await next();
		syncProviderRegistryOnce();
	})
	// Credentialed CORS for the app's own API; /api/v1 carries its own policies
	.use(applicationCorsMiddleware)
	// Auth rate limiting - runs before Better Auth to throttle brute force attempts
	.use("/auth/*", authRateLimitMiddleware())
	// Auth handler
	.on(["POST", "GET"], "/auth/*", async (c) => {
		try {
			// Clone request body for brute force tracking (before auth.handler consumes it)
			let loginEmail: string | undefined;
			let loginIp: string | undefined;
			let resetPasswordEmail: string | undefined;
			const isSignIn =
				c.req.path.includes("/sign-in/email") &&
				c.req.method === "POST";
			const isResetPassword =
				c.req.path.includes("/reset-password") &&
				c.req.method === "POST";

			let requestForAuth = c.req.raw;
			let resetPasswordUserId: string | undefined;
			if (isSignIn || isResetPassword) {
				try {
					const [forParsing, forAuth] = [
						c.req.raw.clone(),
						c.req.raw.clone(),
					];
					requestForAuth = forAuth;
					const body = await forParsing.json();
					if (isSignIn) {
						loginEmail = (body as { email?: string })?.email;
						loginIp = getTrustedClientIp(c.req.raw.headers);
					}
					if (isResetPassword) {
						// Better Auth stores reset tokens in the verification table as:
						//   identifier: "reset-password:<token>", value: "<userId>"
						// We look up the email BEFORE auth.handler, because auth.handler
						// deletes the verification record on success, and the response
						// is just { status: true } with no email field.
						const token = (body as { token?: string })?.token;
						if (token) {
							try {
								const verification =
									await db.verification.findFirst({
										where: {
											identifier: `reset-password:${token}`,
										},
										select: { value: true },
									});
								if (verification?.value) {
									resetPasswordUserId = verification.value;
									const user = await db.user.findFirst({
										where: { id: verification.value },
										select: { email: true },
									});
									resetPasswordEmail =
										user?.email ?? undefined;
								}
							} catch {
								// DB lookup failed — skip
							}
						}
					}
				} catch {
					// Body parse failed — skip tracking
				}
			}

			const response = await auth.handler(requestForAuth);

			// Brute force: clear lockout after successful password reset
			if (isResetPassword && response.ok && resetPasswordEmail) {
				try {
					await clearLockout(resetPasswordEmail);
				} catch (error) {
					logger.error(
						{
							event: "auth.bruteforce.clearLockout.error",
							security: true,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
						"Failed to clear lockout after password reset",
					);
				}
			}

			// Revoke all existing sessions for the user after a successful
			// password reset. Without this, a stolen session cookie remains
			// valid for its full lifetime (up to 30 days) even after the
			// victim resets their password.
			if (isResetPassword && response.ok && resetPasswordUserId) {
				try {
					await db.session.deleteMany({
						where: { userId: resetPasswordUserId },
					});
				} catch (error) {
					logger.error(
						{
							event: "auth.session.revokeOnReset.error",
							security: true,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
						"Failed to revoke sessions after password reset",
					);
				}
			}

			// Brute force: track login outcomes at the Hono level
			// (Better Auth after hooks don't fire on error responses)
			if (loginEmail) {
				try {
					if (response.status === 200) {
						recordSuccessfulLogin(loginEmail).catch(() => {});
					} else if (response.status === 401) {
						// Only count 401 (invalid credentials) as failures.
						// 403 (locked/forbidden) and 429 (backoff) are pre-check
						// rejections that should not increment the failure counter.
						recordFailedLogin(
							loginEmail,
							loginIp ?? "unknown",
						).catch(() => {});
					}
				} catch {
					// Swallow — don't break auth flow
				}
			}

			return response;
		} catch (error) {
			logger.error("[Auth] get-session or auth handler error:", error);
			return c.json(internalErrorBody(error), 500);
		}
	})
	// OpenAPI schema endpoint
	.get("/openapi", async (c) => {
		const authSchema = await auth.api.generateOpenAPISchema({});

		const appSchema = await generateRouterOpenApiSchema({
			info: {
				title: `${config.appName} API`,
				version: "1.0.0",
			},
			servers: [
				{
					url: getBaseUrl(),
					description: "API server",
				},
			],
		});

		const mergedSchema = mergeOpenApiSchemas({
			authSchema: authSchema as any,
			appSchema: appSchema as any,
		});

		return c.json(mergedSchema);
	})
	.get("/orpc-openapi", async (c) => {
		const appSchema = await generateRouterOpenApiSchema({
			info: {
				title: `${config.appName} API`,
				version: "1.0.0",
			},
		});

		return c.json(appSchema);
	})
	// Scalar API reference based on OpenAPI schema
	.get("/docs", async (c, next) => {
		const { Scalar } = await import("@scalar/hono-api-reference");
		return Scalar({
			theme: "saturn",
			url: "/api/openapi",
		})(c, next);
	})
	// Payments webhook handler
	.post("/webhooks/payments", (c) => paymentsWebhookHandler(c.req.raw))
	// Health check
	.get("/health", (c) => c.text("OK"))
	// Prometheus metrics scrape endpoint. Mirrors the auth model of the Next.js
	// route at apps/web/app/api/metrics/route.ts; this Hono route covers cases
	// where the API runs without Next.js in front (e.g., self-hosted Hono).
	.get("/metrics", async (c) => {
		// Auth (SOC 2 CC6.1): require the Bearer secret when METRICS_SECRET is
		// set; fail closed (404) in production when it is unset rather than
		// exposing metrics publicly (network-layer ingress rules don't protect
		// an internet-facing deployment). Dev with no secret stays open.
		const metricsSecret = process.env.METRICS_SECRET;
		if (metricsSecret) {
			if (c.req.header("authorization") !== `Bearer ${metricsSecret}`) {
				return c.json({ error: "Unauthorized" }, 401);
			}
		} else if (process.env.NODE_ENV === "production") {
			return c.body(null, 404);
		}
		// Dynamic import to avoid pulling prom-client into the cold start path
		// when no scraper has hit the route yet.
		const { register } = await import("@repo/observability");
		const body = await register.metrics();
		return c.text(body, 200, {
			"Content-Type": register.contentType,
		});
	})
	// VS Code extension integration (device auth, profile, openrouter proxy)
	.route("/", createVscodeAuthRoutes())
	// Public docs (Swagger UI + raw OpenAPI spec) for the audit-log REST API,
	// reachable without a key. The key middleware of the audit-log and
	// system-health sub-apps below is scoped to their own paths
	// (`/audit-log/*`, `/system-health/*`, `/status-updates/*`), so these
	// routes no longer depend on being registered first; the order is kept.
	// Env-gated so prod doesn't advertise the surface publicly.
	.get("/v1/openapi.json", (c) => {
		if (!publicApiDocsEnabled()) {
			// Return a 404 with the env-var hint in the body so operators
			// hitting the URL directly know exactly which switch to flip.
			// Production deployments leave this off intentionally; staging
			// and self-hosted should set FABRIC_PUBLIC_API_DOCS_ENABLED=true.
			return c.json(
				{
					error: "Not Found",
					hint: "Set FABRIC_PUBLIC_API_DOCS_ENABLED=true in the deployment environment to expose the OpenAPI spec.",
				},
				404,
			);
		}
		// Advertise the origin the caller actually reached us on, so a
		// self-hosted deployment that never set NEXT_PUBLIC_SITE_URL / APP_URL
		// still publishes usable curl examples instead of localhost.
		return c.json(getAuditLogOpenApiSpec(new URL(c.req.url).origin));
	})
	.get("/v1/docs", async (c, next) => {
		if (!publicApiDocsEnabled()) {
			// Friendly HTML response so a browser visitor on staging
			// without the env-var set sees the exact toggle to flip
			// rather than a bare JSON 404. Production keeps the docs
			// hidden by design.
			return c.html(
				`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Fabric Audit Log API — Docs disabled</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1.5rem; color: #1c1c1e; line-height: 1.6; }
h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
code { background: #f4f4f5; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.95em; }
.muted { color: #71717a; font-size: 0.9rem; margin-top: 1.5rem; }
</style>
</head>
<body>
<h1>API documentation is disabled in this environment</h1>
<p>The Swagger / Scalar UI at <code>/api/v1/docs</code> is gated by an environment variable. To enable it, set <code>FABRIC_PUBLIC_API_DOCS_ENABLED=true</code> in the deployment environment and redeploy.</p>
<p class="muted">Cloud production deployments leave this off intentionally so the public API surface is not advertised. The REST endpoints themselves (<code>GET /api/v1/audit-log</code>, <code>GET /api/v1/audit-log/export</code>) work in every environment regardless of this flag — only the docs UI is gated.</p>
</body>
</html>`,
				404,
			);
		}
		const { Scalar } = await import("@scalar/hono-api-reference");
		const handler = Scalar({
			theme: "saturn",
			pageTitle: "Fabric Audit Log API",
			url: "/api/v1/openapi.json",
		});
		return handler(c, next);
	})
	// The REST surfaces below import most of the monorepo, so they are built on
	// the first `/v1/*` request rather than on every cold start.
	.use(
		"/v1/*",
		lazyRoutes(async () => {
			const [
				{ createExternalApiRoutes },
				{ createAuditLogRestRoutes },
				{ createSystemHealthRestRoutes },
				{ createPublicV1Routes },
			] = await Promise.all([
				import("./modules/external-api/routes"),
				import("./modules/audit/rest/routes"),
				import("./modules/system-health/rest/routes"),
				import("./modules/v1/routes"),
			]);
			return (
				new Hono()
					.basePath("/api")
					// External API gateway (API key auth, agent execution)
					.route("/v1/external", createExternalApiRoutes())
					// Public audit-log REST API. Its key middleware covers
					// `/v1/audit-log` and `/v1/audit-log/*` only — never every `/v1`
					// request, which once refused the v1 API's own credentials (see
					// the sub-app).
					.route("/v1", createAuditLogRestRoutes())
					// Public system-health REST API. The same key middleware, scoped
					// to `/v1/system-health*` and `/v1/status-updates*`; each route
					// enforces its own scope, so an audit-log-only key is refused
					// here.
					.route("/v1", createSystemHealthRestRoutes())
					// Public v1 API — stable surface for @fabricorg/sdk and
					// @fabricorg/cli
					.route("/v1", createPublicV1Routes())
			);
		}, handleApiError),
	)
	// oRPC handlers (for RPC and OpenAPI)
	.use("*", async (c, next) => {
		const context = {
			headers: c.req.raw.headers,
		};

		const isRpc = c.req.path.includes("/rpc/");

		const handler = isRpc ? rpcHandler : openApiHandler;

		const prefix = isRpc ? "/api/rpc" : "/api";

		try {
			const { matched, response } = await handler.handle(c.req.raw, {
				prefix,
				context,
			});

			if (matched) {
				return c.newResponse(response.body, response);
			}

			await next();
		} catch (err) {
			// Ensure RPC errors return JSON (oRPC client expects JSON, not HTML)
			logger.error("[API] RPC handler error:", err);
			return c.json(internalErrorBody(err), 500, {
				"Content-Type": "application/json",
			});
		}
	});

// Audit log helpers (re-exported for procedure callsites that need request
// context. See `packages/api/lib/audit.ts` and the spec at
// `docs/audit-log/README.md §7.1).
export {
	type AuditRequestContext,
	type RecordAuditFromRequestInput,
	recordAuditFromRequest,
	wireAuditObservability,
} from "./lib/audit";
// VS Code auth helpers (used by web app Next.js route handlers)
export {
	approveDeviceCode,
	denyDeviceCode,
} from "./modules/vscode-auth/routes";
