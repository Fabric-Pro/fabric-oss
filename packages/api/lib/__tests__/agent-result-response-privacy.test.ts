import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import {
	AGENT_RESULT_RPC_PATH,
	agentResultResponsePrivacy,
} from "../agent-result-response-privacy";

const target = "/rpc/contextQuality/agentResults/inspect";
function app() {
	const app = new Hono();
	// The privacy layer must precede authentication, schema and permissions.
	app.use(AGENT_RESULT_RPC_PATH, agentResultResponsePrivacy);
	app.use("*", async (c, next) => {
		const status = c.req.header("x-example-refusal");
		if (status === "401") {
			return c.json({ error: "Authentication required." }, 401);
		}
		if (status === "403") {
			return c.json({ error: "Current role required." }, 403);
		}
		if (status === "404") {
			throw new HTTPException(404, { message: "Object not found." });
		}
		if (status === "500") {
			throw new Error("Example unexpected error.");
		}
		await next();
	});
	app.onError((error, c) =>
		error instanceof HTTPException
			? c.json({ error: error.message }, error.status)
			: c.json({ error: "Unexpected error." }, 500),
	);
	app.post(target, async (c) => {
		const value: unknown = await c.req.json().catch(() => null);
		if (!value || typeof value !== "object") {
			return c.json({ error: "Use valid bounded input." }, 400);
		}
		return c.json({ recordedAnswer: "Example private result." });
	});
	app.post("/rpc/contextQuality/inspect", (c) => c.json({ ok: true }));
	app.post("/rpc/contextQuality/agentResultsOther/inspect", (c) =>
		c.json({ ok: true }),
	);
	return app;
}

describe("agent-result RPC response privacy entrypoint", () => {
	it("uses the exact RPC family prefix", () =>
		expect(AGENT_RESULT_RPC_PATH).toBe(
			"/rpc/contextQuality/agentResults/*",
		));
	it("keeps successful private output out of HTTP caches", async () => {
		const response = await app().request(target, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			recordedAnswer: "Example private result.",
		});
		expect(response.headers.get("cache-control")).toBe("private, no-store");
	});
	it("covers schema failures before a procedure handler", async () => {
		const response = await app().request(target, {
			method: "POST",
			body: "invalid JSON",
		});
		expect(response.status).toBe(400);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
	});
	it.each([401, 403, 404, 500])(
		"covers early %s refusal/error responses",
		async (status) => {
			const response = await app().request(target, {
				method: "POST",
				headers: { "x-example-refusal": String(status) },
				body: "{}",
			});
			expect(response.status).toBe(status);
			expect(response.headers.get("cache-control")).toBe(
				"private, no-store",
			);
			expect(await response.text()).not.toContain(
				"Example private result",
			);
		},
	);
	it("covers unknown methods within the private run-result RPC family", async () => {
		const response = await app().request(
			"/rpc/contextQuality/agentResults/example-unknown",
			{ method: "POST" },
		);
		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
	});
	it.each([
		"/rpc/contextQuality/inspect",
		"/rpc/contextQuality/agentResultsOther/inspect",
	])("leaves non-target %s routes unchanged", async (path) => {
		const response = await app().request(path, { method: "POST" });
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBeNull();
	});
});
