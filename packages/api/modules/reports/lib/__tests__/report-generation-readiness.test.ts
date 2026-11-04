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
