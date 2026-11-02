import { describe, expect, it } from "vitest";
import { hasActiveContext } from "../active-context";

describe("hasActiveContext", () => {
	it("omits context controls for unresolved or empty selections", () => {
		expect(hasActiveContext({})).toBe(false);
		expect(
			hasActiveContext({
				workspaceIds: [],
				mcpConfigIds: [],
				agentIds: [],
				fabricToolIds: [],
				integrationIds: [],
				projectId: null,
			}),
		).toBe(false);
	});
	it.each([
		{ workspaceIds: ["workspace"] },
		{ mcpConfigIds: ["mcp"] },
		{ agentIds: ["agent"] },
		{ fabricToolIds: ["tool"] },
		{ integrationIds: ["integration"] },
		{ projectId: "project" },
	])(
		"reserves configured context before its labels resolve: %j",
		(context) => {
			expect(hasActiveContext(context)).toBe(true);
		},
	);
});
