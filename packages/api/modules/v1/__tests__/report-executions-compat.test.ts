import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	canRead: vi.fn(),
	command: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	listReportExecutions: m.list,
	canReadOrganizationReports: m.canRead,
	ArtifactBrandingError: class extends Error {},
	ReportBrandingCommandError: class extends Error {},
}));
vi.mock("../../reports/lib/report-commands", () => ({
	runReportCommand: m.command,
}));
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../helpers", () => ({
	resolveV1Context: async () => ({
		userId: "example-user",
		organizationId: "example-org",
	}),
	ok: (data: unknown, meta?: unknown) => ({
		data,
		...(meta ? { meta } : {}),
	}),
	notFound: () => ({ error: { message: "Not found" } }),
}));

import type { ExternalApiVariables } from "../../external-api/types";
import { registerReportRoutes } from "../reports";

const app = new Hono<{ Variables: ExternalApiVariables }>();
app.use("*", async (c, next) => {
	c.set("externalApiContext", {
		userId: "example-user",
		organizationId: "example-org",
		scopes: ["reports:read"],
	} as ExternalApiVariables["externalApiContext"]);
	await next();
});
registerReportRoutes(app);
const createdAt = new Date("2026-11-06T00:00:00.000Z");
beforeEach(() => {
	vi.clearAllMocks();
	m.canRead.mockResolvedValue(true);
	m.list.mockResolvedValue({
		executions: [
			{
				id: "example-legacy-run",
				templateId: "example-template",
				status: "COMPLETED",
				userId: "example-user",
				organizationId: "example-org",
				startedAt: createdAt,
				completedAt: createdAt,
				createdAt,
				error: null,
			},
		],
		total: 87,
	});
	m.command.mockResolvedValue({
		executions: [],
		hasMore: true,
		nextCursor: "example-next",
	});
});
describe("report execution API backward compatibility", () => {
	it("keeps no-argument legacy calls and original array/meta envelope", async () => {
		const response = await app.request("/reports/executions");
		expect(response.status).toBe(200);
		expect(response.headers.get("Deprecation")).toBe("true");
		expect(await response.json()).toEqual({
			data: [
				{
					id: "example-legacy-run",
					templateId: "example-template",
					status: "COMPLETED",
					userId: "example-user",
					organizationId: "example-org",
					startedAt: createdAt.toISOString(),
					completedAt: createdAt.toISOString(),
					createdAt: createdAt.toISOString(),
					error: null,
				},
			],
			meta: { total: 87 },
		});
		expect(m.list).toHaveBeenCalledWith({
			userId: "example-user",
			organizationId: "example-org",
			limit: 20,
			offset: 0,
		});
		expect(m.command).not.toHaveBeenCalled();
	});
	it("honors existing offset and caps limit without silently returning the first page", async () => {
		const response = await app.request(
			"/reports/executions?offset=40&limit=200&status=FAILED&templateId=example-template",
		);
		expect(response.status).toBe(200);
		expect(m.list).toHaveBeenCalledWith({
			userId: "example-user",
			organizationId: "example-org",
			limit: 100,
			offset: 40,
			status: "FAILED",
			templateId: "example-template",
		});
	});
	it("keeps native cursor history on its distinct authorized instance route", async () => {
		const response = await app.request(
			"/reports/instances/example-report/executions?cursor=example-next&limit=10",
		);
		expect(response.status).toBe(200);
		expect(m.command).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "example-user",
				organizationId: "example-org",
			}),
			"executions",
			{
				instanceId: "example-report",
				cursor: "example-next",
				limit: 10,
				status: undefined,
			},
		);
		expect(m.list).not.toHaveBeenCalled();
	});
	it.each([
		"cursor=example-native",
		"instanceId=example-report",
		"offset=-1",
		"offset=invalid",
	])(
		"refuses unsupported or invalid legacy filter %s rather than ignoring it",
		async (query) => {
			const response = await app.request(`/reports/executions?${query}`);
			expect(response.status).toBe(400);
			expect(m.list).not.toHaveBeenCalled();
		},
	);
	it("rechecks current report read permission before reading legacy rows", async () => {
		m.canRead.mockResolvedValue(false);
		expect((await app.request("/reports/executions")).status).toBe(403);
		expect(m.list).not.toHaveBeenCalled();
	});
});

it("continues ignoring unknown non-native query parameters for old clients", async () => {
	const response = await app.request(
		"/reports/executions?offset=40&clientVersion=old&_cache=123",
	);
	expect(response.status).toBe(200);
	expect(m.list).toHaveBeenCalledWith({
		userId: "example-user",
		organizationId: "example-org",
		limit: 20,
		offset: 40,
	});
});
