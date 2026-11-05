import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	getLatestProjectTemplateRun: vi.fn(),
	getReportTemplate: vi.fn(),
	getReportTemplateSample: vi.fn(),
	saveReportTemplateSample: vi.fn(),
	getBoundPromptForAgent: vi.fn(),
	isFeatureEnabled: vi.fn(),
	enforceAiRateLimit: vi.fn(),
	assertProjectPermission: vi.fn(),
	requireOrganizationMembership: vi.fn(),
	canCreateProjectReport: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	generateText: vi.fn(),
	logModelUsageAsync: vi.fn(),
	renderTemplate: vi.fn(),
	trackUsage: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getLatestProjectTemplateRun: mocks.getLatestProjectTemplateRun,
	getReportTemplate: mocks.getReportTemplate,
	getReportTemplateSample: mocks.getReportTemplateSample,
	saveReportTemplateSample: mocks.saveReportTemplateSample,
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
	isFeatureEnabled: mocks.isFeatureEnabled,
}));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class extends Error {},
	generateText: mocks.generateText,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: mocks.logModelUsageAsync,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/utils", () => ({ renderTemplate: mocks.renderTemplate }));

vi.mock("../../../../../lib/chatgpt-plan-errors", () => ({
	rethrowChatGptPlanRefusal: vi.fn(),
}));

vi.mock("../../../lib/report-access", () => ({
	canCreateProjectReport: mocks.canCreateProjectReport,
}));

// Chainable oRPC procedure stub — captures each handler in module import order.
vi.mock("../../../../../orpc/procedures", () => {
	let callCount = 0;
	const names = ["preview", "sample"];
	function makeChainable() {
		const name = names[callCount++];
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			use: () => c,
			input: () => c,
			handler: (fn: (...args: unknown[]) => unknown) => {
				mocks.handlers[name] = fn;
				return { _handler: fn };
			},
		});
		return c;
	}
	return {
		get tenantProtectedProcedure() {
			return makeChainable();
		},
		Permissions: {
			REPORT_READ: "REPORT_READ",
			REPORT_CREATE: "REPORT_CREATE",
		},
		assertProjectPermission: mocks.assertProjectPermission,
		enforceAiRateLimit: mocks.enforceAiRateLimit,
		requireOrganizationMembership: mocks.requireOrganizationMembership,
		requirePermission: () => (c: unknown) => c,
		requireInputOrgPermission: () => (c: unknown) => c,
		resolveOrganizationId: (input: string | null | undefined) =>
			input ?? "example-org",
	};
});

import { REPORT_SAMPLE_PROMPT_AGENT_KEY } from "@repo/utils/report-sample-prompt";
import "../preview";
import { reportSampleContentHash, reportSampleVariables } from "../sample";

const ctx = {
	user: { id: "example-member", role: "user" },
	session: { activeOrganizationId: "example-org" },
};
const input = {
	templateId: "example-template",
	projectId: "example-project",
	organizationId: "example-org",
};
const template = {
	id: "example-template",
	name: "Weekly status",
	description: "What moved this week",
	category: "status",
	outputFormat: "MARKDOWN",
	definition: {
		userPrompt: "Summarize the sprint.",
		sections: [{ title: "Highlights" }, { title: "Risks" }, {}],
		dataSources: [
			{ id: "board", provider: "fizzy" },
			{ id: "board-2", provider: "fizzy" },
		],
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.assertProjectPermission.mockResolvedValue({
		projectId: "example-project",
		organizationId: "example-org",
	});
	mocks.requireOrganizationMembership.mockResolvedValue(undefined);
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.enforceAiRateLimit.mockResolvedValue(undefined);
	mocks.canCreateProjectReport.mockResolvedValue(true);
	mocks.getReportTemplate.mockResolvedValue(template);
	mocks.getBoundPromptForAgent.mockResolvedValue(null);
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: "example-model",
		metadata: {},
		trackUsage: mocks.trackUsage,
	});
	mocks.renderTemplate.mockImplementation(async ({ template: body }) => ({
		rendered: body,
	}));
	mocks.generateText.mockResolvedValue({
		text: "  # Weekly status\nExample  ",
		usage: {},
	});
	mocks.getReportTemplateSample.mockResolvedValue(null);
	mocks.saveReportTemplateSample.mockImplementation(
		async ({ content }: { content: string }) => ({
			content,
			generatedAt: new Date("2026-11-05T09:00:00.000Z"),
		}),
	);
});

