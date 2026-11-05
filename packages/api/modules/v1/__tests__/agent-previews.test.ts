import { ORPCError } from "@orpc/server";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalApiVariables } from "../../external-api/types";

const m = vi.hoisted(() => ({
	start: vi.fn(),
	get: vi.fn(),
	cancel: vi.fn(),
	context: vi.fn(),
	audit: vi.fn(),
}));
vi.mock("../../agents/lib/agent-preview-commands", () => ({
	startAgentPreviewCommand: m.start,
	getAgentPreviewCommand: m.get,
	cancelAgentPreviewCommand: m.cancel,
}));
vi.mock("../../../lib/audit", () => ({ recordAuditFromRequest: m.audit }));
vi.mock("../helpers", () => ({
	ok: (data: unknown) => ({ data }),
	resolveV1Context: m.context,
}));
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		(scope: string) =>
		async (
			c: {
				get: (key: string) => { scopes: string[] };
				json: (data: unknown, status: number) => Response;
			},
			next: () => Promise<void>,
		) => {
			const scopes = c.get("externalApiContext").scopes;
			if (!scopes.includes(scope) && !scopes.includes("*")) {
				return c.json({ error: { code: "INSUFFICIENT_SCOPE" } }, 403);
			}
			await next();
		},
}));

import { registerAgentPreviewRoutes } from "../agent-previews";

let scopes: string[] = [];
const app = new Hono<{ Variables: ExternalApiVariables }>();
app.use("*", async (c, next) => {
	c.set("externalApiContext", {
		keyType: "organization",
		keyId: "example-key",
		keyPrefix: "org_example",
		userId: "example-user",
		organizationId: "example-org",
		scopes,
	});
	await next();
});
registerAgentPreviewRoutes(app);
const request = (path: string, method = "GET", body?: unknown) =>
	app.request(`http://example.com${path}`, {
		method,
		...(body === undefined
			? {}
			: {
					body: JSON.stringify(body),
					headers: { "Content-Type": "application/json" },
				}),
	});
beforeEach(() => {
	vi.resetAllMocks();
	scopes = ["agents:read", "agents:execute"];
	m.context.mockResolvedValue({
		userId: "example-user",
		organizationId: "example-org",
	});
	for (const fn of [m.start, m.get, m.cancel]) {
		fn.mockResolvedValue({ status: "RUNNING" });
	}
});
describe("draft preview REST transport", () => {
	it.each(["start", "get", "cancel"])(
		"enforces retained workspace selection scope for %s",
		async (operation) => {
			const selected = {
				workspaceIds: ["example-workspace"],
				skillIds: [],
			};
			const check = async (...args: unknown[]) => {
				const policy = args[operation === "get" ? 2 : 3] as (
					draft: typeof selected,
				) => unknown;
				await policy(selected);
				return { status: "RUNNING" };
			};
			m[operation as "get"].mockImplementation(check);
			const path =
				operation === "start"
					? "/agent-previews"
					: `/agent-previews/example-preview${operation === "cancel" ? "/cancel" : ""}`;
			const response = await request(
				path,
				operation === "get" ? "GET" : "POST",
				operation === "get" ? undefined : {},
			);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				error: {
					code: "INSUFFICIENT_SCOPE",
					message: expect.stringContaining("workspaces:read"),
				},
			});
			scopes = ["*"];
			expect(
				(
					await request(
						path,
						operation === "get" ? "GET" : "POST",
						operation === "get" ? undefined : {},
					)
				).status,
			).toBe(200);
		},
	);
	it.each([
		["/agent-previews", "POST", {}],
		["/agent-previews/example-preview", "GET", undefined],
		["/agent-previews/example-preview/cancel", "POST", {}],
	])("requires explicit scope for %s", async (path, method, body) => {
		scopes = [];
		expect(
			(await request(path as string, method as string, body)).status,
		).toBe(403);
		expect(m.start).not.toHaveBeenCalled();
		expect(m.get).not.toHaveBeenCalled();
		expect(m.cancel).not.toHaveBeenCalled();
	});
	it("does not let a wildcard key bypass current command authority", async () => {
		scopes = ["*"];
		m.get.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "Current access revoked" }),
		);
		const response = await request("/agent-previews/example-preview");
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { code: "FORBIDDEN", message: "Current access revoked" },
		});
	});
	it("resolves actor server-side and pins get/cancel run identity", async () => {
		await request("/agent-previews/example-preview?runId=example-run");
		expect(m.get).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			{ workflowId: "example-preview", runId: "example-run" },
			expect.any(Function),
		);
		await request(
			"/agent-previews/example-preview/cancel?runId=example-run",
			"POST",
			{},
		);
		expect(m.cancel).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			{ workflowId: "example-preview", runId: "example-run" },
			expect.any(Function),
			expect.any(Function),
		);
	});
	it("does not accept actor or run overrides through cancellation body", async () => {
		const response = await request(
			"/agent-previews/example-preview/cancel",
			"POST",
			{ runId: "other", userId: "other" },
		);
		expect(response.status).toBe(400);
		expect(m.cancel).not.toHaveBeenCalled();
	});
	it("refuses unresolved organization context", async () => {
		m.context.mockResolvedValue({
			error: "Organization unavailable",
			status: 403,
		});
		expect((await request("/agent-previews/example-preview")).status).toBe(
			403,
		);
		expect(m.get).not.toHaveBeenCalled();
	});
	it("enforces the raw HTTP payload cap", async () => {
		expect(
			(
				await request("/agent-previews", "POST", {
					data: "x".repeat(132000),
				})
			).status,
		).toBe(413);
		expect(m.start).not.toHaveBeenCalled();
	});
});
