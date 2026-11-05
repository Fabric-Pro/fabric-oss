/**
 * Query shape for report templates and project reports in
 * `prisma/queries/reports.ts`, with the Prisma client mocked (no Postgres).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	queryRaw: vi.fn(),
	templateFindMany: vi.fn(),
	templateCount: vi.fn(),
	templateCreate: vi.fn(),
	templateUpdate: vi.fn(),
	sampleFindUnique: vi.fn(),
	sampleUpsert: vi.fn(),
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
		$queryRaw: mocks.queryRaw,
		reportTemplate: {
			findMany: mocks.templateFindMany,
			count: mocks.templateCount,
			create: mocks.templateCreate,
			update: mocks.templateUpdate,
		},
		reportTemplateSample: {
			findUnique: mocks.sampleFindUnique,
			upsert: mocks.sampleUpsert,
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
		user: { findUnique: async () => ({ role: "user" }) },
		project: { findFirst: mocks.projectFindFirst },
	},
}));

import { REPORT_SUITE_ONLY_TEMPLATE_NAMES } from "../prisma/queries/lib/report-template-catalog";
import {
	getReportTemplateSample,
	saveReportTemplateSample,
} from "../prisma/queries/report-template-samples";
import {
	createReportTemplate,
	getLatestProjectTemplateRun,
	listReportTemplates,
	listTemplateInstances,
	publishReportTemplate,
	setReportTemplateArchivedAt,
	updateReportTemplate,
} from "../prisma/queries/reports";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.queryRaw.mockResolvedValue([]);
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

describe("listReportTemplates — catalog", () => {
	const listedInCatalog = {
		OR: [{ isGeneric: true }, { id: { in: ["example-proven"] } }],
	};

	beforeEach(() => {
		mocks.queryRaw.mockResolvedValue([{ templateId: "example-proven" }]);
	});

	it("counts only a completed run that gathered records as proof", async () => {
		await listReportTemplates({
			userId: "example-user",
			organizationId: "example-org",
		});
		const [strings] = mocks.queryRaw.mock.calls[0];
		const sql = (strings as readonly string[]).join("?");
		expect(sql).toContain(`e."status" = 'COMPLETED'`);
		expect(sql).toContain(
			`jsonb_path_exists(e."dataSources", '$[*] ? (@.recordCount > 0)')`,
		);
		expect(mocks.queryRaw.mock.calls[0]).toHaveLength(1);
	});

	it("lists SYSTEM and public templates only when generic or proven", async () => {
		await listReportTemplates({
			userId: "example-user",
			organizationId: "example-org",
		});
		const { where } = mocks.templateFindMany.mock.calls[0][0];
		expect(where.OR).toEqual([
			{ scope: "SYSTEM", ...listedInCatalog },
			{ scope: "ORGANIZATION", organizationId: "example-org" },
			{
				scope: "USER",
				userId: "example-user",
				organizationId: "example-org",
			},
			{ isPublic: true, ...listedInCatalog },
		]);
	});

	it("keeps a personal context to the caller's personal templates", async () => {
		await listReportTemplates({ userId: "example-user" });
		const { where } = mocks.templateFindMany.mock.calls[0][0];
		expect(where.OR).toContainEqual({
			scope: "USER",
			userId: "example-user",
			organizationId: null,
		});
		expect(where.OR).not.toContainEqual(
			expect.objectContaining({ scope: "ORGANIZATION" }),
		);
	});

	it("lists every SYSTEM template for a platform admin who asks", async () => {
		await listReportTemplates({
			userId: "example-user",
			organizationId: "example-org",
			includeUnproven: true,
		});
		const { where } = mocks.templateFindMany.mock.calls[0][0];
		expect(where.OR[0]).toEqual({ scope: "SYSTEM" });
		expect(where.OR[3]).toEqual({ isPublic: true });
	});

	it("leaves the suite-only standard templates out for an organization without the suite", async () => {
		await listReportTemplates({
			userId: "example-user",
			organizationId: "example-org",
			includeUnproven: true,
			excludeSuiteOnly: true,
		});
		const { where } = mocks.templateFindMany.mock.calls[0][0];
		expect(where.AND).toEqual([
			{
				NOT: {
					scope: "SYSTEM",
					name: { in: [...REPORT_SUITE_ONLY_TEMPLATE_NAMES] },
				},
			},
		]);
		expect(where.OR[0]).toEqual({ scope: "SYSTEM" });
		const excluded = where.AND[0].NOT.name.in;
		expect(excluded).toContain("Monthly Business Review");
		expect(excluded).not.toContain("Quarterly Business Review");
	});

	it("keeps the catalog rule alongside the suite-only exclusion on a SYSTEM-only listing", async () => {
		await listReportTemplates({
			userId: "example-user",
			organizationId: "example-org",
			scope: "SYSTEM",
			excludeSuiteOnly: true,
		});
		const { where } = mocks.templateFindMany.mock.calls[0][0];
		expect(where.AND).toHaveLength(2);
		expect(where.AND[0]).toEqual(listedInCatalog);
	});

	it("does not narrow the catalog unless asked", async () => {
		await listReportTemplates({
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(
			mocks.templateFindMany.mock.calls[0][0].where.AND,
		).toBeUndefined();
	});

	it("applies the rule to a SYSTEM-only listing", async () => {
		await listReportTemplates({
			userId: "example-user",
			organizationId: "example-org",
			scope: "SYSTEM",
		});
		const { where } = mocks.templateFindMany.mock.calls[0][0];
		expect(where.scope).toBe("SYSTEM");
		expect(where.AND).toEqual([listedInCatalog]);
	});

	it("lists the caller's own templates made in this organization", async () => {
		await listReportTemplates({
			userId: "example-user",
			organizationId: "example-org",
			scope: "USER",
		});
		const { where } = mocks.templateFindMany.mock.calls[0][0];
		expect(where).toMatchObject({
			scope: "USER",
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(where).not.toHaveProperty("AND");
	});

	it("marks a template proven once a report made from it gathered records", async () => {
		mocks.templateFindMany.mockResolvedValue([
			{
				id: "example-proven",
				_count: { executions: 0, artifacts: 0 },
			},
			{
				id: "example-unproven",
				_count: { executions: 1, artifacts: 0 },
			},
		]);
		mocks.templateCount.mockResolvedValue(2);

		const { templates } = await listReportTemplates({
			userId: "example-user",
			organizationId: "example-org",
		});

		expect(templates).toEqual([
			{
				id: "example-proven",
				_count: { executions: 0, artifacts: 0 },
				proven: true,
			},
			{
				id: "example-unproven",
				_count: { executions: 1, artifacts: 0 },
				proven: false,
			},
		]);
		const { include } = mocks.templateFindMany.mock.calls[0][0];
		expect(include._count.select).toEqual({
			executions: true,
			artifacts: true,
		});
	});

	it("lists no connector template as proven when no run gathered records", async () => {
		mocks.queryRaw.mockResolvedValue([]);
		await listReportTemplates({ userId: "example-user" });
		const { where } = mocks.templateFindMany.mock.calls[0][0];
		expect(where.OR[0]).toEqual({
			scope: "SYSTEM",
			OR: [{ isGeneric: true }, { id: { in: [] } }],
		});
	});
});

describe("report template isGeneric", () => {
	beforeEach(() => {
		mocks.templateCreate.mockResolvedValue({ id: "example-template" });
		mocks.templateUpdate.mockResolvedValue({ id: "example-template" });
	});

	it("lists a template a person created, whatever sources it reads", async () => {
		await createReportTemplate({
			name: "Example notes",
			templateType: "CUSTOM",
			definition: { dataSources: [] },
			scope: "SYSTEM",
		});
		await createReportTemplate({
			name: "Example board",
			templateType: "CUSTOM",
			definition: { dataSources: [{ type: "mcp", provider: "fizzy" }] },
			scope: "SYSTEM",
		});
		const { data } = mocks.templateCreate.mock.calls[0][0];
		expect(data).toMatchObject({ scope: "SYSTEM", isGeneric: true });
		expect(data.organizationId).toBeUndefined();
		expect(data.userId).toBeUndefined();
		expect(mocks.templateCreate.mock.calls[1][0].data.isGeneric).toBe(true);
	});

	it("lists a template once a person edits its definition, whatever sources it reads", async () => {
		await updateReportTemplate({
			id: "example-template",
			definition: { dataSources: [{ type: "integration" }] },
		});
		await updateReportTemplate({
			id: "example-template",
			definition: { dataSources: [{ type: "fabric" }] },
		});
		expect(mocks.templateUpdate.mock.calls[0][0].data).toMatchObject({
			isGeneric: true,
			version: { increment: 1 },
		});
		expect(mocks.templateUpdate.mock.calls[1][0].data).toMatchObject({
			isGeneric: true,
		});
	});

	it("keeps isGeneric when the definition is not changed", async () => {
		await updateReportTemplate({ id: "example-template", name: "Renamed" });
		expect(mocks.templateUpdate.mock.calls[0][0].data).not.toHaveProperty(
			"isGeneric",
		);
	});
});

describe("publishReportTemplate", () => {
	it("moves a template into its organization, keeping its author", async () => {
		await publishReportTemplate({
			id: "example-template",
			target: "ORGANIZATION",
			organizationId: "example-org",
		});
		expect(mocks.templateUpdate).toHaveBeenCalledWith({
			where: { id: "example-template" },
			data: { scope: "ORGANIZATION", organizationId: "example-org" },
		});
	});

	it("gives a system template no owning organization or user, and lists it: a person published it", async () => {
		await publishReportTemplate({
			id: "example-template",
			target: "SYSTEM",
		});
		expect(mocks.templateUpdate).toHaveBeenCalledWith({
			where: { id: "example-template" },
			data: {
				scope: "SYSTEM",
				organizationId: null,
				userId: null,
				isPublic: true,
				isGeneric: true,
			},
		});
	});
});

describe("report template samples", () => {
	const key = { templateId: "example-template", contentHash: "example-hash" };

	it("reads the sample written from exactly this prompt", async () => {
		await getReportTemplateSample(key);
		expect(mocks.sampleFindUnique).toHaveBeenCalledWith({
			where: { templateId_contentHash: key },
			select: { content: true, generatedAt: true },
		});
	});

	it("stores a sample, replacing one written from the same prompt", async () => {
		await saveReportTemplateSample({ ...key, content: "# Sample" });
		expect(mocks.sampleUpsert).toHaveBeenCalledWith({
			where: { templateId_contentHash: key },
			create: { ...key, content: "# Sample" },
			update: { content: "# Sample", generatedAt: expect.any(Date) },
			select: { content: true, generatedAt: true },
		});
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
	function previewRun(
		id: string,
		fabricConfig: unknown = null,
		dataSources: unknown = [{ sourceId: "board", recordCount: 3 }],
	) {
		return {
			id,
			completedAt: new Date("2026-01-02T03:04:05.000Z"),
			parameters: {},
			dataSources,
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
		expect(run).not.toHaveProperty("dataSources");
	});

	it("skips a run that completed without gathering records", async () => {
		mocks.executionFindMany.mockResolvedValue([
			previewRun("example-empty-run", null, [
				{ sourceId: "board", recordCount: 0 },
			]),
			previewRun("example-unrecorded-run", null, null),
			previewRun("example-run"),
		]);
		const run = await getLatestProjectTemplateRun(previewQuery);
		expect(run?.id).toBe("example-run");
		const { select } = mocks.executionFindMany.mock.calls[0][0];
		expect(select.dataSources).toBe(true);
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
