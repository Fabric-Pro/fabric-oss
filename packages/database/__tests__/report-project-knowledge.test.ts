import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	execution: vi.fn(),
	access: vi.fn(),
	query: vi.fn(),
}));
vi.mock("../prisma/client", () => ({ db: { $queryRaw: m.query } }));
vi.mock("../prisma/queries/reports", () => ({
	getTemplateInstanceExecution: m.execution,
}));
vi.mock("../prisma/queries/lib/report-access", () => ({
	canExecuteReportInstance: m.access,
}));

import {
	assertProjectReportSourcesReady,
	buildReportExecutionSnapshot,
	getProjectReportSetupReason,
} from "../prisma/queries/lib/report-evidence";
import { getReportProjectKnowledge } from "../prisma/queries/reports-project-knowledge";

const definition = {
	dataSources: [
		{
			id: "knowledge",
			type: "fabric",
			provider: "fabric_project",
			operation: "project_knowledge",
			config: {
				documentIds: ["doc-a"],
				contextIds: ["context-a"],
				limit: 2,
			},
		},
	],
};
const instance = {
	id: "report-1",
	userId: "user-1",
	organizationId: "org-1",
	connections: {},
	fabricConfig: {
		reporting: { version: 1, period: "monthly", projectId: "project-a" },
	},
	template: { definition },
};
const snapshot = buildReportExecutionSnapshot({
	instance,
	organizationId: "org-1",
	userId: "user-1",
	occurrenceAt: new Date("2026-11-02T09:00:00Z"),
	origin: "manual",
});
const input = {
	executionId: "execution-1",
	sourceId: "knowledge",
	organizationId: "org-1",
	userId: "user-1",
	dateRange: { start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" },
};
beforeEach(() => {
	vi.clearAllMocks();
	m.access.mockResolvedValue(true);
	m.execution.mockResolvedValue({
		id: "execution-1",
		instanceId: "report-1",
		userId: "user-1",
		status: "RUNNING",
		instance,
		parameters: {
			__fabricReportExecution: snapshot,
			projectId: "project-b",
		},
	});
	m.query.mockResolvedValue([]);
});
describe("server-bound project report knowledge", () => {
	it("qualifies only the implemented Fabric source, never claimed MCP/workspace/project tags", () => {
		expect(
			getProjectReportSetupReason(instance.fabricConfig, definition, {}),
		).toBeUndefined();
		for (const source of [
			{
				type: "mcp",
				provider: "fabric_project",
				operation: "project_knowledge",
				config: { projectId: "project-a" },
			},
			{
				type: "workspace",
				provider: "fabric_project",
				operation: "project_knowledge",
			},
			{
				...definition.dataSources[0],
				config: { projectId: "project-b", audience: "project-a" },
			},
		]) {
			expect(
				getProjectReportSetupReason(
					instance.fabricConfig,
					{ dataSources: [source] },
					{},
				),
			).toContain("setup required");
		}
		expect(() =>
			assertProjectReportSourcesReady(
				instance.fabricConfig,
				undefined,
				definition,
				{ mcpConfigs: ["private-config"] },
			),
		).toThrow("setup required");
	});
	it("derives project A from the admitted snapshot and SQL-fences org, project, source IDs, revision, cutoff and bounds", async () => {
		m.query
			.mockResolvedValueOnce([
				{
					id: "doc-a",
					title: "Delivery",
					content: "A completed feature",
					revision: "3",
					updatedAt: new Date("2026-10-15T00:00:00Z"),
					truncated: false,
				},
			])
			.mockResolvedValueOnce([
				{
					id: "context-a",
					title: "Shared delivery note",
					content: "A shared note",
					revision: "2026-10-15",
					updatedAt: new Date("2026-10-15T00:00:00Z"),
					truncated: false,
				},
			]);
		const result = await getReportProjectKnowledge(input);
		expect(result.records[0]).toMatchObject({
			projectId: "project-a",
			revision: "3",
			content: "A completed feature",
			citation: "projects/project-a/documents/doc-a",
		});
		expect(result.records[1]?.citation).toBe(
			"projects/project-a?tab=context&source=context-a",
		);
		expect(result.records[0].excerptHash).toMatch(/^[a-f0-9]{64}$/);
		for (const [query] of m.query.mock.calls) {
			const text = query.strings.join("?");
			expect(text).toContain('"organizationId" =');
			expect(text).toContain('"projectId" =');
			expect(text).toContain('"deletedAt" IS NULL');
			expect(text).toContain('"updatedAt" <');
			expect(text).toContain("left(");
			expect(text).toContain("6000");
			expect(text).toContain("LIMIT");
			expect(query.values).toContain("org-1");
			expect(query.values).toContain("project-a");
			expect(query.values).not.toContain("project-b");
			expect(query.values).toContain(3);
		}
		expect(m.query.mock.calls[0][0].strings.join("")).toContain(
			"d.version::text",
		);
		expect(m.query.mock.calls[1][0].strings.join("")).toContain(
			'"indexingExcluded" = false',
		);
	});
	it("does not query sources after revocation or a mismatched actor/organization", async () => {
		m.access.mockResolvedValue(false);
		await expect(getReportProjectKnowledge(input)).rejects.toThrow(
			"denied",
		);
		expect(m.query).not.toHaveBeenCalled();
	});
	it("refuses a foreign source ID despite an actor having A+B access", async () => {
		await expect(
			getReportProjectKnowledge({
				...input,
				sourceId: "project-b-source",
			}),
		).rejects.toThrow("not admitted");
		expect(m.query).not.toHaveBeenCalled();
	});
	it("does not accept a caller's future cutoff as authority", async () => {
		await expect(
			getReportProjectKnowledge({
				...input,
				dateRange: {
					start: input.dateRange.start,
					end: "2099-01-01T00:00:00Z",
				},
			}),
		).rejects.toThrow("not admitted");
		expect(m.query).not.toHaveBeenCalled();
	});
});