describe("reports.templates.preview", () => {
	it("authorizes the project and returns the newest successful report", async () => {
		mocks.getLatestProjectTemplateRun.mockResolvedValue({
			id: "example-execution",
			completedAt: new Date("2026-01-02T03:04:05.000Z"),
			instance: { id: "example-instance", name: "Team status" },
			artifacts: [
				{
					id: "example-artifact",
					name: "report.md",
					content: "# Done",
				},
			],
		});

		const result = await mocks.handlers.preview({ input, context: ctx });

		expect(mocks.assertProjectPermission).toHaveBeenCalledWith(
			"example-project",
			"example-member",
			"REPORT_READ",
		);
		expect(mocks.getLatestProjectTemplateRun).toHaveBeenCalledWith({
			templateId: "example-template",
			projectId: "example-project",
			userId: "example-member",
			organizationId: "example-org",
		});
		expect(result).toEqual({
			run: {
				executionId: "example-execution",
				instanceId: "example-instance",
				instanceName: "Team status",
				completedAt: "2026-01-02T03:04:05.000Z",
				artifact: {
					id: "example-artifact",
					name: "report.md",
					content: "# Done",
				},
			},
		});
	});

	it("returns no run when the template has no successful report here", async () => {
		mocks.getLatestProjectTemplateRun.mockResolvedValue(null);
		const result = await mocks.handlers.preview({ input, context: ctx });
		expect(result).toEqual({ run: null });
	});

	it("refuses a caller who may not read the project", async () => {
		mocks.assertProjectPermission.mockRejectedValue(new Error("FORBIDDEN"));
		await expect(
			mocks.handlers.preview({ input, context: ctx }),
		).rejects.toThrow("FORBIDDEN");
		expect(mocks.getLatestProjectTemplateRun).not.toHaveBeenCalled();
	});
});

