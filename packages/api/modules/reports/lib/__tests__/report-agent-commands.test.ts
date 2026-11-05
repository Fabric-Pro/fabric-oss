import {
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	flag: vi.fn(),
	membership: vi.fn(),
	projectPermission: vi.fn(),
	list: vi.fn(),
	instance: vi.fn(),
	admit: vi.fn(),
	receipt: vi.fn(),
	start: vi.fn(),
	artifact: vi.fn(),
	access: vi.fn(),
	update: vi.fn(),
	connectionFailure: vi.fn(),
	projectAccess: vi.fn(),
	template: vi.fn(),
	templates: vi.fn(),
	createReport: vi.fn(),
	availableConfigs: vi.fn(),
	findProject: vi.fn(),
	findUser: vi.fn(),
	platformAdmin: vi.fn(),
	hasProjectAccess: vi.fn(),
	isProjectSoftDeleted: vi.fn(),
}));

vi.mock("../report-connection-test", () => ({
	reportSourceConnectionFailure: m.connectionFailure,
}));
vi.mock("../report-creation", async (importOriginal) => ({
	...(await importOriginal<typeof import("../report-creation")>()),
	createReportFromTemplate: m.createReport,
}));

vi.mock("@repo/database", async () => ({
	...(await import(
		"../../../../../database/prisma/queries/lib/report-evidence"
	)),
	isFeatureEnabled: m.flag,
	isPlatformAdmin: m.platformAdmin,
	getOrganizationMembership: m.membership,
	hasProjectAccess: m.hasProjectAccess,
	isProjectSoftDeleted: m.isProjectSoftDeleted,
	listTemplateInstances: m.list,
	getTemplateInstance: m.instance,
	getTemplateInstanceExecution: async () => null,
	admitTemplateInstanceExecution: m.admit,
	updateTemplateInstanceExecution: m.receipt,
	reportExecutionAdmissionId: (value: string) => `id-${value.length}`,
	getTemplateInstanceArtifact: m.artifact,
	canAccessReportInstance: m.access,
	updateTemplateInstance: m.update,
	getReportTemplate: m.template,
	listReportTemplates: m.templates,
	getAvailableMcpConfigsForKeys: m.availableConfigs,
	db: {
		project: { findUnique: m.findProject },
		user: { findUnique: m.findUser },
	},
}));
vi.mock("@repo/integrations/gitlab", () => ({
	GitLabPmOriginMismatchError: class extends Error {},
	resolveProjectPMConfigForUser: async () => ({
		id: "config-project",
		enabled: true,
		mcpServer: { key: "fizzy", category: "Project Management", tags: [] },
	}),
}));
vi.mock("../report-board-access", () => ({
	boardIsListedForConfig: async () => false,
}));
vi.mock("../../../../orpc/procedures", () => ({
	userHasProjectPermission: m.projectPermission,
}));
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.projectAccess,
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: m.start, getHandle: () => ({ describe: vi.fn() }) },
	}),
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (value: unknown) => value,
}));

import {
	AGENT_REPORT_CONTENT_MAX_CHARS,
	createProjectReportForAgent,
	generateReportForAgent,
	getReportContentForAgent,
	listProjectReportsForAgent,
	listReportTemplatesForAgent,
	updateReportPromptForAgent,
} from "../report-agent-commands";

const actor = {
	userId: "example-owner",
	organizationId: "example-org",
	planEligible: true,
};
const reachable = async () => true;

function report(overrides: Record<string, unknown> = {}) {
	return {
		id: "report-1",
		name: "Weekly status",
		description: null,
		userId: "example-owner",
		organizationId: "example-org",
		projectId: "project-1",
		isActive: true,
		connections: {},
		parameterDefaults: null,
		fabricConfig: null,
		lastRunAt: null,
		executions: [],
		template: {
			name: "Status",
			definition: {},
			connections: {},
			parameters: {
				required: ["team"],
				properties: { team: { type: "string" } },
			},
		},
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	m.flag.mockResolvedValue(true);
	m.membership.mockResolvedValue({ role: "member" });
	m.findUser.mockResolvedValue({ role: "user" });
	m.platformAdmin.mockResolvedValue(false);
	m.projectPermission.mockResolvedValue(true);
	m.instance.mockResolvedValue(report());
	m.admit.mockImplementation(async (value) => ({
		...value,
		status: "PENDING",
	}));
	m.start.mockResolvedValue({ firstExecutionRunId: "run-1" });
	m.receipt.mockResolvedValue({});
	m.access.mockResolvedValue(true);
	m.update.mockResolvedValue({});
	m.artifact.mockResolvedValue(null);
	m.connectionFailure.mockResolvedValue(null);
	m.hasProjectAccess.mockResolvedValue(true);
	m.isProjectSoftDeleted.mockResolvedValue(false);
	m.projectAccess.mockResolvedValue({
		source: "project-member",
		organizationId: "example-org",
		organizationDeleted: false,
		permissions: resolveProjectPermissions("EDITOR"),
	});
});

