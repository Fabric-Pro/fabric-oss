import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	execution: vi.fn(),
	query: vi.fn(),
	access: vi.fn(),
	activities: {
		fetchTemplateInstanceWithTemplate: vi.fn(),
		updateInstanceExecutionStatus: vi.fn(),
		fetchReportTemplateSkills: vi.fn(),
		checkFabricHealth: vi.fn(),
		applyFabricPatternEnrichment: vi.fn(),
		resolveReportConnections: vi.fn(),
		fetchDataSources: vi.fn(),
		executeAiAnalysis: vi.fn(),
		renderInstanceReport: vi.fn(),
		storeInstanceArtifact: vi.fn(),
		indexInstanceArtifactForRag: vi.fn(),
		cleanupRagCollection: vi.fn(),
		emitReportExecutionNotification: vi.fn(),
		sendReportExecutionEmail: vi.fn(),
	},
}));
vi.mock("../../../../database/prisma/client", () => ({
	db: { $queryRaw: m.query },
}));
vi.mock("../../../../database/prisma/queries/reports", () => ({
	getTemplateInstanceExecution: m.execution,
}));
vi.mock("../../../../database/prisma/queries/lib/report-access", () => ({
	canExecuteReportInstance: m.access,
}));
vi.mock("@repo/database", async () => ({
	...(await import(
		"../../../../database/prisma/queries/lib/report-evidence"
	)),
	...(await import(
		"../../../../database/prisma/queries/reports-project-knowledge"
	)),
}));
vi.mock("@temporalio/workflow", () => ({
	proxyActivities: () => m.activities,
	patched: () => false,
	ApplicationFailure: class extends Error {
		static create(input: { message: string }) {
			return new Error(input.message);
		}
	},
}));

import { buildReportExecutionSnapshot } from "../../../../database/prisma/queries/lib/report-evidence";
import { FabricDataSourceHandler } from "../../activities/template-instance/handlers/fabric-handler";
import { templateInstanceExecutionWorkflow } from "../template-instance-execution";