describe("reports.templates.sample", () => {
	it("writes the sample from the bound prompt and stores it under the prompt's hash", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue({
			format: "HANDLEBARS",
			version: { content: "Org prompt for {{template_name}}" },
		});

		const result = await mocks.handlers.sample({ input, context: ctx });

		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: REPORT_SAMPLE_PROMPT_AGENT_KEY,
				documentType: "GENERAL",
				organizationId: "example-org",
				// So the project's binding in the Prompt Library wins over the
				// organization's.
				projectId: "example-project",
			}),
		);
		expect(mocks.renderTemplate).toHaveBeenCalledWith(
			expect.objectContaining({
				template: "Org prompt for {{template_name}}",
				escape: false,
			}),
		);
		expect(mocks.generateText).toHaveBeenCalledWith(
			expect.objectContaining({ maxOutputTokens: expect.any(Number) }),
		);
		expect(mocks.trackUsage).toHaveBeenCalled();
		expect(mocks.enforceAiRateLimit).toHaveBeenCalledWith(
			"example-member",
			undefined,
		);
		const contentHash = reportSampleContentHash(
			"Org prompt for {{template_name}}",
		);
		expect(mocks.getReportTemplateSample).toHaveBeenCalledWith({
			templateId: "example-template",
			contentHash,
		});
		expect(mocks.saveReportTemplateSample).toHaveBeenCalledWith({
			templateId: "example-template",
			contentHash,
			content: "# Weekly status\nExample",
		});
		expect(result).toEqual({
			content: "# Weekly status\nExample",
			generatedAt: "2026-11-05T09:00:00.000Z",
			reused: false,
		});
	});

	it("returns a stored sample to a reader, with no AI call or rate limit", async () => {
		mocks.canCreateProjectReport.mockResolvedValue(false);
		mocks.getReportTemplateSample.mockResolvedValue({
			content: "# Stored sample",
			generatedAt: new Date("2026-11-01T08:00:00.000Z"),
		});

		const result = await mocks.handlers.sample({ input, context: ctx });

		expect(result).toEqual({
			content: "# Stored sample",
			generatedAt: "2026-11-01T08:00:00.000Z",
			reused: true,
		});
		expect(mocks.assertProjectPermission).toHaveBeenCalledWith(
			"example-project",
			"example-member",
			"REPORT_READ",
		);
		expect(mocks.enforceAiRateLimit).not.toHaveBeenCalled();
		expect(mocks.getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(mocks.saveReportTemplateSample).not.toHaveBeenCalled();
	});

	it("reads a stored sample from the template alone, without a project", async () => {
		mocks.getReportTemplateSample.mockResolvedValue({
			content: "# Stored sample",
			generatedAt: new Date("2026-11-01T08:00:00.000Z"),
		});
		const { projectId: _projectId, ...withoutProject } = input;

		await expect(
			mocks.handlers.sample({ input: withoutProject, context: ctx }),
		).resolves.toMatchObject({ reused: true });
		expect(mocks.assertProjectPermission).not.toHaveBeenCalled();
	});

	it("refuses someone who is no member of the organization, on the stored path too, before reading the template", async () => {
		mocks.requireOrganizationMembership.mockRejectedValue(
			Object.assign(new Error("Not a member"), { code: "FORBIDDEN" }),
		);
		mocks.getReportTemplateSample.mockResolvedValue({
			content: "# Stored sample",
			generatedAt: new Date("2026-11-01T08:00:00.000Z"),
		});

		await expect(
			mocks.handlers.sample({ input, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.requireOrganizationMembership).toHaveBeenCalledWith(
			"example-org",
			"example-member",
		);
		expect(mocks.getReportTemplate).not.toHaveBeenCalled();
		expect(mocks.getReportTemplateSample).not.toHaveBeenCalled();
		expect(mocks.generateText).not.toHaveBeenCalled();
	});

	it("shows a sample without a project and stores nothing, since storing needs a project", async () => {
		const { projectId: _projectId, ...withoutProject } = input;

		await expect(
			mocks.handlers.sample({ input: withoutProject, context: ctx }),
		).resolves.toEqual({
			content: "# Weekly status\nExample",
			generatedAt: expect.any(String),
			reused: false,
		});
		expect(mocks.enforceAiRateLimit).toHaveBeenCalledTimes(1);
		expect(mocks.canCreateProjectReport).not.toHaveBeenCalled();
		expect(mocks.saveReportTemplateSample).not.toHaveBeenCalled();
	});

	it("looks up a different sample once the template's instructions change", async () => {
		mocks.renderTemplate.mockImplementation(
			async ({ variables }: { variables: Record<string, string> }) => ({
				rendered: `Prompt: ${variables.report_instructions}`,
			}),
		);
		await mocks.handlers.sample({ input, context: ctx });
		mocks.getReportTemplate.mockResolvedValue({
			...template,
			definition: { ...template.definition, userPrompt: "Changed." },
		});
		await mocks.handlers.sample({ input, context: ctx });

		const [first, second] = mocks.getReportTemplateSample.mock.calls.map(
			(call) => (call[0] as { contentHash: string }).contentHash,
		);
		expect(first).not.toBe(second);
	});

	it("shows someone who may not add reports a sample under the AI rate limit, and stores nothing", async () => {
		mocks.canCreateProjectReport.mockResolvedValue(false);

		await expect(
			mocks.handlers.sample({ input, context: ctx }),
		).resolves.toEqual({
			content: "# Weekly status\nExample",
			generatedAt: expect.any(String),
			reused: false,
		});
		expect(mocks.enforceAiRateLimit).toHaveBeenCalledTimes(1);
		expect(
			mocks.enforceAiRateLimit.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.generateText.mock.invocationCallOrder[0]);
		expect(mocks.generateText).toHaveBeenCalledWith(
			expect.objectContaining({ maxOutputTokens: expect.any(Number) }),
		);
		expect(mocks.saveReportTemplateSample).not.toHaveBeenCalled();
	});

	it("stops someone who may not add reports at the AI rate limit, before any AI call", async () => {
		mocks.canCreateProjectReport.mockResolvedValue(false);
		mocks.enforceAiRateLimit.mockRejectedValue(
			new Error("TOO_MANY_REQUESTS"),
		);

		await expect(
			mocks.handlers.sample({ input, context: ctx }),
		).rejects.toThrow("TOO_MANY_REQUESTS");
		expect(mocks.getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(mocks.generateText).not.toHaveBeenCalled();
	});

	it("refuses while the report suite is off for the organization", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);
		await expect(
			mocks.handlers.sample({ input, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"REPORT_SUITE_V2",
			"example-org",
		);
		expect(mocks.generateText).not.toHaveBeenCalled();
	});

	it("stops at the AI rate limit before any AI call", async () => {
		mocks.enforceAiRateLimit.mockRejectedValue(
			new Error("TOO_MANY_REQUESTS"),
		);
		await expect(
			mocks.handlers.sample({ input, context: ctx }),
		).rejects.toThrow("TOO_MANY_REQUESTS");
		expect(mocks.getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("refuses a template the caller cannot see", async () => {
		mocks.getReportTemplate.mockResolvedValue(null);
		await expect(
			mocks.handlers.sample({ input, context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.generateText).not.toHaveBeenCalled();
	});
});

describe("reportSampleVariables", () => {
	it("reads the template's sections, providers and instructions", () => {
		expect(reportSampleVariables(template)).toEqual({
			template_name: "Weekly status",
			template_description: "What moved this week",
			template_category: "status",
			output_format: "MARKDOWN",
			report_instructions: "Summarize the sprint.",
			section_titles: "Highlights, Risks",
			data_sources: "fizzy",
		});
	});

	it("tolerates a definition that is not an object", () => {
		expect(
			reportSampleVariables({ ...template, definition: null }),
		).toMatchObject({
			report_instructions: "",
			section_titles: "",
			data_sources: "",
		});
	});
});
