/**
 * The report tools as the gateway maps them onto the API's commands: which
 * report runs may use the starting member's own ChatGPT plan (one a person
 * started — a browser session, or Fabric Agent in their chat, which asks them
 * on every call — never one a key or OAuth token started), and how reading a
 * report and changing its instructions reach their commands.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	generate: vi.fn(),
	content: vi.fn(),
	updatePrompt: vi.fn(),
	listTemplates: vi.fn(),
	createReport: vi.fn(),
	ReportGenerationError: class ReportGenerationError extends Error {
		constructor(
			readonly code: string,
			message: string,
		) {
			super(message);
		}
	},
}));

vi.mock("@repo/api/modules/reports/lib/report-agent-commands", () => ({
	generateReportForAgent: m.generate,
	listProjectReportsForAgent: vi.fn(),
	getReportContentForAgent: m.content,
	updateReportPromptForAgent: m.updatePrompt,
	listReportTemplatesForAgent: m.listTemplates,
	createProjectReportForAgent: m.createReport,
}));
vi.mock("../tools/frame-context", () => ({
	organizationSlug: async () => "example-org",
}));
vi.mock("@repo/api/modules/reports/lib/report-refusal", () => ({
	ReportGenerationError: m.ReportGenerationError,
}));
vi.mock("../project-binding", () => ({
	sessionMayReachProject: async () => true,
}));

import { createReportTools } from "../tools/report-tools";
import type { GatewayCredential, GatewaySession } from "../types";

function session(credential: GatewayCredential): GatewaySession {
	return {
		sessionId: "session-1",
		userId: "user-1",
		organizationId: "org-example-alpha",
		projectId: null,
		userName: "Dev",
		email: "dev@example.com",
		role: "user",
		credential,
		scopes: ["workflows:run"],
		createdAt: new Date("2026-10-04T12:00:00Z"),
		expiresAt: new Date("2026-10-05T12:00:00Z"),
	};
}

const tools = createReportTools(async () => ({
	organizationId: "org-example-alpha",
}));

async function generate(credential: GatewayCredential) {
	const handler = tools.handlers.get("fabric_generate_report");
	if (!handler) {
		throw new Error("tool not registered");
	}
	return handler({ instanceId: "report-1" }, session(credential));
}

beforeEach(() => {
	vi.clearAllMocks();
	m.generate.mockResolvedValue({
		executionId: "execution-1",
		workflowId: "workflow-1",
		status: "PENDING",
		startConfirmed: true,
		message: "started",
	});
});

describe("fabric_generate_report", () => {
	it.each([
		["session", true],
		["service", true],
		["organization-key", false],
		["personal-key", false],
		["oauth", false],
	] as const)(
		"starts a %s caller's run with planEligible %s",
		async (credential, planEligible) => {
			await generate(credential);

			expect(m.generate).toHaveBeenCalledWith(
				{
					userId: "user-1",
					organizationId: "org-example-alpha",
					planEligible,
				},
				{ instanceId: "report-1" },
				expect.any(Function),
			);
		},
	);

	it("tells the caller how to follow the run it started", async () => {
		const result = await generate("session");
		const text = result.content.map((part) => part.text).join("");

		expect(text).toContain("Poll fabric_list_project_reports");
	});
});

function call(
	name: string,
	args: Record<string, unknown>,
	from = session("service"),
) {
	const handler = tools.handlers.get(name);
	if (!handler) {
		throw new Error(`${name} is not registered`);
	}
	return handler(args, from);
}

function textOf(result: { content: Array<{ text?: string }> }): string {
	return result.content.map((part) => part.text).join("");
}

describe("fabric_list_report_templates", () => {
	it("lists templates in the project's organization", async () => {
		m.listTemplates.mockResolvedValue({ templates: [], total: 0 });

		await call("fabric_list_report_templates", {
			projectId: " project-1 ",
			search: "status",
		});

		expect(m.listTemplates).toHaveBeenCalledWith(
			{ userId: "user-1", organizationId: "org-example-alpha" },
			{ projectId: "project-1", search: "status" },
		);
	});

	it("needs a project", async () => {
		const result = await call("fabric_list_report_templates", {});

		expect(result.isError).toBe(true);
		expect(m.listTemplates).not.toHaveBeenCalled();
	});
});

describe("fabric_create_project_report", () => {
	const args = {
		projectId: "project-1",
		templateId: "template-1",
		name: "Team status",
		parameters: { team: "Example", weeks: 2, draft: false },
	};

	it("creates the report through the command and links its page", async () => {
		m.createReport.mockResolvedValue({
			instanceId: "report-new",
			canGenerate: true,
		});

		const result = await call("fabric_create_project_report", args);

		expect(m.createReport).toHaveBeenCalledWith(
			{ userId: "user-1", organizationId: "org-example-alpha" },
			args,
			expect.any(Function),
		);
		expect(JSON.parse(textOf(result))).toEqual({
			instanceId: "report-new",
			canGenerate: true,
			reportUrl: "/app/example-org/report-templates/instances/report-new",
		});
	});

	it("takes a prompt with no template, which the command starts from Custom report", async () => {
		m.createReport.mockResolvedValue({
			instanceId: "report-new",
			canGenerate: true,
		});

		await call("fabric_create_project_report", {
			projectId: "project-1",
			prompt: "  Cover this sprint's risks  ",
		});

		expect(m.createReport).toHaveBeenCalledWith(
			{ userId: "user-1", organizationId: "org-example-alpha" },
			{ projectId: "project-1", prompt: "Cover this sprint's risks" },
			expect.any(Function),
		);
	});

	it("refuses a prompt longer than instructions may be", async () => {
		const result = await call("fabric_create_project_report", {
			projectId: "project-1",
			prompt: "x".repeat(20_001),
		});

		expect(result.isError).toBe(true);
		expect(m.createReport).not.toHaveBeenCalled();
	});

	it("refuses parameter values that are not plain text, numbers or booleans", async () => {
		const result = await call("fabric_create_project_report", {
			...args,
			parameters: { team: { nested: true } },
		});

		expect(result.isError).toBe(true);
		expect(m.createReport).not.toHaveBeenCalled();
	});

	it("needs an organization", async () => {
		const result = await call("fabric_create_project_report", args, {
			...session("service"),
			organizationId: null,
		});

		expect(result.isError).toBe(true);
		expect(m.createReport).not.toHaveBeenCalled();
	});

	it("maps the command's refusal onto an error with its code", async () => {
		m.createReport.mockRejectedValue(
			new m.ReportGenerationError(
				"FORBIDDEN",
				"You need at least the Editor role on this project to add a report",
			),
		);

		const result = await call("fabric_create_project_report", args);

		expect(result.isError).toBe(true);
		expect(JSON.parse(textOf(result))).toEqual({
			error: "You need at least the Editor role on this project to add a report",
			code: "FORBIDDEN",
		});
	});
});

describe("fabric_get_report_content", () => {
	it("reads the report as the caller, in the session's organization", async () => {
		m.content.mockResolvedValue({
			instanceId: "report-1",
			latestRun: null,
		});

		const result = await call("fabric_get_report_content", {
			instanceId: " report-1 ",
		});

		expect(m.content).toHaveBeenCalledWith(
			{ userId: "user-1", organizationId: "org-example-alpha" },
			{ instanceId: "report-1" },
			expect.any(Function),
		);
		expect(JSON.parse(textOf(result))).toEqual({
			instanceId: "report-1",
			latestRun: null,
		});
	});

	it("maps the command's refusal onto an error with its code", async () => {
		m.content.mockRejectedValue(
			new m.ReportGenerationError(
				"NOT_FOUND",
				"Template instance not found",
			),
		);

		const result = await call("fabric_get_report_content", {
			instanceId: "report-1",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(textOf(result))).toEqual({
			error: "Template instance not found",
			code: "NOT_FOUND",
		});
	});

	it("needs an organization", async () => {
		const result = await call(
			"fabric_get_report_content",
			{ instanceId: "report-1" },
			{ ...session("service"), organizationId: null },
		);

		expect(result.isError).toBe(true);
		expect(m.content).not.toHaveBeenCalled();
	});
});

describe("fabric_update_report_prompt", () => {
	it("hands the trimmed instructions to the command", async () => {
		m.updatePrompt.mockResolvedValue({
			instanceId: "report-1",
			message: "Saved. Call fabric_generate_report next.",
		});

		const result = await call("fabric_update_report_prompt", {
			instanceId: "report-1",
			userPrompt: "  Two bullets for risks  ",
		});

		expect(m.updatePrompt).toHaveBeenCalledWith(
			{ userId: "user-1", organizationId: "org-example-alpha" },
			{ instanceId: "report-1", userPrompt: "Two bullets for risks" },
			expect.any(Function),
		);
		expect(textOf(result)).toContain("fabric_generate_report");
	});

	it.each([
		[{ instanceId: "report-1" }],
		[{ instanceId: "report-1", userPrompt: "   " }],
		[{ instanceId: "report-1", userPrompt: "x".repeat(20_001) }],
		[{ userPrompt: "Shorter" }],
	])("refuses invalid arguments %j before the command", async (args) => {
		const result = await call("fabric_update_report_prompt", args);

		expect(result.isError).toBe(true);
		expect(JSON.parse(textOf(result))).toMatchObject({
			code: "INVALID_INPUT",
		});
		expect(m.updatePrompt).not.toHaveBeenCalled();
	});

	it("lets the create command reach a project only in the session's organization", async () => {
		const authorize = vi.fn(async (projectId: string) => ({
			organizationId:
				projectId === "project-1"
					? "org-example-alpha"
					: "org-example-beta",
		}));
		const handler = createReportTools(authorize).handlers.get(
			"fabric_create_project_report",
		);
		m.createReport.mockResolvedValue({ instanceId: "report-new" });

		await handler?.(
			{ projectId: "project-1", templateId: "template-1" },
			session("service"),
		);
		const reach = m.createReport.mock.calls[0][2];

		expect(await reach("project-1")).toBe(true);
		expect(await reach("project-2")).toBe(false);
	});

	it("lets the command reach a project report only in the session's organization", async () => {
		const authorize = vi.fn(async (projectId: string) => ({
			organizationId:
				projectId === "project-1"
					? "org-example-alpha"
					: "org-example-beta",
		}));
		const handler = createReportTools(authorize).handlers.get(
			"fabric_update_report_prompt",
		);
		m.updatePrompt.mockResolvedValue({ instanceId: "report-1" });

		await handler?.(
			{ instanceId: "report-1", userPrompt: "Shorter" },
			session("service"),
		);
		const reach = m.updatePrompt.mock.calls[0][2];

		expect(await reach("project-1")).toBe(true);
		expect(await reach("project-2")).toBe(false);
		expect(await reach(null)).toBe(true);
		expect(authorize).toHaveBeenCalledWith("project-1", expect.anything());
	});
});
