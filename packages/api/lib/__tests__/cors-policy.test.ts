import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://fabric.example" }));
vi.mock("@repo/database", () => ({
	createUserApiKey: vi.fn(),
	db: {},
	hasOrganizationTie: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../modules/users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: vi.fn().mockResolvedValue({ valid: false }),
}));

import { createVscodeAuthRoutes } from "../../modules/vscode-auth/routes";
import { applicationCorsMiddleware } from "../cors-policy";

function buildApp() {
	return new Hono()
		.basePath("/api")
		.use(applicationCorsMiddleware)
		.route("/", createVscodeAuthRoutes())
		.get("/rpc/ping", (c) => c.text("pong"))
		.get("/v1/external/agents", (c) => c.text("agents"));
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("application CORS policy", () => {
	it("never answers an application route with a wildcard origin", async () => {
		const app = buildApp();

		const response = await app.request("/api/rpc/ping", {
			headers: { Origin: "https://other.example" },
		});

		expect(response.headers.get("access-control-allow-origin")).toBe(
			"https://fabric.example",
		);
		expect(response.headers.get("access-control-allow-credentials")).toBe(
			"true",
		);
	});

	it("keeps the extension's wildcard policy on its own routes, without credentials", async () => {
		const app = buildApp();

		const response = await app.request("/api/profile", {
			headers: { Origin: "https://other.example" },
		});

		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(
			response.headers.get("access-control-allow-credentials"),
		).toBeNull();
	});

	it("leaves /api/v1 preflights to the public API's own policy", async () => {
		const app = buildApp();

		const response = await app.request("/api/v1/external/agents", {
			method: "OPTIONS",
			headers: {
				Origin: "https://other.example",
				"Access-Control-Request-Method": "POST",
			},
		});

		expect(
			response.headers.get("access-control-allow-credentials"),
		).toBeNull();
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("does not allowlist local development origins in production", async () => {
		vi.stubEnv("NODE_ENV", "production");
		const app = buildApp();

		const response = await app.request("/api/rpc/ping", {
			headers: { Origin: "http://localhost:3001" },
		});

		expect(response.headers.get("access-control-allow-origin")).toBe(
			"https://fabric.example",
		);
	});

	it("keeps the local Kanban runtime allowlisted in production", async () => {
		vi.stubEnv("NODE_ENV", "production");
		const app = buildApp();

		const response = await app.request("/api/rpc/ping", {
			headers: { Origin: "http://localhost:3484" },
		});

		expect(response.headers.get("access-control-allow-origin")).toBe(
			"http://localhost:3484",
		);
	});

	it("allowlists local development origins outside production", async () => {
		vi.stubEnv("NODE_ENV", "development");
		const app = buildApp();

		const response = await app.request("/api/rpc/ping", {
			headers: { Origin: "http://localhost:3001" },
		});

		expect(response.headers.get("access-control-allow-origin")).toBe(
			"http://localhost:3001",
		);
	});

	it("allowlists origins named in CORS_ALLOWED_ORIGINS", async () => {
		vi.stubEnv("CORS_ALLOWED_ORIGINS", "https://partner.example");
		const app = buildApp();

		const response = await app.request("/api/rpc/ping", {
			headers: { Origin: "https://partner.example" },
		});

		expect(response.headers.get("access-control-allow-origin")).toBe(
			"https://partner.example",
		);
	});
});