describe("generateReportForAgent", () => {
	it("refuses an owner whose project role no longer lets them generate, naming why", async () => {
		m.projectAccess.mockResolvedValue({
			source: "project-member",
			organizationId: "example-org",
			organizationDeleted: false,
			permissions: resolveProjectPermissions("VIEWER"),
		});

		await expect(
			generateReportForAgent(
				actor,
				{ instanceId: "report-1", parameters: { team: "Example" } },
				reachable,
			),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("but not generate it"),
		});
		expect(m.admit).not.toHaveBeenCalled();
	});

	it("tests the report's required connections live and refuses, naming the source, before admitting a run", async () => {
		m.connectionFailure.mockResolvedValue(
			"A required data source did not connect, so the report was not generated. Example board: its server could not be reached. Fix the connection on the report page, then generate again.",
		);

		await expect(
			generateReportForAgent(
				actor,
				{ instanceId: "report-1", parameters: { team: "Example" } },
				reachable,
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("Example board"),
		});
		expect(m.connectionFailure).toHaveBeenCalledWith(
			expect.objectContaining({ id: "report-1" }),
			{ userId: "example-owner", organizationId: "example-org" },
		);
		expect(m.admit).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});

	it("starts the owner's ready report through the Generate button's admission", async () => {
		const result = await generateReportForAgent(
			actor,
			{ instanceId: "report-1", parameters: { team: "Example" } },
			reachable,
		);

		expect(result.startConfirmed).toBe(true);
		expect(m.admit.mock.calls[0][0]).toMatchObject({
			instanceId: "report-1",
			organizationId: "example-org",
			parameters: { team: "Example" },
		});
		expect(m.start).toHaveBeenCalledTimes(1);
	});

	it.each([
		[true, "a person started it"],
		[false, "a key or token started it"],
	])("starts the run with planEligible %s when %s", async (planEligible) => {
		await generateReportForAgent(
			{ ...actor, planEligible },
			{ instanceId: "report-1", parameters: { team: "Example" } },
			reachable,
		);

		expect(m.start).toHaveBeenCalledWith(
			"templateInstanceExecutionWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ planEligible })],
			}),
		);
	});

	it("says how to send parameters when they are invalid", async () => {
		await expect(
			generateReportForAgent(
				actor,
				{
					instanceId: "report-1",
					parameters: { team: "x".repeat(33_000) },
				},
				reachable,
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("an omitted parameter keeps"),
		});
		expect(m.admit).not.toHaveBeenCalled();
	});

	it("refuses a report whose required parameter has no value before spending credits", async () => {
		await expect(
			generateReportForAgent(
				actor,
				{ instanceId: "report-1" },
				reachable,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.admit).not.toHaveBeenCalled();
	});

	it("refuses anyone but the owner, because a report runs on the owner's connections", async () => {
		m.instance.mockResolvedValue(report({ userId: "example-editor" }));

		await expect(
			generateReportForAgent(
				actor,
				{ instanceId: "report-1", parameters: { team: "Example" } },
				reachable,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.admit).not.toHaveBeenCalled();
	});

	it("refuses an organization role without report execution", async () => {
		m.membership.mockResolvedValue({ role: "viewer" });

		await expect(
			generateReportForAgent(
				actor,
				{ instanceId: "report-1", parameters: { team: "Example" } },
				reachable,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.instance).not.toHaveBeenCalled();
	});

	it("refuses while the report suite is off for the organization", async () => {
		m.flag.mockResolvedValue(false);

		await expect(
			generateReportForAgent(
				actor,
				{ instanceId: "report-1", parameters: { team: "Example" } },
				reachable,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.instance).not.toHaveBeenCalled();
	});

	it("refuses a report in a project the session may not reach", async () => {
		await expect(
			generateReportForAgent(
				actor,
				{ instanceId: "report-1", parameters: { team: "Example" } },
				async (projectId) => projectId !== "project-1",
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.admit).not.toHaveBeenCalled();
	});
});

describe("listProjectReportsForAgent", () => {
	it("says which reports the caller can generate and why not", async () => {
		m.list.mockResolvedValue({
			instances: [
				report({ parameterDefaults: { team: "Example" } }),
				report({ id: "report-2", userId: "example-editor" }),
			],
			total: 2,
		});

		const result = await listProjectReportsForAgent(actor, {
			projectId: "project-1",
			limit: 500,
		});

		expect(m.list.mock.calls[0][0]).toMatchObject({
			projectId: "project-1",
			organizationId: "example-org",
			limit: 50,
		});
		expect(result.reports.map((r) => [r.id, r.canGenerate])).toEqual([
			["report-1", true],
			["report-2", false],
		]);
		expect(result.reports[1].generateBlockedReason).toContain("owner");
	});

	it("refuses a member with no row on the project, whose role alone reads no project", async () => {
		m.hasProjectAccess.mockResolvedValue(false);

		await expect(
			listProjectReportsForAgent(actor, { projectId: "project-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.list).not.toHaveBeenCalled();
	});

	it("refuses a project the caller may not read", async () => {
		m.projectPermission.mockResolvedValue(false);

		await expect(
			listProjectReportsForAgent(actor, { projectId: "project-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.list).not.toHaveBeenCalled();
	});

	it("says why the latest run failed, with secrets redacted and at a bounded length", async () => {
		m.list.mockResolvedValue({
			instances: [
				report({
					executions: [
						{
							status: "FAILED",
							startedAt: null,
							error: `The board refused token=example-secret ${"x".repeat(400)}`,
						},
					],
				}),
			],
			total: 1,
		});

		const result = await listProjectReportsForAgent(actor, {
			projectId: "project-1",
		});

		const reason = result.reports[0].latestExecutionFailureReason;
		expect(reason).toContain("The board refused token=[REDACTED]");
		expect(reason).not.toContain("example-secret");
		expect(reason?.length).toBeLessThanOrEqual(300);
	});

	it("gives no failure reason for a run that did not fail", async () => {
		m.list.mockResolvedValue({
			instances: [
				report({
					executions: [
						{
							status: "COMPLETED",
							startedAt: null,
							error: "A retried step's old error",
						},
					],
				}),
				report({ id: "report-2" }),
			],
			total: 2,
		});

		const result = await listProjectReportsForAgent(actor, {
			projectId: "project-1",
		});

		expect(
			result.reports.map((r) => r.latestExecutionFailureReason),
		).toEqual([null, null]);
	});
});

/** A report with a person's instructions and two runs, the newest of which failed. */
function iteratedReport(overrides: Record<string, unknown> = {}) {
	return report({
		connections: {
			mcpBindings: { "task-board": "config-1" },
			promptOverride: "Keep the risks section short",
			promptOverrideSource: "user",
		},
		fabricConfig: {
			customAiTasks: { summary: "Summarize the week", empty: " " },
		},
		template: {
			name: "Status",
			definition: { userPrompt: "Summarize the project's week" },
			connections: {},
			parameters: {},
		},
		executions: [
			{ id: "execution-3", status: "FAILED", artifacts: [] },
			{
				id: "execution-2",
				status: "COMPLETED",
				completedAt: new Date("2026-11-04T09:00:00Z"),
				artifacts: [
					{ id: "artifact-json", artifactType: "JSON" },
					{ id: "artifact-markdown", artifactType: "MARKDOWN" },
				],
			},
		],
		...overrides,
	});
}

describe("getReportContentForAgent", () => {
	it("returns the person's instructions, the report's own task prompts and the newest completed run's text", async () => {
		m.instance.mockResolvedValue(iteratedReport());
		m.artifact.mockResolvedValue({
			name: "Weekly status.md",
			artifactType: "MARKDOWN",
			content: "# Weekly status",
		});

		const result = await getReportContentForAgent(
			actor,
			{ instanceId: "report-1" },
			reachable,
		);

		expect(m.artifact).toHaveBeenCalledTimes(1);
		expect(m.artifact).toHaveBeenCalledWith("artifact-markdown", {
			userId: "example-owner",
			organizationId: "example-org",
		});
		expect(result).toMatchObject({
			instanceId: "report-1",
			instructions: "Keep the risks section short",
			instructionsSource: "report",
			customAiTasks: { summary: "Summarize the week" },
			canEditInstructions: true,
			latestRun: {
				executionId: "execution-2",
				completedAt: "2026-11-04T09:00:00.000Z",
				content: "# Weekly status",
				truncated: false,
				totalChars: 15,
			},
		});
		expect(m.projectPermission).toHaveBeenCalledWith({
			userId: "example-owner",
			projectId: "project-1",
			permission: "report:read",
		});
	});

	it("returns the tasks as the next run takes them, with the report's edits and instructions", async () => {
		m.instance.mockResolvedValue(
			iteratedReport({
				template: {
					name: "Status",
					definition: {
						userPrompt: "Summarize the project's week",
						aiAgents: [
							{
								agentId: "default",
								task: "Write the template's summary",
								outputVariable: "summary",
							},
							{ agentId: "default", task: "List the risks" },
						],
					},
					connections: {},
					parameters: {},
				},
			}),
		);

		const result = await getReportContentForAgent(
			actor,
			{ instanceId: "report-1" },
			reachable,
		);

		expect(result.tasks).toEqual([
			{
				key: "summary",
				task: "Summarize the week\n\nReport instructions:\nKeep the risks section short",
				customized: true,
			},
			{
				key: "agent-1",
				task: "List the risks\n\nReport instructions:\nKeep the risks section short",
				customized: false,
			},
		]);
	});

	it("reads the template's prompt when the report's override was not written by a person", async () => {
		m.instance.mockResolvedValue(
			iteratedReport({
				connections: { promptOverride: "An older template prompt" },
			}),
		);

		const result = await getReportContentForAgent(
			actor,
			{ instanceId: "report-1" },
			reachable,
		);

		expect(result.instructions).toBe("Summarize the project's week");
		expect(result.instructionsSource).toBe("template");
	});

	it("cuts long report text to the bound and says so", async () => {
		m.instance.mockResolvedValue(iteratedReport());
		m.artifact.mockResolvedValue({
			name: "Weekly status.md",
			artifactType: "MARKDOWN",
			content: "x".repeat(AGENT_REPORT_CONTENT_MAX_CHARS + 10),
		});

		const result = await getReportContentForAgent(
			actor,
			{ instanceId: "report-1" },
			reachable,
		);

		expect(result.latestRun?.content).toHaveLength(
			AGENT_REPORT_CONTENT_MAX_CHARS,
		);
		expect(result.latestRun?.truncated).toBe(true);
		expect(result.latestRun?.totalChars).toBe(
			AGENT_REPORT_CONTENT_MAX_CHARS + 10,
		);
		expect(result.message).toContain(
			`first ${AGENT_REPORT_CONTENT_MAX_CHARS}`,
		);
	});

	it("says how to get content when the report has no completed run yet", async () => {
		m.instance.mockResolvedValue(iteratedReport({ executions: [] }));

		const result = await getReportContentForAgent(
			actor,
			{ instanceId: "report-1" },
			reachable,
		);

		expect(result.latestRun).toBeNull();
		expect(result.message).toContain("no completed run");
		expect(result.message).toContain("fabric_generate_report");
		expect(m.artifact).not.toHaveBeenCalled();
	});

	it("treats a completed run whose report the caller may not open as no run", async () => {
		m.instance.mockResolvedValue(iteratedReport());

		const result = await getReportContentForAgent(
			actor,
			{ instanceId: "report-1" },
			reachable,
		);

		expect(result.latestRun).toBeNull();
	});

	it.each([
		[
			"the caller cannot see the report",
			() => m.instance.mockResolvedValue(null),
		],
		[
			"the caller may not read the report's project",
			() => m.projectPermission.mockResolvedValue(false),
		],
	])("refuses as not found when %s", async (_case, arrange) => {
		m.instance.mockResolvedValue(iteratedReport());
		arrange();

		await expect(
			getReportContentForAgent(
				actor,
				{ instanceId: "report-1" },
				reachable,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.artifact).not.toHaveBeenCalled();
	});

	it("refuses a report in a project the session may not reach", async () => {
		m.instance.mockResolvedValue(iteratedReport());

		await expect(
			getReportContentForAgent(
				actor,
				{ instanceId: "report-1" },
				async (projectId) => projectId !== "project-1",
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.artifact).not.toHaveBeenCalled();
	});
});

describe("updateReportPromptForAgent", () => {
	it("saves the person's instructions as the report page does, keeping the report's connections", async () => {
		m.instance.mockResolvedValue(iteratedReport());

		const result = await updateReportPromptForAgent(
			actor,
			{
				instanceId: "report-1",
				userPrompt: "  Make the risks section two bullets  ",
			},
			reachable,
		);

		expect(m.update).toHaveBeenCalledWith({
			id: "report-1",
			connections: {
				mcpBindings: { "task-board": "config-1" },
				promptOverride: "Make the risks section two bullets",
				promptOverrideSource: "user",
			},
		});
		expect(m.access).toHaveBeenCalledWith(
			expect.objectContaining({ id: "report-1" }),
			{ userId: "example-owner", organizationId: "example-org" },
			undefined,
			true,
		);
		expect(result.instructionsSource).toBe("report");
		expect(result.message).toContain("fabric_generate_report");
	});

	it("drops the override when the text is the template's own prompt, so the report follows its template", async () => {
		m.instance.mockResolvedValue(iteratedReport());

		const result = await updateReportPromptForAgent(
			actor,
			{
				instanceId: "report-1",
				userPrompt: "Summarize the project's week",
			},
			reachable,
		);

		expect(m.update).toHaveBeenCalledWith({
			id: "report-1",
			connections: { mcpBindings: { "task-board": "config-1" } },
		});
		expect(result.instructionsSource).toBe("template");
	});

	it("tells an editor who does not own the report that only the owner can generate it", async () => {
		m.membership.mockResolvedValue({ role: "admin" });
		m.instance.mockResolvedValue(
			iteratedReport({ userId: "example-report-owner" }),
		);

		const result = await updateReportPromptForAgent(
			actor,
			{ instanceId: "report-1", userPrompt: "Shorter risks" },
			reachable,
		);

		expect(m.update).toHaveBeenCalledTimes(1);
		expect(result.message).toContain("Only the report's owner");
	});

	it("refuses a member who may not edit someone else's report", async () => {
		m.instance.mockResolvedValue(
			iteratedReport({ userId: "example-report-owner" }),
		);
		m.projectAccess.mockResolvedValue(null);

		await expect(
			updateReportPromptForAgent(
				actor,
				{ instanceId: "report-1", userPrompt: "Shorter risks" },
				reachable,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.update).not.toHaveBeenCalled();
	});

	it("refuses when the report page's project write check refuses", async () => {
		m.instance.mockResolvedValue(iteratedReport());
		m.access.mockResolvedValue(false);

		await expect(
			updateReportPromptForAgent(
				actor,
				{ instanceId: "report-1", userPrompt: "Shorter risks" },
				reachable,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.update).not.toHaveBeenCalled();
	});

	it("carries the real platform role, so a system admin who is a member may change the instructions", async () => {
		m.membership.mockResolvedValue({ role: "viewer" });
		m.findUser.mockResolvedValue({ role: "admin" });
		m.platformAdmin.mockImplementation(
			async (user: { role?: string }) => user.role === "admin",
		);
		m.instance.mockResolvedValue(
			iteratedReport({ userId: "example-report-owner" }),
		);

		await updateReportPromptForAgent(
			actor,
			{ instanceId: "report-1", userPrompt: "Shorter risks" },
			reachable,
		);

		expect(m.update).toHaveBeenCalledTimes(1);
	});

	it("refuses a system admin who is not a member", async () => {
		m.membership.mockResolvedValue(null);
		m.findUser.mockResolvedValue({ role: "admin" });
		m.platformAdmin.mockImplementation(
			async (user: { role?: string }) => user.role === "admin",
		);

		await expect(
			updateReportPromptForAgent(
				actor,
				{ instanceId: "report-1", userPrompt: "Shorter risks" },
				reachable,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.instance).not.toHaveBeenCalled();
	});

	it("refuses an organization Viewer with no Editor row on the report's project", async () => {
		m.membership.mockResolvedValue({ role: "viewer" });
		m.instance.mockResolvedValue(iteratedReport());
		m.projectAccess.mockResolvedValue({
			source: "org",
			organizationId: "example-org",
			organizationDeleted: false,
			permissions: resolveOrgPermissions("viewer"),
		});

		await expect(
			updateReportPromptForAgent(
				actor,
				{ instanceId: "report-1", userPrompt: "Shorter risks" },
				reachable,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.update).not.toHaveBeenCalled();
	});

	it("lets an organization Viewer with an Editor row change the instructions", async () => {
		m.membership.mockResolvedValue({ role: "viewer" });
		m.instance.mockResolvedValue(
			iteratedReport({ userId: "example-report-owner" }),
		);
		m.projectAccess.mockResolvedValue({
			source: "project-member",
			organizationId: "example-org",
			organizationDeleted: false,
			permissions: resolveProjectPermissions("EDITOR"),
		});

		await updateReportPromptForAgent(
			actor,
			{ instanceId: "report-1", userPrompt: "Shorter risks" },
			reachable,
		);

		expect(m.update).toHaveBeenCalledTimes(1);
	});

	it("refuses a project guest who is not an organization member", async () => {
		m.membership.mockResolvedValue(null);

		await expect(
			updateReportPromptForAgent(
				actor,
				{ instanceId: "report-1", userPrompt: "Shorter risks" },
				reachable,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.instance).not.toHaveBeenCalled();
	});

	it("refuses empty instructions", async () => {
		m.instance.mockResolvedValue(iteratedReport());

		await expect(
			updateReportPromptForAgent(
				actor,
				{ instanceId: "report-1", userPrompt: "   " },
				reachable,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.update).not.toHaveBeenCalled();
	});

	it("refuses a report in a project the session may not reach", async () => {
		m.instance.mockResolvedValue(iteratedReport());

		await expect(
			updateReportPromptForAgent(
				actor,
				{ instanceId: "report-1", userPrompt: "Shorter risks" },
				async (projectId) => projectId !== "project-1",
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.update).not.toHaveBeenCalled();
	});
});

describe("listReportTemplatesForAgent", () => {
	it("lists the catalog with what an agent needs to fill a new report", async () => {
		m.templates.mockResolvedValue({
			templates: [
				{
					id: "template-1",
					name: "Status",
					description: "Weekly status",
					category: "delivery",
					isGeneric: false,
					definition: {
						dataSources: [{ type: "mcp", provider: "fizzy" }],
					},
					parameters: {
						required: ["team"],
						properties: {
							team: { title: "Team" },
							since: {},
						},
					},
				},
			],
			total: 1,
		});

		const result = await listReportTemplatesForAgent(actor, {
			projectId: "project-1",
			search: "status",
		});

		expect(m.templates).toHaveBeenCalledWith({
			userId: "example-owner",
			organizationId: "example-org",
			search: "status",
			limit: 20,
		});
		expect(result).toEqual({
			templates: [
				{
					id: "template-1",
					name: "Status",
					description: "Weekly status",
					category: "delivery",
					needsConnection: true,
					parameters: [
						{ key: "team", title: "Team", required: true },
						{ key: "since", title: "since", required: false },
					],
				},
			],
			total: 1,
		});
	});

	it("refuses a project the caller may not read", async () => {
		m.projectPermission.mockResolvedValue(false);

		await expect(
			listReportTemplatesForAgent(actor, { projectId: "project-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.templates).not.toHaveBeenCalled();
	});

	it("refuses while the report suite is off for the organization", async () => {
		m.flag.mockResolvedValue(false);

		await expect(
			listReportTemplatesForAgent(actor, { projectId: "project-1" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.templates).not.toHaveBeenCalled();
	});
});

describe("createProjectReportForAgent", () => {
	const input = { projectId: "project-1", templateId: "template-1" };
	const template = {
		id: "template-1",
		name: "Status",
		definition: { dataSources: [{ type: "mcp", provider: "fizzy" }] },
		connections: {
			mcpServers: [
				{ key: "fizzy", name: "Example board", required: true },
			],
		},
		parameters: {},
	};

	beforeEach(() => {
		// An organization admin on a project in the organization may add reports.
		m.membership.mockResolvedValue({ role: "admin" });
		m.projectAccess.mockResolvedValue({
			source: "organization",
			organizationId: "example-org",
			organizationDeleted: false,
			permissions: [],
		});
		m.template.mockResolvedValue(template);
		m.createReport.mockImplementation(async ({ creation }) => ({
			id: "report-new",
			name: creation.name,
			isActive: true,
			connections: creation.connections,
			parameterDefaults: creation.parameterDefaults ?? null,
			fabricConfig: null,
		}));
	});

	it("makes the report through the dialog's path, named after its template by default", async () => {
		await createProjectReportForAgent(actor, input, reachable);

		expect(m.createReport).toHaveBeenCalledWith({
			caller: { id: "example-owner", role: "user" },
			organizationId: "example-org",
			creation: expect.objectContaining({
				templateId: "template-1",
				name: "Status",
				projectId: "project-1",
				connections: expect.objectContaining({ mcpConfigs: [] }),
				reporting: undefined,
			}),
		});
	});

	describe("the project's own connection", () => {
		const connectorTemplate = {
			...template,
			definition: {
				dataSources: [
					{ id: "task-board", type: "mcp", provider: "fizzy" },
				],
			},
		};

		beforeEach(() => {
			m.template.mockResolvedValue(connectorTemplate);
			m.findProject.mockResolvedValue({
				projectManagementMcpConfigId: "config-project",
				projectManagementContainerId: "board-1",
				projectManagementContainerName: "Example board",
				projectManagementAdditionalContext: { account_slug: "/000000" },
			});
		});

		it("binds it when it is the caller's own, so the report can generate", async () => {
			m.availableConfigs.mockResolvedValue([
				{ key: "fizzy", configs: [{ configId: "config-project" }] },
			]);

			const result = await createProjectReportForAgent(
				actor,
				input,
				reachable,
			);

			expect(m.availableConfigs).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: "example-owner",
					organizationId: "example-org",
				}),
			);
			expect(
				m.createReport.mock.calls[0][0].creation.connections,
			).toMatchObject({
				mcpConfigs: ["config-project"],
				mcpBindings: {
					"task-board": "config-project",
					fizzy: "config-project",
				},
				context: { boardId: "board-1", boardName: "Example board" },
			});
			expect(result.canGenerate).toBe(true);
		});

		it("stays unconnected when the connection is someone else's", async () => {
			m.availableConfigs.mockResolvedValue([
				{ key: "fizzy", configs: [{ configId: "config-mine" }] },
			]);

			const result = await createProjectReportForAgent(
				actor,
				input,
				reachable,
			);

			expect(
				m.createReport.mock.calls[0][0].creation.connections,
			).toMatchObject({ mcpConfigs: [] });
			expect(
				m.createReport.mock.calls[0][0].creation.connections
					.mcpBindings,
			).toBeUndefined();
			expect(result.generateBlockedReason).toBe(
				"Connect Example board to generate this report.",
			);
		});

		it("reads nothing for a connector-free template", async () => {
			m.template.mockResolvedValue({
				...template,
				definition: {},
				connections: {},
			});

			await createProjectReportForAgent(actor, input, reachable);

			expect(m.findProject).not.toHaveBeenCalled();
			expect(
				m.createReport.mock.calls[0][0].creation.connections,
			).toMatchObject({ mcpConfigs: [] });
		});
	});

	describe("from a prompt", () => {
		const custom = {
			id: "template-custom",
			name: "Custom report",
			definition: {},
			connections: {},
			parameters: {},
		};
		const promptInput = {
			projectId: "project-1",
			prompt: "  Cover this sprint's risks  ",
		};

		beforeEach(() => {
			m.templates.mockResolvedValue({
				templates: [
					{ id: "template-other", name: "Custom report notes" },
					custom,
				],
				total: 2,
			});
			m.template.mockResolvedValue(custom);
		});

		it("starts from Custom report when no template is named, looked up whether or not a run has proven it", async () => {
			await createProjectReportForAgent(actor, promptInput, reachable);

			expect(m.templates).toHaveBeenCalledWith(
				expect.objectContaining({
					scope: "SYSTEM",
					search: "Custom report",
					includeUnproven: true,
				}),
			);
			expect(m.template).toHaveBeenCalledWith(
				expect.objectContaining({ id: "template-custom" }),
			);
			expect(m.createReport.mock.calls[0][0].creation).toMatchObject({
				templateId: "template-custom",
				name: "Custom report",
			});
		});

		it("makes the prompt the report's own instructions, as the report page saves them", async () => {
			await createProjectReportForAgent(actor, promptInput, reachable);

			expect(
				m.createReport.mock.calls[0][0].creation.connections,
			).toMatchObject({
				promptOverride: "Cover this sprint's risks",
				promptOverrideSource: "user",
			});
		});

		it("adds a prompt to a named template without looking for Custom report", async () => {
			m.template.mockResolvedValue(template);

			await createProjectReportForAgent(
				actor,
				{ ...input, prompt: "Cover the risks" },
				reachable,
			);

			expect(m.templates).not.toHaveBeenCalled();
			expect(
				m.createReport.mock.calls[0][0].creation.connections
					.promptOverride,
			).toBe("Cover the risks");
		});

		it("leaves the instructions alone with no prompt", async () => {
			await createProjectReportForAgent(actor, input, reachable);

			expect(
				m.createReport.mock.calls[0][0].creation.connections,
			).not.toHaveProperty("promptOverride");
		});

		it("asks for a prompt or a template when given neither", async () => {
			await expect(
				createProjectReportForAgent(
					actor,
					{ projectId: "project-1", prompt: "   " },
					reachable,
				),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("templateId"),
			});
			expect(m.createReport).not.toHaveBeenCalled();
		});

		it("says what to send when Custom report is not there", async () => {
			m.templates.mockResolvedValue({
				templates: [
					{ id: "template-other", name: "Custom report notes" },
				],
				total: 1,
			});

			await expect(
				createProjectReportForAgent(actor, promptInput, reachable),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
				message: expect.stringContaining(
					"fabric_list_report_templates",
				),
			});
			expect(m.createReport).not.toHaveBeenCalled();
		});
	});

	it("carries the real platform role, so a system admin who is a member may add a report", async () => {
		m.membership.mockResolvedValue({ role: "viewer" });
		m.findUser.mockResolvedValue({ role: "admin" });
		m.platformAdmin.mockImplementation(
			async (user: { role?: string }) => user.role === "admin",
		);

		await createProjectReportForAgent(actor, input, reachable);

		expect(m.createReport.mock.calls[0][0].caller).toEqual({
			id: "example-owner",
			role: "admin",
		});
	});

	it("refuses a system admin who is not a member", async () => {
		m.membership.mockResolvedValue(null);
		m.findUser.mockResolvedValue({ role: "admin" });
		m.platformAdmin.mockImplementation(
			async (user: { role?: string }) => user.role === "admin",
		);

		await expect(
			createProjectReportForAgent(actor, input, reachable),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.createReport).not.toHaveBeenCalled();
	});

	it("passes the chosen name and parameter values", async () => {
		await createProjectReportForAgent(
			actor,
			{
				...input,
				name: " Team status ",
				parameters: { team: "Example" },
			},
			reachable,
		);

		expect(m.createReport.mock.calls[0][0].creation).toMatchObject({
			name: "Team status",
			parameterDefaults: { team: "Example" },
		});
	});

	it("says what to connect when the new report cannot be generated yet", async () => {
		const result = await createProjectReportForAgent(
			actor,
			input,
			reachable,
		);

		expect(result).toMatchObject({
			instanceId: "report-new",
			canGenerate: false,
			generateBlockedReason:
				"Connect Example board to generate this report.",
		});
		expect(result.message).toContain("Connect Example board");
	});

	it("points at generating when the new report is ready", async () => {
		m.template.mockResolvedValue({
			...template,
			definition: {},
			connections: {},
		});

		const result = await createProjectReportForAgent(
			actor,
			input,
			reachable,
		);

		expect(result.canGenerate).toBe(true);
		expect(result.message).toContain("fabric_generate_report");
	});

	it("binds a report on Project knowledge to the project, as the dialog does", async () => {
		m.template.mockResolvedValue({
			...template,
			definition: {
				dataSources: [
					{
						type: "fabric",
						provider: "fabric_project",
						operation: "project_knowledge",
					},
				],
			},
		});

		await createProjectReportForAgent(actor, input, reachable);

		expect(
			m.createReport.mock.calls[0][0].creation.reporting,
		).toMatchObject({
			version: 1,
			period: "weekly",
			projectId: "project-1",
		});
	});

	it("refuses forged reserved parameters before writing", async () => {
		await expect(
			createProjectReportForAgent(
				actor,
				{ ...input, parameters: { __fabricReportExecution: "forged" } },
				reachable,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.createReport).not.toHaveBeenCalled();
	});

	it("refuses a template the caller may not see", async () => {
		m.template.mockResolvedValue(null);

		await expect(
			createProjectReportForAgent(actor, input, reachable),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.createReport).not.toHaveBeenCalled();
	});

	it("refuses someone who may not edit the project's reports", async () => {
		m.projectAccess.mockResolvedValue(null);

		await expect(
			createProjectReportForAgent(actor, input, reachable),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.createReport).not.toHaveBeenCalled();
	});

	it("refuses a project the session may not reach", async () => {
		await expect(
			createProjectReportForAgent(actor, input, async () => false),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.createReport).not.toHaveBeenCalled();
	});

	it("refuses an organization role that cannot add reports", async () => {
		m.membership.mockResolvedValue({ role: "viewer" });

		await expect(
			createProjectReportForAgent(actor, input, reachable),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.createReport).not.toHaveBeenCalled();
	});

	it("refuses while the report suite is off for the organization", async () => {
		m.flag.mockResolvedValue(false);

		await expect(
			createProjectReportForAgent(actor, input, reachable),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.createReport).not.toHaveBeenCalled();
	});
});
