import { getBaseUrl } from "@repo/utils";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

/** The local Fabric Kanban runtime, which calls this API in every environment. */
const KANBAN_RUNTIME_ORIGIN = "http://localhost:3484";

/** The web app's own dev server; never a caller of a deployed API. */
const LOCAL_DEVELOPMENT_ORIGINS = ["http://localhost:3001"];

/**
 * Surfaces that authenticate with a bearer API key, never cookies, and carry
 * their own CORS policy: the public API and the VS Code extension's endpoints.
 * The credentialed application policy must not touch them, or both policies
 * would write to the same response and a wildcard origin would end up beside
 * `Access-Control-Allow-Credentials: true`.
 */
const OWN_POLICY_PATH =
	/^\/api\/(v1|device-auth|profile|openrouter)(\/|$)|^\/api\/defaults$|^\/api\/organizations\/[^/]+\/defaults$/;

function allowedOrigins(): string[] {
	const origins = [getBaseUrl(), KANBAN_RUNTIME_ORIGIN];

	if (process.env.NODE_ENV !== "production") {
		origins.push(...LOCAL_DEVELOPMENT_ORIGINS);
	}

	const additionalOrigins = process.env.CORS_ALLOWED_ORIGINS;
	if (additionalOrigins) {
		origins.push(
			...additionalOrigins
				.split(",")
				.map((origin) => origin.trim())
				.filter(Boolean),
		);
	}

	return origins;
}

const applicationCors = cors({
	origin: (origin) =>
		allowedOrigins().includes(origin) ? origin : getBaseUrl(),
	allowHeaders: [
		"Content-Type",
		"Authorization",
		"X-Correlation-ID",
		"X-Request-ID",
	],
	allowMethods: ["POST", "GET", "OPTIONS", "PUT", "DELETE"],
	exposeHeaders: [
		"Content-Length",
		"X-Correlation-ID",
		"X-RateLimit-Limit",
		"X-RateLimit-Remaining",
		"X-RateLimit-Reset",
		"Retry-After",
	],
	maxAge: 600,
	credentials: true,
});

/**
 * Credentialed CORS for the application's own API. Origins are echoed only
 * from an allowlist (the app's base URL, the Kanban runtime,
 * `CORS_ALLOWED_ORIGINS`, and the web dev server outside production), never
 * `*`.
 */
export const applicationCorsMiddleware: MiddlewareHandler = (c, next) =>
	OWN_POLICY_PATH.test(c.req.path) ? next() : applicationCors(c, next);