const definition = {
	dataSources: [
		{
			id: "knowledge",
			type: "fabric",
			provider: "fabric_project",
			operation: "project_knowledge",
			config: {},
		},
	],
	sections: [],
	userPrompt: "Summarize completed delivery and cite the project documents.",
};
const instance = {
	id: "report-1",
	userId: "user-1",
	organizationId: "org-1",
	name: "Monthly delivery",
	parameterDefaults: {},
	connections: {},
	fabricConfig: {
		reporting: { version: 1, period: "monthly", projectId: "project-a" },
	},
	template: {
		id: "template-1",
		name: "Delivery",
		definition,
		fabricConfig: {},
		outputFormat: "MARKDOWN",
	},
};
const snapshot = buildReportExecutionSnapshot({
	instance,
	organizationId: "org-1",
	userId: "user-1",
	occurrenceAt: new Date("2026-11-02T09:00:00Z"),
	origin: "manual",
});
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
	m.query.mockImplementation(async (query) =>
		query.strings.join("").includes("FROM project_document")
			? [
					{
						id: "doc-a",
						title: "Delivery evidence",
						content: "A completed feature was delivered.",
						revision: "3",
						updatedAt: new Date("2026-10-15T00:00:00Z"),
						truncated: false,
					},
				]
			: [],
	);
	m.activities.fetchTemplateInstanceWithTemplate.mockResolvedValue({
		...instance,
		reportingExecution: snapshot,
		reportingParameters: {},
	});
	m.activities.updateInstanceExecutionStatus.mockResolvedValue(true);
	m.activities.fetchReportTemplateSkills.mockResolvedValue([]);
	m.activities.checkFabricHealth.mockResolvedValue({ healthy: false });
	m.activities.fetchDataSources.mockImplementation(async (input) => {
		const handler = new FabricDataSourceHandler();
		const result = await handler.fetchData(
			input.dataSources[0],
			{},
			{
				executionId: input.executionId,
				userId: input.userId,
				organizationId: input.organizationId,
				dateRange: input.dateRange,
				parameters: {},
			},
		);
		return {
			results: [
				{
					sourceId: "knowledge",
					sourceType: "fabric",
					provider: "fabric_project",
					data: result.data,
					recordCount: result.recordCount,
					provenance: result.metadata.provenance,
				},
			],
			fetchStates: {},
			totalRecords: result.recordCount,
		};
	});
	m.activities.executeAiAnalysis.mockImplementation(async (input) => [
		{
			agentId: "default",
			outputVariable: "analysis",
			output: input.dataResults[0].data[0].content,
		},
	]);
	m.activities.renderInstanceReport.mockImplementation(async (input) => ({
		markdown: `# Delivery\n${input.aiResults[0].output}`,
		title: "Delivery",
	}));
	m.activities.storeInstanceArtifact.mockResolvedValue({ id: "artifact-1" });
});
it("carries real bounded Fabric source output and admitted revisions into the report artifact without MCP/private-source access", async () => {
	const result = await templateInstanceExecutionWorkflow({
		executionId: "execution-1",
		instanceId: "report-1",
		organizationId: "org-1",
		userId: "user-1",
		reportingProtocol: 1,
	});
	expect(result.status).toBe("COMPLETED");
	expect(m.query).toHaveBeenCalledTimes(2);
	expect(m.activities.executeAiAnalysis).toHaveBeenCalledWith(
		expect.objectContaining({
			dataResults: [
				expect.objectContaining({
					data: [
						expect.objectContaining({
							projectId: "project-a",
							id: "doc-a",
							revision: "3",
						}),
					],
				}),
			],
		}),
	);
	expect(m.activities.storeInstanceArtifact).toHaveBeenCalledWith(
		expect.objectContaining({
			content: expect.stringContaining(
				"A completed feature was delivered.",
			),
			metadata: expect.objectContaining({
				reporting: expect.objectContaining({
					window: snapshot.window,
					sourceRevisions: [
						expect.objectContaining({
							id: "doc-a",
							revision: "3",
							citation: "projects/project-a/documents/doc-a",
						}),
					],
				}),
			}),
		}),
	);
	expect(m.activities.indexInstanceArtifactForRag).not.toHaveBeenCalled();
	for (const [query] of m.query.mock.calls) {
		expect(query.values).not.toContain("project-b");
	}
});
it("stops before model spend and artifact publication when project knowledge access is revoked", async () => {
	m.access.mockResolvedValue(false);
	await expect(
		templateInstanceExecutionWorkflow({
			executionId: "execution-1",
			instanceId: "report-1",
			organizationId: "org-1",
			userId: "user-1",
			reportingProtocol: 1,
		}),
	).rejects.toThrow("denied");
	expect(m.activities.executeAiAnalysis).not.toHaveBeenCalled();
	expect(m.activities.storeInstanceArtifact).not.toHaveBeenCalled();
});

it("uses admitted skill text after the current skill changes or detaches", async () => {
	m.activities.fetchTemplateInstanceWithTemplate.mockResolvedValue({
		...instance,
		reportingExecution: {
			...snapshot,
			skills: [
				{
					id: "skill-1",
					version: 2,
					updatedAt: "2026-10-01T00:00:00.000Z",
					name: "Pinned",
					content: "ORIGINAL FORMAT",
				},
			],
		},
		reportingParameters: {},
	});
	m.activities.fetchReportTemplateSkills.mockResolvedValue([
		{ name: "Current", content: "MUTATED FORMAT" },
	]);
	await templateInstanceExecutionWorkflow({
		executionId: "execution-1",
		instanceId: "report-1",
		organizationId: "org-1",
		userId: "user-1",
		reportingProtocol: 1,
	});
	expect(m.activities.fetchReportTemplateSkills).not.toHaveBeenCalled();
	expect(
		m.activities.executeAiAnalysis.mock.calls[0][0].skillsContent,
	).toContain("ORIGINAL FORMAT");
	expect(
		m.activities.executeAiAnalysis.mock.calls[0][0].skillsContent,
	).not.toContain("MUTATED FORMAT");
});
