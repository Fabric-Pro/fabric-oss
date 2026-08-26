/**
 * Helpers for exposing the Prometheus `/metrics` endpoint.
 *
 * Two shapes are supported:
 *   - {@link mountMetricsRoute} — register the route on an existing Hono app
 *     (used by the API server and every LangGraph TS agent).
 *   - {@link createMetricsHttpServer} — spin up a minimal Node `http` server
 *     dedicated to scraping (used by the Temporal worker, which has no
 *     embedded HTTP framework).
 *
 * The endpoint is ungated by auth — it is meant to be exposed only on the
 * internal container network. Production deployments restrict access via
 * Bicep ingress rules.
 */

import { createServer, type Server } from "node:http";
import { register } from "./metrics";

const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * A minimal subset of the Hono API we depend on. We keep the interface
 * structural so consumers can pass any Hono v4 / v5 instance without us
 * pulling Hono in as a runtime dep of `@repo/observability`.
 */
interface HonoLike {
	get: (
		path: string,
		handler: (c: HonoContextLike) => Response | Promise<Response>,
	) => unknown;
}

interface HonoContextLike {
	text: (
		body: string,
		status?: number,
		headers?: Record<string, string>,
	) => Response;
}

/**
 * Mount the `GET /metrics` route on the given Hono-like app.
 *
 * Returns the app for chaining. The route path is fixed at `/metrics` —
 * callers that need a different mount path should call `register.metrics()`
 * directly.
 */
export function mountMetricsRoute<T extends HonoLike>(app: T): T {
	app.get("/metrics", async (c) => {
		const body = await register.metrics();
		return c.text(body, 200, {
			"Content-Type": register.contentType ?? PROMETHEUS_CONTENT_TYPE,
		});
	});
	return app;
}

export interface MetricsHttpServerOptions {
	/** Listen port. Defaults to 9464 (Prometheus convention for non-HTTP apps). */
	port?: number;
	/** Bind host. Defaults to "0.0.0.0". */
	host?: string;
	/** Optional URL path. Defaults to "/metrics". */
	path?: string;
}

/**
 * Create + start a minimal HTTP server that serves the Prometheus scrape
 * endpoint. Returns the underlying `http.Server` so callers can attach
 * shutdown handlers.
 *
 * Used by the Temporal worker because it has no embedded HTTP framework.
 */
export function createMetricsHttpServer(
	options: MetricsHttpServerOptions = {},
): Server {
	const port = options.port ?? 9464;
	const host = options.host ?? "0.0.0.0";
	const path = options.path ?? "/metrics";

	const server = createServer(async (req, res) => {
		if (req.method !== "GET") {
			res.writeHead(405, { Allow: "GET" });
			res.end();
			return;
		}
		// Allow query strings; only the pathname must match.
		const url = req.url ?? "";
		const pathname = url.split("?", 1)[0];
		if (pathname !== path && pathname !== "/health") {
			res.writeHead(404);
			res.end();
			return;
		}
		if (pathname === "/health") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("ok");
			return;
		}
		try {
			const body = await register.metrics();
			res.writeHead(200, {
				"Content-Type": register.contentType ?? PROMETHEUS_CONTENT_TYPE,
			});
			res.end(body);
		} catch (err) {
			res.writeHead(500, { "Content-Type": "text/plain" });
			res.end(
				`failed to collect metrics: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	server.listen(port, host);
	return server;
}
