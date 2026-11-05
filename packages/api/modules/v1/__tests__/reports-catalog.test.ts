/**
 * `GET /reports/templates` and the report suite's catalog.
 *
 * Where the suite is on, templates that need a connector and have never
 * completed a report are left out of the list. Organizations without the
 * suite keep the full list they had before it.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalApiVariables } from "../../external-api/types";

const mocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	listReportTemplates: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getReportTemplate: vi.fn(),
	isFeatureEnabled: mocks.isFeatureEnabled,
	listReportExecutions: vi.fn(),
	listReportTemplates: mocks.listReportTemplates,
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) =>
		next(),
}));

vi.mock("../helpers", () => ({
	notFound: (resource = "Resource") => ({
		error: { message: `${resource} not found` },
	}),
	ok: <T>(data: T, meta?: Record<string, unknown>) => ({
		data,
		...(meta ? { meta } : {}),
	}),
	resolveV1Context: async () => ({
		userId: "example-user",
		organizationId: "example-org",
	}),
}));

const { registerReportRoutes } = await import("../reports");

async function listTemplates() {
	const app = new Hono<{ Variables: ExternalApiVariables }>();
	registerReportRoutes(app);
	const response = await app.fetch(
		new Request("http://localhost/reports/templates"),
	);
	expect(response.status).toBe(200);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.listReportTemplates.mockResolvedValue({ templates: [], total: 0 });
});

describe("GET /reports/templates", () => {
	it("applies the catalog where the report suite is on", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(true);

		await listTemplates();

		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"REPORT_SUITE_V2",
			"example-org",
		);
		expect(mocks.listReportTemplates).toHaveBeenCalledWith(
			expect.objectContaining({
				includeUnproven: false,
				excludeSuiteOnly: false,
			}),
		);
	});

	it("keeps the list it had where the report suite is off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await listTemplates();

		expect(mocks.listReportTemplates).toHaveBeenCalledWith(
			expect.objectContaining({
				includeUnproven: true,
				excludeSuiteOnly: true,
			}),
		);
	});
});
