import { ORPCError } from "@orpc/server";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ command: vi.fn(), tenant: vi.fn() }));
vi.mock("../../lib/report-commands", () => ({ runReportCommand: m.command }));
vi.mock("../../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../../../v1/helpers", () => ({
	resolveV1Context: m.tenant,
	ok: (data: unknown) => ({ data }),
}));

import type { ExternalApiVariables } from "../../../external-api/types";
import { registerReportLifecycleRoutes } from "../routes";

const app = new Hono<{ Variables: ExternalApiVariables }>();
app.use("*", async (c, next) => {
	c.set("externalApiContext", {
		userId: "example-user",
		organizationId: "example-org",
		scopes: ["reports:read", "reports:write"],
		boundProjectId: "example-project",
	} as ExternalApiVariables["externalApiContext"]);
	await next();
});
registerReportLifecycleRoutes(app);
beforeEach(() => {
	vi.clearAllMocks();
	m.tenant.mockResolvedValue({
		userId: "example-user",
		organizationId: "example-org",
	});
	m.command.mockResolvedValue({ executionId: "example-run" });
});
describe("report REST command adapters", () => {
	it("executes through the same canonical command with key scopes and bound project", async () => {
		const input = {
			idempotencyKey: "00000000-0000-4000-8000-000000000001",
		};
		const response = await app.request(
			"/reports/instances/example-report/executions",
			{ method: "POST", body: JSON.stringify(input) },
		);
		expect(response.status).toBe(200);
		expect(m.command).toHaveBeenCalledWith(
			{
				userId: "example-user",
				organizationId: "example-org",
				scopes: ["reports:read", "reports:write"],
				boundProjectId: "example-project",
			},
			"execute",
			{ ...input, instanceId: "example-report" },
		);
	});
	it("forwards exact artifact digest and explicit recipients", async () => {
		const input = {
			requestId: "00000000-0000-4000-8000-000000000001",
			expectedArtifactHash: "a".repeat(64),
			recipientUserIds: ["example-member"],
		};
		const response = await app.request(
			"/reports/artifacts/example-artifact/distribute",
			{ method: "POST", body: JSON.stringify(input) },
		);
		expect(response.status).toBe(200);
		expect(m.command.mock.calls[0].slice(1)).toEqual([
			"distribute",
			{ ...input, artifactId: "example-artifact" },
		]);
	});
	it.each([
		["FORBIDDEN", 403],
		["NOT_FOUND", 404],
		["CONFLICT", 409],
	] as const)("maps %s honestly", async (code, status) => {
		m.command.mockRejectedValue(
			new ORPCError(code, { message: "Refused" }),
		);
		const response = await app.request("/reports/executions/example-run");
		expect(response.status).toBe(status);
	});
	it("bounds and validates JSON before a mutation", async () => {
		const invalid = await app.request("/reports/instances", {
			method: "POST",
			body: "{",
		});
		expect(invalid.status).toBe(400);
		const large = await app.request("/reports/instances", {
			method: "POST",
			body: " ".repeat(128 * 1024 + 1),
		});
		expect(large.status).toBe(413);
		expect(m.command).not.toHaveBeenCalled();
	});
});

it("pages native report history and exact execution outputs through canonical read commands", async () => {
	let response = await app.request(
		"/reports/instances/example-report/executions?cursor=example-next&limit=10&status=FAILED",
	);
	expect(response.status).toBe(200);
	expect(m.command.mock.calls[0]?.slice(1)).toEqual([
		"executions",
		{
			instanceId: "example-report",
			cursor: "example-next",
			limit: 10,
			status: "FAILED",
		},
	]);
	response = await app.request(
		"/reports/executions/example-run/artifacts?cursor=example-artifacts&limit=20&artifactType=PDF",
	);
	expect(response.status).toBe(200);
	expect(m.command.mock.calls[1]?.slice(1)).toEqual([
		"artifacts",
		{
			executionId: "example-run",
			cursor: "example-artifacts",
			limit: 20,
			artifactType: "PDF",
		},
	]);
});

it("does not silently ignore legacy offsets on native cursor routes", async () => {
	const response = await app.request(
		"/reports/instances/example-report/executions?offset=20",
	);
	expect(response.status).toBe(400);
	expect(m.command).not.toHaveBeenCalled();
});
