import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	template: vi.fn(),
	defaults: vi.fn(),
	create: vi.fn(),
	project: vi.fn(),
	validate: vi.fn(),
	flag: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	...(await import(
		"../../../../../database/prisma/queries/lib/report-evidence"
	)),
	...(await import(
		"../../../../../database/prisma/queries/lib/report-schedule"
	)),
	getReportTemplate: m.template,
	resolveReportTemplateDefaults: m.defaults,
	createTemplateInstance: m.create,
	isFeatureEnabled: m.flag,
	db: { project: { findUnique: m.project } },
}));
vi.mock("../validate-connections", () => ({
	validateReportConnections: m.validate,
}));
vi.mock("../resolve-instance-schedule", () => ({
	templateScheduleForInheritance: () => undefined,
}));

import {
	createReportFromTemplate,
	reportInstanceConnectionsSchema,
} from "../report-creation";

const template = {
	id: "template-1",
	name: "Status",
	scope: "SYSTEM",
	userId: null,
	organizationId: null,
	archivedAt: null,
	definition: { dataSources: [] },
	parameters: {
		properties: {
			team: { default: "Template team" },
			region: { default: "Template region" },
			weeks: { default: 2 },
			since: { default: "{{WEEK_START}}" },
			projectName: { default: "Project" },
			extra: {},
		},
	},
};

function create(
	overrides: Partial<
		Parameters<typeof createReportFromTemplate>[0]["creation"]
	> = {},
) {
	return createReportFromTemplate({
		caller: { id: "example-owner" },
		organizationId: "example-org",
		creation: {
			templateId: "template-1",
			name: "Status",
			projectId: "project-1",
			connections: reportInstanceConnectionsSchema.parse({}),
			...overrides,
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	m.flag.mockResolvedValue(true);
	m.template.mockResolvedValue(template);
	m.defaults.mockResolvedValue({
		parameterDefaults: { team: "Org team" },
		context: {},
		schedule: undefined,
	});
	m.project.mockResolvedValue({ name: "Example project" });
	m.validate.mockResolvedValue({ valid: true, errors: [] });
	m.create.mockResolvedValue({ id: "report-new" });
});

describe("createReportFromTemplate", () => {
	it("starts from the template's values, under the project's, the defaults' and the caller's", async () => {
		await create({ parameterDefaults: { region: "Chosen region" } });

		expect(m.create.mock.calls[0][0].parameterDefaults).toEqual({
			team: "Org team",
			region: "Chosen region",
			weeks: 2,
			projectName: "Example project",
		});
	});

	it("starts from neither the template's values nor stored defaults where the report suite is off", async () => {
		m.flag.mockResolvedValue(false);
		m.defaults.mockResolvedValue({
			parameterDefaults: { team: "Org team" },
			context: { boardName: "Stored board" },
			schedule: { frequency: "weekly" },
			prompts: {
				userPrompt: "Stored instructions",
				aiTasks: { summary: "Stored task" },
			},
			projectPrompts: { userPrompt: "Stored project instructions" },
		});

		await create();

		expect(m.flag).toHaveBeenCalledWith("REPORT_SUITE_V2", "example-org");
		expect(m.defaults).not.toHaveBeenCalled();
		const created = m.create.mock.calls[0][0];
		expect(created.parameterDefaults).toEqual({
			projectName: "Example project",
		});
		expect(created.connections.context).toBeUndefined();
		expect(created.connections.promptOverride).toBeUndefined();
		expect(created.fabricConfig).toBeUndefined();
		expect(created.schedule).toBeUndefined();
	});

	describe("what the project answers", () => {
		const withRepository = {
			...template,
			parameters: {
				properties: {
					...template.parameters.properties,
					repositoryOwner: {},
					repositoryName: {},
				},
			},
		};
		const repositoryValues = () => {
			const values = m.create.mock.calls[0][0].parameterDefaults;
			return [values.repositoryOwner, values.repositoryName];
		};

		beforeEach(() => {
			m.template.mockResolvedValue(withRepository);
			m.project.mockResolvedValue({
				name: "Example project",
				repositoryIntegrations: [
					{
						repositoryOwner: "example-org",
						repositoryName: "example-repo",
					},
				],
			});
		});

		it("fills the repository where the report suite is on", async () => {
			await create();

			expect(repositoryValues()).toEqual(["example-org", "example-repo"]);
		});

		it("leaves the repository out where the report suite is off, and still fills the project's name", async () => {
			m.flag.mockResolvedValue(false);

			await create();

			expect(repositoryValues()).toEqual([undefined, undefined]);
			expect(
				m.create.mock.calls[0][0].parameterDefaults.projectName,
			).toBe("Example project");
		});
	});

	describe("default prompts", () => {
		it("copies a default system prompt onto the report", async () => {
			m.defaults.mockResolvedValue({
				parameterDefaults: {},
				context: {},
				schedule: undefined,
				prompts: { systemPrompt: "Answer in short sentences" },
			});

			await create();

			expect(
				m.create.mock.calls[0][0].fabricConfig.customSystemPrompt,
			).toBe("Answer in short sentences");
		});

		const stored = {
			parameterDefaults: {},
			context: {},
			schedule: undefined,
			prompts: {
				userPrompt: "Project instructions",
				aiTasks: {
					summary: "Organization task",
					risks: "Project task",
				},
			},
			projectPrompts: {
				userPrompt: "Project instructions",
				aiTasks: { risks: "Project task" },
			},
		};

		it("copies the effective prompts onto the report where the report suite is on", async () => {
			m.defaults.mockResolvedValue(stored);

			await create();

			const created = m.create.mock.calls[0][0];
			expect(created.connections).toMatchObject({
				promptOverride: "Project instructions",
				promptOverrideSource: "user",
			});
			expect(created.fabricConfig.customAiTasks).toEqual(
				stored.prompts.aiTasks,
			);
		});

		it("takes only the project's prompts for the organization's own template", async () => {
			m.defaults.mockResolvedValue(stored);
			m.template.mockResolvedValue({
				...template,
				scope: "ORGANIZATION",
				organizationId: "example-org",
			});

			await create();

			expect(
				m.create.mock.calls[0][0].fabricConfig.customAiTasks,
			).toEqual({ risks: "Project task" });
		});

		it("lets instructions the creator wrote win", async () => {
			m.defaults.mockResolvedValue(stored);

			await create({
				connections: reportInstanceConnectionsSchema.parse({
					promptOverride: "My own instructions",
					promptOverrideSource: "user",
				}),
			});

			expect(m.create.mock.calls[0][0].connections.promptOverride).toBe(
				"My own instructions",
			);
		});
	});

	it("does not copy a placeholder default, which a run does not resolve", async () => {
		await create();

		expect(m.create.mock.calls[0][0].parameterDefaults).not.toHaveProperty(
			"since",
		);
	});

	it("refuses a template the caller may not see", async () => {
		m.template.mockResolvedValue(null);

		await expect(create()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.create).not.toHaveBeenCalled();
	});

	it("refuses an archived template", async () => {
		m.template.mockResolvedValue({
			...template,
			archivedAt: new Date("2026-11-04T00:00:00.000Z"),
		});

		await expect(create()).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.create).not.toHaveBeenCalled();
	});

	it("refuses connections the caller may not use", async () => {
		m.validate.mockResolvedValue({
			valid: false,
			errors: ["example-config is not yours"],
		});

		await expect(create()).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("example-config"),
		});
		expect(m.create).not.toHaveBeenCalled();
	});
});
