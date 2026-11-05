import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	template: vi.fn(),
	access: vi.fn(),
	defaults: vi.fn(),
	overrides: vi.fn(),
	bindings: vi.fn(),
	missing: vi.fn(),
	starting: vi.fn(),
	create: vi.fn(),
	suggest: vi.fn(),
	blocked: vi.fn(),
	load: vi.fn(),
	start: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	...(await import(
		"../../../../../database/prisma/queries/lib/report-evidence"
	)),
	...(await import(
		"../../../../../database/prisma/queries/lib/report-template-defaults"
	)),
	getReportTemplate: m.template,
	canAccessReportInstance: m.access,
	getReportTemplateOverrides: m.overrides,
}));
vi.mock("../report-project-connection", () => ({
	resolveProjectReportBindings: m.bindings,
	missingReportSetup: m.missing,
}));
vi.mock("../report-creation", async () => {
	const { z } = await import("zod");
	return {
		reportInstanceConnectionsSchema: z
			.object({
				mcpConfigs: z.array(z.string()).default([]),
				context: z.record(z.string(), z.string()).default({}),
			})
			.passthrough(),
		startingReportParameters: m.starting,
		createReportFromTemplate: m.create,
	};
});
vi.mock("../report-generation", () => ({
	loadGeneratableReport: m.load,
	startReportGeneration: m.start,
}));
vi.mock("../report-generation-readiness", () => ({
	reportGenerationBlockedReason: m.blocked,
}));
vi.mock("../report-parameter-suggestions", () => ({
	suggestReportParameters: m.suggest,
}));

import { generateReportFromTemplate } from "../report-one-click";
import { ReportGenerationError } from "../report-refusal";

const request = {
	caller: { id: "example-user" },
	organizationId: "example-org",
	projectId: "example-project",
	templateId: "example-template",
	enforceRateLimit: vi.fn(async () => {}),
	enforceRunRateLimit: vi.fn(async () => {}),
};
const noOverride = { parameterDefaults: {}, context: {}, schedule: null };

beforeEach(() => {
	vi.clearAllMocks();
	m.template.mockResolvedValue({
		id: "example-template",
		name: "Example status",
		description: null,
		archivedAt: null,
		parameters: {},
		definition: {
			dataSources: [{ id: "pm", type: "mcp", provider: "fizzy" }],
		},
	});
	m.access.mockResolvedValue(true);
	m.overrides.mockResolvedValue({ organization: null, project: null });
	m.bindings.mockResolvedValue({
		connections: { mcpConfigs: ["config-mine"], context: {} },
		toolBySource: { pm: "fizzy" },
	});
	m.missing.mockReturnValue([]);
	m.starting.mockResolvedValue({ projectName: "Example Project" });
	m.suggest.mockResolvedValue({ audience: "Delivery team" });
	m.blocked.mockReturnValue(null);
	m.create.mockResolvedValue({ id: "report-1" });
	m.load.mockResolvedValue({ id: "report-1" });
	m.start.mockResolvedValue({ executionId: "run-1", startConfirmed: true });
});

