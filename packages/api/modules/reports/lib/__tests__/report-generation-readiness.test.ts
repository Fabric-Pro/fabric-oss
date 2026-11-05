import { STANDARD_REPORT_TEMPLATES } from "@repo/database/prisma/seed-report-standard-templates";
import { describe, expect, it } from "vitest";
import { reportGenerationBlockedReason } from "../report-generation-readiness";

const fizzyTemplate = {
	definition: {
		dataSources: [{ id: "ds-board", type: "mcp", provider: "fizzy" }],
	},
	connections: {
		mcpServers: [{ key: "fizzy", name: "Fizzy", required: true }],
	},
	parameters: {
		required: ["sprintName"],
		properties: { sprintName: { type: "string" } },
	},
};

function report(
	overrides: Partial<
		Parameters<typeof reportGenerationBlockedReason>[0]
	> = {},
) {
	return {
		isActive: true,
		connections: { mcpConfigs: ["example-config"], mcpBindings: {} },
		parameterDefaults: { sprintName: "Sprint 1" },
		fabricConfig: null,
		template: fizzyTemplate,
		...overrides,
	};
}

describe("reportGenerationBlockedReason", () => {
	it("is ready when every required source is bound and every required parameter is set", () => {
		expect(
			reportGenerationBlockedReason(
				report({
					connections: { mcpBindings: { fizzy: "example-config" } },
				}),
			),
		).toBeNull();
	});

	it("counts a source bound by its data source id as bound to its provider", () => {
		expect(
			reportGenerationBlockedReason(
				report({
					connections: {
						mcpBindings: { "ds-board": "example-config" },
					},
				}),
			),
		).toBeNull();
	});

	it("names a required source that is not connected", () => {
		expect(reportGenerationBlockedReason(report())).toBe(
			"Connect Fizzy to generate this report.",
		);
	});

	it("does not wait for an optional source", () => {
		expect(
			reportGenerationBlockedReason(
				report({
					template: {
						...fizzyTemplate,
						connections: {
							mcpServers: [
								{
									key: "fizzy",
									name: "Fizzy",
									required: false,
								},
							],
						},
					},
				}),
			),
		).toBeNull();
	});

	describe("a source that asks for a data type", () => {
		const genericTemplate = {
			definition: {
				dataSources: [
					{
						id: "project-management",
						type: "mcp",
						dataType: "project-management",
						required: true,
					},
					{
						id: "repository",
						type: "mcp",
						dataType: "repository",
						required: false,
					},
				],
			},
			connections: {
				mcpServers: [
					{
						key: "project-management",
						name: "Project management tool",
						required: true,
						dataType: "project-management",
					},
					{
						key: "repository",
						name: "Repository",
						required: false,
						dataType: "repository",
					},
				],
			},
			parameters: { required: [], properties: {} },
		};

		it("is ready when the required source is bound by its id, whatever tool it is", () => {
			expect(
				reportGenerationBlockedReason(
					report({
						template: genericTemplate,
						connections: {
							mcpBindings: {
								"project-management": "example-config",
							},
						},
					}),
				),
			).toBeNull();
		});

		it("asks for a tool of the type when the required source is unbound", () => {
			expect(
				reportGenerationBlockedReason(
					report({
						template: genericTemplate,
						connections: {
							mcpBindings: { repository: "example-config" },
						},
					}),
				),
			).toBe("Connect Project management tool to generate this report.");
		});

		it("does not take a binding of the optional source for the required one", () => {
			expect(
				reportGenerationBlockedReason(
					report({
						template: genericTemplate,
						connections: { mcpBindings: {} },
					}),
				),
			).toBe("Connect Project management tool to generate this report.");
		});

		it("reads a required source the template's connections do not list", () => {
			expect(
				reportGenerationBlockedReason(
					report({
						template: { ...genericTemplate, connections: {} },
						connections: { mcpBindings: {} },
					}),
				),
			).toBe("Connect Project management tool to generate this report.");
		});

		it("does not wait for a template whose sources are all optional", () => {
			expect(
				reportGenerationBlockedReason(
					report({
						template: {
							...genericTemplate,
							definition: {
								dataSources: [
									{
										id: "project-management",
										type: "mcp",
										dataType: "project-management",
										required: false,
									},
								],
							},
							connections: {
								mcpServers: [
									{
										key: "project-management",
										name: "Project management tool",
										required: false,
									},
								],
							},
						},
						connections: {},
					}),
				),
			).toBeNull();
		});
	});

	describe("the seeded business reviews", () => {
		const seeded = (key: string) => {
			const template = STANDARD_REPORT_TEMPLATES.find(
				(entry) => entry.key === key,
			);
			if (!template) {
				throw new Error(`No seeded template ${key}`);
			}
			return {
				definition: template.definition,
				connections: template.connections,
				parameters: template.parameters,
			};
		};

		it("keeps generating an older Quarterly Business Review report with only a quarter and a year", () => {
			expect(
				reportGenerationBlockedReason(
					report({
						template: seeded("quarterly-review"),
						connections: null,
						parameterDefaults: { quarter: "3", year: "2026" },
					}),
				),
			).toBeNull();
		});

		it.each(["monthly-review", "quarterly-review"])(
			"generates %s with nothing connected and no parameter",
			(key) => {
				expect(
					reportGenerationBlockedReason(
						report({
							template: seeded(key),
							connections: {},
							parameterDefaults: null,
						}),
					),
				).toBeNull();
			},
		);
	});

	it("names a required parameter with no value and no default", () => {
		expect(
			reportGenerationBlockedReason(
				report({
					connections: { mcpBindings: { fizzy: "example-config" } },
					parameterDefaults: { sprintName: "  " },
				}),
			),
		).toBe("Fill the required parameter: sprintName.");
	});

	it("names a missing parameter by its title when the template gives one", () => {
		expect(
			reportGenerationBlockedReason(
				report({
					connections: { mcpBindings: { fizzy: "example-config" } },
					parameterDefaults: null,
					template: {
						...fizzyTemplate,
						parameters: {
							required: ["sprintName"],
							properties: {
								sprintName: { type: "string", title: "Sprint" },
							},
						},
					},
				}),
			),
		).toBe("Fill the required parameter: Sprint.");
	});

	it("accepts a required parameter the template gives a default", () => {
		expect(
			reportGenerationBlockedReason(
				report({
					connections: { mcpBindings: { fizzy: "example-config" } },
					parameterDefaults: null,
					template: {
						...fizzyTemplate,
						parameters: {
							required: ["sprintName"],
							properties: {
								sprintName: {
									type: "string",
									default: "Current",
								},
							},
						},
					},
				}),
			),
		).toBeNull();
	});

	it("asks for a switched-off report to be switched on first", () => {
		expect(
			reportGenerationBlockedReason(
				report({
					isActive: false,
					connections: { mcpBindings: { fizzy: "example-config" } },
				}),
			),
		).toBe("Switch this report on to generate it.");
	});
});
