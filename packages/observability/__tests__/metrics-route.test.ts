/**
 * Tests for the shared metrics endpoint helpers.
 *
 * Uses a real `http.Server` for `createMetricsHttpServer` and an inline
 * Hono stub for `mountMetricsRoute` (no Hono dep in observability).
 */

import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appErrorsTotal } from "../lib/app-metrics";
import { register } from "../lib/metrics";
import {
	createMetricsHttpServer,
	mountMetricsRoute,
} from "../lib/metrics-route";

beforeEach(() => {
	appErrorsTotal.reset();
});

describe("mountMetricsRoute", () => {
	it("registers a GET /metrics handler that returns Prometheus exposition", async () => {
		const handlers = new Map<
			string,
			(c: HonoCtx) => Response | Promise<Response>
		>();

		interface HonoCtx {
			text: (
				body: string,
				status?: number,
				headers?: Record<string, string>,
			) => Response;
		}

		const fakeApp = {
			get(
				path: string,
				handler: (c: HonoCtx) => Response | Promise<Response>,
			) {
				handlers.set(path, handler);
			},
		};

		mountMetricsRoute(fakeApp);
		const handler = handlers.get("/metrics");
		expect(handler).toBeDefined();

		// Touch a metric so exposition is non-empty.
		appErrorsTotal.inc({
			service: "api",
			feature: "ai_generation",
			error_class: "5xx",
			organization_id: "personal",
		});

		const ctx: HonoCtx = {
			text(body, status, headers) {
				return new Response(body, { status, headers });
			},
		};
		const response = await handler!(ctx);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain("app_errors_total");
	});

	it("returns the app for chaining", () => {
		interface HonoCtx {
			text: (
				body: string,
				status?: number,
				headers?: Record<string, string>,
			) => Response;
		}
		const app = {
			get(
				_path: string,
				_handler: (c: HonoCtx) => Response | Promise<Response>,
			) {},
		};
		const returned = mountMetricsRoute(app);
		expect(returned).toBe(app);
	});
});

describe("createMetricsHttpServer", () => {
	let serverUrl = "";
	let serverInstance: ReturnType<typeof createMetricsHttpServer> | null =
		null;

	beforeEach(async () => {
		// Bind to an ephemeral port so concurrent tests don't collide.
		serverInstance = createMetricsHttpServer({ port: 0 });
		await new Promise<void>((resolve) =>
			serverInstance!.once("listening", resolve),
		);
		const addr = serverInstance!.address() as AddressInfo;
		serverUrl = `http://127.0.0.1:${addr.port}`;
	});

	afterEach(async () => {
		if (serverInstance) {
			await new Promise<void>((resolve) =>
				serverInstance!.close(() => resolve()),
			);
			serverInstance = null;
		}
	});

	it("serves /metrics with the Prometheus content type", async () => {
		appErrorsTotal.inc({
			service: "temporal-worker",
			feature: "temporal_activity",
			error_class: "activity_failure",
			organization_id: "personal",
		});

		const response = await fetch(`${serverUrl}/metrics`);
		expect(response.status).toBe(200);
		const ct = response.headers.get("content-type");
		expect(ct).toContain("text/plain");
		const body = await response.text();
		expect(body).toContain("app_errors_total");
		expect(body).toContain('service="temporal-worker"');
	});

	it("returns 404 for unknown paths", async () => {
		const response = await fetch(`${serverUrl}/nope`);
		expect(response.status).toBe(404);
	});

	it("responds to /health with 200 ok", async () => {
		const response = await fetch(`${serverUrl}/health`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
	});

	it("rejects non-GET with 405", async () => {
		const response = await fetch(`${serverUrl}/metrics`, {
			method: "POST",
		});
		expect(response.status).toBe(405);
	});

	it("exposes the shared registry — same metrics as register.metrics()", async () => {
		appErrorsTotal.inc({
			service: "api",
			feature: "payments",
			error_class: "5xx",
			organization_id: "personal",
		});
		const fromServer = await fetch(`${serverUrl}/metrics`).then((r) =>
			r.text(),
		);
		const fromRegister = await register.metrics();
		expect(fromServer).toBe(fromRegister);
	});
});
