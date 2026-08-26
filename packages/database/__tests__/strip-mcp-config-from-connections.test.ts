import { describe, expect, it } from "vitest";
import { stripMcpConfigFromConnections } from "../prisma/queries/reports";

describe("stripMcpConfigFromConnections", () => {
	it("removes the config id from mcpConfigs (incl. duplicates) and mcpBindings, preserving other fields", () => {
		const r = stripMcpConfigFromConnections(
			{
				mcpConfigs: ["dead", "dead", "live"],
				mcpBindings: {
					fizzy: "dead",
					"task-board": "dead",
					other: "live",
				},
				resourceBindings: { fizzy: { resourceId: "b" } },
				context: { project: "X" },
			},
			"dead",
		);
		expect(r?.changed).toBe(true);
		expect(r?.connections.mcpConfigs).toEqual(["live"]);
		expect(r?.connections.mcpBindings).toEqual({ other: "live" });
		// Unrelated fields are preserved untouched.
		expect(r?.connections.resourceBindings).toEqual({
			fizzy: { resourceId: "b" },
		});
		expect(r?.connections.context).toEqual({ project: "X" });
	});

	it("reports changed=false when the id isn't referenced", () => {
		const r = stripMcpConfigFromConnections(
			{ mcpConfigs: ["a"], mcpBindings: { x: "a" } },
			"dead",
		);
		expect(r?.changed).toBe(false);
		expect(r?.connections.mcpConfigs).toEqual(["a"]);
		expect(r?.connections.mcpBindings).toEqual({ x: "a" });
	});

	it("handles missing / empty / malformed input safely", () => {
		expect(stripMcpConfigFromConnections(null, "x")).toBeNull();
		expect(
			stripMcpConfigFromConnections({ mcpConfigs: [] }, ""),
		).toBeNull();
		const empty = stripMcpConfigFromConnections({}, "x");
		expect(empty?.changed).toBe(false);
		expect(empty?.connections.mcpConfigs).toEqual([]);
		expect(empty?.connections.mcpBindings).toEqual({});
	});
});
