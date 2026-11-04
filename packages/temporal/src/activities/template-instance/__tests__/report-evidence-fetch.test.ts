import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	execution: vi.fn(),
	access: vi.fn(),
	fetch: vi.fn(),
	validate: vi.fn(),
}));
vi.mock("@repo/database", async () => ({
	...(await import(
		"../../../../../database/prisma/queries/lib/report-evidence"
	)),
	getTemplateInstanceExecution: m.execution,
	canExecuteReportInstance: m.access,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/rag", () => ({ generateEmbedding: vi.fn() }));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../handlers", () => ({
	getHandlerForDataSource: () => ({
		validateConnection: m.validate,
		fetchData: m.fetch,
	}),
	inferDataSourceType: () => "mcp",
}));
vi.mock("../rag-processing", () => ({
	buildRagContextPrompt: vi.fn(),
	deleteReportCollection: vi.fn(),
	processDataForRag: vi.fn(),
	searchReportCollection: vi.fn(),
}));

import { fetchDataSources } from "../data-fetching";

const input = {
	reportingProtocol: 1 as const,
	executionId: "execution-1",
	userId: "user-1",
	organizationId: "org-1",
	dataSources: [
		{
			id: "source-1",
			type: "mcp",
			provider: "example",
			operation: "read",
			config: { fetchMode: "date_range" },
		},
	],
	connections: {},
	dateRange: {
		start: "2026-10-01T00:00:00.000Z",
		end: "2026-11-01T00:00:00.000Z",
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	m.execution.mockResolvedValue({
		userId: "user-1",
		status: "RUNNING",
		instance: { template: { definition: {} }, connections: {} },
		parameters: {},
	});
	m.access.mockResolvedValue(true);
	m.validate.mockResolvedValue({ valid: true });
	m.fetch.mockResolvedValue({
		success: true,
		data: [{ title: "Example" }],
		recordCount: 1,
		hasMore: false,
		metadata: {
			provider: "example",
			operation: "read",
			fetchedAt: "2026-11-02T00:00:00Z",
		},
	});
});
describe("report evidence activity boundary", () => {
	it("rechecks the persisted actor in the exact org before invoking a connector", async () => {
		await fetchDataSources(input);
		expect(m.execution).toHaveBeenCalledWith("execution-1", {
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(m.fetch).toHaveBeenCalled();
	});
	it("does not read a source after project access or membership revocation", async () => {
		m.access.mockResolvedValue(false);
		await expect(fetchDataSources(input)).rejects.toThrow("revoked");
		expect(m.fetch).not.toHaveBeenCalled();
	});
	it("rejects a mismatched actor and null tenant", async () => {
		m.execution.mockResolvedValue({
			userId: "other-user",
			status: "RUNNING",
		});
		await expect(fetchDataSources(input)).rejects.toThrow("revoked");
		await expect(
			fetchDataSources({ ...input, organizationId: undefined }),
		).rejects.toThrow("organization");
		expect(m.fetch).not.toHaveBeenCalled();
	});
	it("bounds the result so primary and comparison periods fit together, and marks truncation", async () => {
		m.fetch.mockResolvedValue({
			success: true,
			data: Array.from({ length: 2000 }, (_, id) => ({
				id,
				text: "example ".repeat(300),
			})),
			recordCount: 2000,
			hasMore: false,
			metadata: {
				provider: "example",
				operation: "read",
				fetchedAt: "2026-11-02T00:00:00Z",
			},
		});
		const result = await fetchDataSources(input);
		expect(result.isPartial).toBe(true);
		expect(
			new TextEncoder().encode(JSON.stringify(result)).length,
		).toBeLessThan(650000);
	});
});

it("does not use access to A+B or client source tags as evidence that B is safe for audience A", async () => {
	m.access.mockResolvedValue(true); // caller is authorized to both projects
	m.execution.mockResolvedValue({
		userId: "user-1",
		status: "RUNNING",
		instance: {
			template: { definition: {} },
			connections: {},
			fabricConfig: {
				reporting: {
					version: 1,
					period: "weekly",
					projectId: "project-a",
				},
			},
		},
		parameters: {
			projectId: "project-a",
			sourceProjectId: "project-b",
			audience: "project-a",
		},
	});
	await expect(
		fetchDataSources({
			...input,
			dataSources: [
				{
					...input.dataSources[0],
					config: { projectId: "project-b", audience: "project-a" },
				},
			],
		}),
	).rejects.toThrow("server-verified project audience binding");
	expect(m.fetch).not.toHaveBeenCalled();
});
