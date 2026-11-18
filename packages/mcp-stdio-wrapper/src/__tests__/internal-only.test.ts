import assert from "node:assert/strict";
import { afterEach, it, mock } from "node:test";
import { Hono } from "hono";
import { internalOnlyMiddleware } from "../middleware/internal-only";

const originalEnv = process.env;
afterEach(() => {
	process.env = originalEnv;
	mock.restoreAll();
});

function createApp(apiKey?: string) {
	const app = new Hono();
	app.use("*", internalOnlyMiddleware(apiKey));
	app.get("/", (c) => c.text("ok"));
	return app;
}

it("logs missing production configuration and refuses requests with an empty configured key", async () => {
	process.env = {
		...process.env,
		NODE_ENV: "production",
		ALLOW_EXTERNAL_ACCESS: "true",
	};
	const log = mock.method(console, "error", () => {});
	const response = await createApp("").request("/");
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), {
		error: "Service unavailable",
		message: "MCP STDIO wrapper is not configured",
	});
	assert.match(
		String(log.mock.calls[0]?.arguments[0]),
		/MCP_WRAPPER_API_KEY/,
	);
});

it("requires an exact, nonempty key in development even when external access is enabled", async () => {
	process.env = {
		...process.env,
		NODE_ENV: "development",
		ALLOW_EXTERNAL_ACCESS: "true",
	};
	const app = createApp("example-key");
	for (const key of [
		undefined,
		"",
		"example-kez",
		"example-key-extra",
		"Example-key",
	]) {
		const headers =
			key === undefined ? undefined : { "x-internal-api-key": key };
		assert.equal(
			(await app.request("/", { headers })).status,
			401,
			key ?? "missing key",
		);
	}
	assert.equal(
		(
			await app.request("/", {
				headers: { "x-internal-api-key": "example-key" },
			})
		).status,
		200,
	);
});
