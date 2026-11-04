/**
 * Query shape for report templates and project reports in
 * `prisma/queries/reports.ts`, with the Prisma client mocked (no Postgres).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	templateFindMany: vi.fn(),
	templateCount: vi.fn(),
	templateUpdate: vi.fn(),
	instanceFindMany: vi.fn(),
	instanceCount: vi.fn(),
	instanceGroupBy: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		reportTemplate: {
			findMany: mocks.templateFindMany,
			count: mocks.templateCount,
			update: mocks.templateUpdate,
		},
		templateInstance: {
			findMany: mocks.instanceFindMany,
			count: mocks.instanceCount,
			groupBy: mocks.instanceGroupBy,
		},
	},
}));

import {
	listReportTemplates,
	listTemplateInstances,
	setReportTemplateArchivedAt,
} from "../prisma/queries/reports";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.templateFindMany.mockResolvedValue([]);
	mocks.templateCount.mockResolvedValue(0);
	mocks.instanceFindMany.mockResolvedValue([]);
	mocks.instanceCount.mockResolvedValue(0);
	mocks.instanceGroupBy.mockResolvedValue([]);
});

describe("listReportTemplates — archived templates", () => {
	it("leaves archived templates out by default", async () => {
		await listReportTemplates({
			userId: "example-user",
			organizationId: "example-org",
		});
		const { where } = mocks.templateFindMany.mock.calls[0][0];
		expect(where.archivedAt).toBeNull();
	});

	it("includes archived templates when asked", async () => {
		await listReportTemplates({
			userId: "example-user",
			organizationId: "example-org",
			includeArchived: true,
		});
		const { where } = mocks.templateFindMany.mock.calls[0][0];
		expect(where).not.toHaveProperty("archivedAt");
	});
});

describe("setReportTemplateArchivedAt", () => {
	it("writes the archive timestamp, or null to unarchive", async () => {
		const at = new Date("2026-11-04T12:00:00.000Z");
		await setReportTemplateArchivedAt("example-template", at);
		await setReportTemplateArchivedAt("example-template", null);
		expect(mocks.templateUpdate).toHaveBeenNthCalledWith(1, {
			where: { id: "example-template" },
			data: { archivedAt: at },
		});
		expect(mocks.templateUpdate).toHaveBeenNthCalledWith(2, {
			where: { id: "example-template" },
			data: { archivedAt: null },
		});
	});
});

describe("listTemplateInstances — project reports", () => {
	it("lists every report of the project inside its organization", async () => {
		await listTemplateInstances({
			userId: "example-user",
			organizationId: "example-org",
			projectId: "example-project",
			latestVersionOnly: false,
		});
		const { where } = mocks.instanceFindMany.mock.calls[0][0];
		expect(where).toMatchObject({
			projectId: "example-project",
			organizationId: "example-org",
		});
		expect(where).not.toHaveProperty("userId");
	});

	it("still lists only the caller's reports without a project", async () => {
		await listTemplateInstances({
			userId: "example-user",
			organizationId: "example-org",
			latestVersionOnly: false,
		});
		const { where } = mocks.instanceFindMany.mock.calls[0][0];
		expect(where).toMatchObject({
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(where).not.toHaveProperty("projectId");
	});
});
