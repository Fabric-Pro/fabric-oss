import { reportHasConnections } from "@saas/reports/lib/report-owner-connections";
import { describe, expect, it } from "vitest";

describe("reportHasConnections", () => {
	it.each([
		[{ mcpConfigs: ["config-1"] }],
		[{ mcpBindings: { source: "config-1" } }],
		[{ integrations: ["integration-1"] }],
		[{ integrationBindings: { source: "integration-1" } }],
	])("counts a bound connection: %j", (connections) => {
		expect(reportHasConnections(connections)).toBe(true);
	});

	it.each([
		[null],
		[undefined],
		[{}],
		[{ mcpConfigs: [], mcpBindings: {}, integrations: [] }],
		[{ context: { boardId: "example-board" } }],
	])("counts nothing else: %j", (connections) => {
		expect(reportHasConnections(connections)).toBe(false);
	});
});