describe("generateReportFromTemplate", () => {
	it("creates the report and starts its run when nothing is missing", async () => {
		await expect(generateReportFromTemplate(request)).resolves.toEqual({
			outcome: "started",
			instanceId: "report-1",
			executionId: "run-1",
			startConfirmed: true,
		});

		const { creation } = m.create.mock.calls[0][0];
		expect(creation).toMatchObject({
			templateId: "example-template",
			name: "My Example status",
			projectId: "example-project",
			parameterDefaults: { audience: "Delivery team" },
		});
		expect(creation.connections.mcpConfigs).toEqual(["config-mine"]);
		expect(m.start).toHaveBeenCalledWith(
			expect.objectContaining({ planEligible: true }),
		);
	});

	it("writes nothing and asks AI nothing when a source is missing", async () => {
		m.bindings.mockResolvedValue(null);
		m.missing.mockReturnValue(["Connect Project management"]);

		await expect(generateReportFromTemplate(request)).resolves.toEqual({
			outcome: "needs-setup",
			missing: ["Connect Project management"],
		});
		expect(m.suggest).not.toHaveBeenCalled();
		expect(m.create).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});

	it("takes the run rate limit before anything is written", async () => {
		await generateReportFromTemplate(request);

		expect(request.enforceRunRateLimit).toHaveBeenCalledTimes(1);
		expect(
			request.enforceRunRateLimit.mock.invocationCallOrder[0],
		).toBeLessThan(m.create.mock.invocationCallOrder[0]);
	});

	it("writes nothing and starts nothing when the run rate limit refuses", async () => {
		request.enforceRunRateLimit.mockRejectedValueOnce(
			new Error("Example rate limit"),
		);

		await expect(generateReportFromTemplate(request)).rejects.toThrow(
			"Example rate limit",
		);
		expect(m.create).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});

	it("spends no run on a report the person has to finish", async () => {
		m.bindings.mockResolvedValue(null);
		m.missing.mockReturnValue(["Connect Project management"]);

		await generateReportFromTemplate(request);

		expect(request.enforceRunRateLimit).not.toHaveBeenCalled();
	});

	it.each([
		[
			"the project's",
			{
				organization: null,
				project: {
					...noOverride,
					prompts: { userPrompt: "Example instructions" },
					updatedById: "example-teammate",
				},
			},
		],
		[
			"the organization's",
			{
				organization: {
					...noOverride,
					prompts: { userPrompt: "Example instructions" },
					updatedById: "example-teammate",
				},
				project: null,
			},
		],
		[
			"a removed writer's",
			{
				organization: null,
				project: {
					...noOverride,
					prompts: { systemPrompt: "Example system prompt" },
					updatedById: null,
				},
			},
		],
	])(
		"sends the caller to read %s default prompts, written by someone else, before anything runs",
		async (_label, stored) => {
			m.overrides.mockResolvedValue(stored);

			await expect(generateReportFromTemplate(request)).resolves.toEqual({
				outcome: "needs-setup",
				missing: [expect.stringContaining("default prompts")],
			});
			expect(m.suggest).not.toHaveBeenCalled();
			expect(request.enforceRunRateLimit).not.toHaveBeenCalled();
			expect(m.create).not.toHaveBeenCalled();
			expect(m.start).not.toHaveBeenCalled();
		},
	);

	it("keeps one click for default prompts the caller wrote", async () => {
		m.overrides.mockResolvedValue({
			organization: null,
			project: {
				...noOverride,
				prompts: { userPrompt: "Example instructions" },
				updatedById: request.caller.id,
			},
		});

		await expect(
			generateReportFromTemplate(request),
		).resolves.toMatchObject({ outcome: "started" });
	});

	it("keeps one click for a default someone else set that holds no prompts", async () => {
		m.overrides.mockResolvedValue({
			organization: null,
			project: {
				...noOverride,
				parameterDefaults: { audience: "Example audience" },
				updatedById: "example-teammate",
			},
		});

		await expect(
			generateReportFromTemplate(request),
		).resolves.toMatchObject({ outcome: "started" });
	});

	it("ignores an organization's prompts on its own template, which never apply there", async () => {
		m.template.mockResolvedValue({
			id: "example-template",
			name: "Example status",
			description: null,
			archivedAt: null,
			scope: "ORGANIZATION",
			organizationId: "example-org",
			parameters: {},
			definition: {
				dataSources: [{ id: "pm", type: "mcp", provider: "fizzy" }],
			},
		});
		m.overrides.mockResolvedValue({
			organization: {
				...noOverride,
				prompts: { userPrompt: "Example instructions" },
				updatedById: "example-teammate",
			},
			project: null,
		});

		await expect(
			generateReportFromTemplate(request),
		).resolves.toMatchObject({ outcome: "started" });
	});

	it("goes to the dialog when a required value stays empty after AI", async () => {
		m.suggest.mockResolvedValue({});
		m.blocked.mockReturnValue("Fill Audience to generate this report.");

		await expect(generateReportFromTemplate(request)).resolves.toEqual({
			outcome: "needs-setup",
			missing: ["Fill Audience to generate this report."],
		});
		expect(m.blocked).toHaveBeenCalledWith(
			expect.objectContaining({
				parameterDefaults: { projectName: "Example Project" },
			}),
		);
		expect(m.create).not.toHaveBeenCalled();
	});

	it("saves only AI's values as the new report's own, below what the project answered", async () => {
		await generateReportFromTemplate(request);

		expect(m.suggest).toHaveBeenCalledWith(
			expect.objectContaining({
				filled: { projectName: "Example Project" },
			}),
		);
		expect(m.create.mock.calls[0][0].creation.parameterDefaults).toEqual({
			audience: "Delivery team",
		});
	});

	it("routes a refused run to the report with the reason", async () => {
		m.start.mockRejectedValue(
			new ReportGenerationError(
				"BAD_REQUEST",
				"Example server could not be reached.",
			),
		);

		await expect(generateReportFromTemplate(request)).resolves.toEqual({
			outcome: "refused",
			instanceId: "report-1",
			reason: "Example server could not be reached.",
		});
	});

	it("routes a report that cannot load for generation the same way", async () => {
		m.load.mockRejectedValue(
			new ReportGenerationError("BAD_REQUEST", "Example refusal."),
		);

		await expect(
			generateReportFromTemplate(request),
		).resolves.toMatchObject({
			outcome: "refused",
			instanceId: "report-1",
		});
		expect(m.start).not.toHaveBeenCalled();
	});

	it("sends connections that fail validation to the dialog", async () => {
		m.create.mockRejectedValue(
			new ReportGenerationError("BAD_REQUEST", "Example invalid board."),
		);

		await expect(generateReportFromTemplate(request)).resolves.toEqual({
			outcome: "needs-setup",
			missing: ["Example invalid board."],
		});
	});

	it("lets an unexpected failure of the run surface as an error", async () => {
		m.start.mockRejectedValue(new Error("Example outage"));

		await expect(generateReportFromTemplate(request)).rejects.toThrow(
			"Example outage",
		);
	});

	it("refuses a template the caller cannot read", async () => {
		m.template.mockResolvedValue(null);

		await expect(generateReportFromTemplate(request)).rejects.toMatchObject(
			{
				code: "NOT_FOUND",
			},
		);
		expect(m.create).not.toHaveBeenCalled();
	});

	it("refuses an archived template", async () => {
		m.template.mockResolvedValue({
			name: "Example status",
			archivedAt: new Date(0),
			definition: {},
		});

		await expect(generateReportFromTemplate(request)).rejects.toMatchObject(
			{
				code: "BAD_REQUEST",
			},
		);
		expect(m.create).not.toHaveBeenCalled();
	});
});
