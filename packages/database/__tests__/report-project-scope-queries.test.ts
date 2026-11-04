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
	executionFindMany: vi.fn(),
	memberFindUnique: vi.fn(),
	projectFindFirst: vi.fn(),
	hasProjectAccess: vi.fn(),
}));

vi.mock("../prisma/queries/projects/projects", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../prisma/queries/projects/projects")
	>()),
	hasProjectAccess: mocks.hasProjectAccess,
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
		templateInstanceExecution: {
			findMany: mocks.executionFindMany,
		},
		member: { findUnique: mocks.memberFindUnique },
		project: { findFirst: mocks.projectFindFirst },
	},
}));

import {
	getLatestProjectTemplateRun,
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

describe("listTemplateInstances — active count", () => {
	it("counts the switched-on reports across every page when asked", async () => {
		mocks.instanceCount
			.mockResolvedValueOnce(120)
			.mockResolvedValueOnce(87);
		const result = await listTemplateInstances({
			userId: "example-user",
			organizationId: "example-org",
			projectId: "example-project",
			latestVersionOnly: false,
			limit: 20,
			countActive: true,
		});
		expect(result.total).toBe(120);
		expect(result.activeTotal).toBe(87);
		expect(mocks.instanceCount).toHaveBeenLastCalledWith({
			where: {
				AND: [
					expect.objectContaining({ projectId: "example-project" }),
					{ isActive: true },
				],
			},
		});
	});

	it("skips the active count unless asked", async () => {
		const result = await listTemplateInstances({
			userId: "example-user",
			organizationId: "example-org",
			projectId: "example-project",
			latestVersionOnly: false,
		});
		expect(result.activeTotal).toBeNull();
		expect(mocks.instanceCount).toHaveBeenCalledTimes(1);
	});
});

describe("getLatestProjectTemplateRun", () => {
	const previewQuery = {
		templateId: "example-template",
		projectId: "example-project",
		userId: "example-member",
		organizationId: "example-org",
	};
	function previewRun(id: string, fabricConfig: unknown = null) {
		return {
			id,
			completedAt: new Date("2026-01-02T03:04:05.000Z"),
			parameters: {},
			instance: {
				id: `${id}-instance`,
				name: "Team status",
				userId: "example-owner",
				organizationId: "example-org",
				projectId: "example-project",
				fabricConfig,
			},
			artifacts: [
				{ id: `${id}-artifact`, name: "report.md", content: "# Done" },
			],
		};
	}

	beforeEach(() => {
		mocks.executionFindMany.mockResolvedValue([]);
		mocks.memberFindUnique.mockResolvedValue({ role: "member" });
		mocks.projectFindFirst.mockImplementation(
			async ({ where }: { where: { id: string } }) => ({ id: where.id }),
		);
		mocks.hasProjectAccess.mockImplementation(
			async (projectId: string) => projectId === "example-project",
		);
	});

	it("reads only completed runs of the template in the project and tenant", async () => {
		await getLatestProjectTemplateRun(previewQuery);
		const { where, orderBy, select, take } =
			mocks.executionFindMany.mock.calls[0][0];
		expect(where.status).toBe("COMPLETED");
		expect(where.instance).toEqual({
			templateId: "example-template",
			projectId: "example-project",
			organizationId: "example-org",
		});
		expect(where.artifacts.some.content).toEqual({ not: null });
		expect(orderBy[0]).toEqual({
			completedAt: { sort: "desc", nulls: "last" },
		});
		expect(select.artifacts.take).toBe(1);
		expect(take).toBeGreaterThan(1);
	});

	it("keeps a personal context to personal reports", async () => {
		await getLatestProjectTemplateRun({
			...previewQuery,
			organizationId: undefined,
		});
		const { where } = mocks.executionFindMany.mock.calls[0][0];
		expect(where.instance.organizationId).toBeNull();
	});

	it("returns the newest run the caller may open, without its parameters", async () => {
		mocks.executionFindMany.mockResolvedValue([previewRun("example-run")]);
		const run = await getLatestProjectTemplateRun(previewQuery);
		expect(run?.id).toBe("example-run");
		expect(run).not.toHaveProperty("parameters");
	});

	it("refuses a project guest who is not a member of the organization", async () => {
		mocks.memberFindUnique.mockResolvedValue(null);
		mocks.executionFindMany.mockResolvedValue([previewRun("example-run")]);
		await expect(
			getLatestProjectTemplateRun(previewQuery),
		).resolves.toBeNull();
	});

	it("skips a run bound to another project the caller may not read", async () => {
		mocks.executionFindMany.mockResolvedValue([
			previewRun("example-bound-run", {
				reporting: {
					version: 1,
					period: "weekly",
					projectId: "example-other-project",
				},
			}),
			previewRun("example-open-run"),
		]);
		const run = await getLatestProjectTemplateRun(previewQuery);
		expect(run?.id).toBe("example-open-run");
		expect(mocks.hasProjectAccess).toHaveBeenCalledWith(
			"example-other-project",
			"example-member",
			"example-org",
		);
	});
});
