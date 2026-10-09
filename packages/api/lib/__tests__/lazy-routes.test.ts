import { Hono } from "hono";
import { cors } from "hono/cors";
import { describe, expect, it, vi } from "vitest";
import { lazyRoutes } from "../lazy-routes";

function buildParent(load: () => Promise<Hono>) {
	const onError = vi.fn((_err: Error, c) =>
		c.json({ error: "handled" }, 500),
	);
	const parent = new Hono()
		.basePath("/api")
		.use("/v1/*", lazyRoutes(load, onError))
		.get("/v1/fallback", (c) => c.text("parent"));
	return { parent, onError };
}

function buildRoutes() {
	return new Hono()
		.basePath("/api")
		.get("/v1/hello", (c) => c.json({ hello: "world" }))
		.get("/v1/missing", (c) => c.json({ error: "not here" }, 404))
		.get("/v1/boom", () => {
			throw new Error("boom");
		});
}

describe("lazyRoutes", () => {
	it("builds the routes on first use and serves them", async () => {
		// Arrange
		const load = vi.fn(async () => buildRoutes());
		const { parent } = buildParent(load);
		expect(load).not.toHaveBeenCalled();

		// Act
		const response = await parent.request("/api/v1/hello");

		// Assert
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ hello: "world" });
		expect(load).toHaveBeenCalledOnce();
	});

	it("builds the routes only once across requests", async () => {
		// Arrange
		const load = vi.fn(async () => buildRoutes());
		const { parent } = buildParent(load);

		// Act
		await Promise.all([
			parent.request("/api/v1/hello"),
			parent.request("/api/v1/hello"),
		]);
		await parent.request("/api/v1/hello");

		// Assert
		expect(load).toHaveBeenCalledOnce();
	});

	it("falls through to later handlers when the routes do not match", async () => {
		// Arrange
		const { parent } = buildParent(async () => buildRoutes());

		// Act
		const response = await parent.request("/api/v1/fallback");

		// Assert
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("parent");
	});

	it("keeps an explicit 404 from a handler instead of falling through", async () => {
		// Arrange
		const { parent } = buildParent(async () => buildRoutes());

		// Act
		const response = await parent.request("/api/v1/missing");

		// Assert
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not here" });
	});

	it("reports handler errors through the parent's error handler", async () => {
		// Arrange
		const { parent, onError } = buildParent(async () => buildRoutes());

		// Act
		const response = await parent.request("/api/v1/boom");

		// Assert
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "handled" });
		expect(onError).toHaveBeenCalledOnce();
	});

	it("retries loading after a failed load", async () => {
		// Arrange
		const load = vi
			.fn<() => Promise<Hono>>()
			.mockRejectedValueOnce(new Error("load failed"))
			.mockResolvedValue(buildRoutes());
		const { parent } = buildParent(load);

		// Act
		const failed = await parent.request("/api/v1/hello");
		const recovered = await parent.request("/api/v1/hello");

		// Assert
		expect(failed.status).toBe(500);
		expect(recovered.status).toBe(200);
		expect(load).toHaveBeenCalledTimes(2);
	});
});

describe("lazyRoutes header parity with an eager mount", () => {
	function subApp() {
		return new Hono()
			.use(
				"*",
				cors({
					origin: "*",
					exposeHeaders: ["X-Correlation-ID", "X-Execution-Id"],
				}),
			)
			.get("/things/list", (c) => {
				c.header("X-RateLimit-Limit", "100");
				return c.json({ ok: true });
			});
	}

	function parentWith(mode: "eager" | "lazy") {
		const base = new Hono()
			.basePath("/api")
			.use(async (c, next) => {
				c.header("X-Correlation-ID", "cid-1");
				await next();
			})
			.use(
				cors({
					origin: "https://app.example",
					credentials: true,
					exposeHeaders: ["X-Correlation-ID"],
				}),
			);
		return mode === "eager"
			? base.route("/v1", subApp())
			: base.use(
					"/v1/*",
					lazyRoutes(
						async () =>
							new Hono().basePath("/api").route("/v1", subApp()),
						(_err, c) => c.text("error", 500),
					),
				);
	}

	async function headersOf(mode: "eager" | "lazy", init: RequestInit) {
		const response = await parentWith(mode).request(
			"/api/v1/things/list",
			init,
		);
		return Object.fromEntries(
			[...response.headers].filter(([name]) =>
				/access-control|x-correlation|x-ratelimit|vary/i.test(name),
			),
		);
	}

	it("lets the sub-app's CORS expose list win, as an eager mount does", async () => {
		// Arrange
		const init = { headers: { origin: "https://third-party.example" } };

		// Act
		const eager = await headersOf("eager", init);
		const lazy = await headersOf("lazy", init);

		// Assert
		expect(lazy["access-control-expose-headers"]).toContain(
			"X-Execution-Id",
		);
		expect(lazy).toEqual(eager);
	});

	it("produces the same headers for a preflight and a same-origin request", async () => {
		// Arrange
		const preflight = {
			method: "OPTIONS",
			headers: {
				origin: "https://third-party.example",
				"access-control-request-method": "GET",
			},
		};

		// Act
		const eagerPreflight = await headersOf("eager", preflight);
		const lazyPreflight = await headersOf("lazy", preflight);
		const eagerPlain = await headersOf("eager", {});
		const lazyPlain = await headersOf("lazy", {});

		// Assert
		expect(lazyPreflight).toEqual(eagerPreflight);
		expect(lazyPlain).toEqual(eagerPlain);
	});
});
