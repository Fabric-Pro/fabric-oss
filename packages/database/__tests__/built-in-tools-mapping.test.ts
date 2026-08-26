import { describe, expect, it } from "vitest";
import {
	BUILT_IN_TO_FABRIC_TOOLS,
	extractEnabledBuiltInToolKeys,
	getBuiltInToolConfig,
	mapBuiltInKeysToFabricToolIds,
} from "../prisma/queries/agent-templates";

describe("BUILT_IN_TO_FABRIC_TOOLS", () => {
	it("registers project-context as a built-in capability backed by project_rag_query", () => {
		expect(BUILT_IN_TO_FABRIC_TOOLS["project-context"]).toEqual([
			"project_rag_query",
		]);
	});

	it("keeps the legacy web-search and create-frames mappings intact", () => {
		expect(BUILT_IN_TO_FABRIC_TOOLS["web-search"]).toContain(
			"fabric_web_search",
		);
		expect(BUILT_IN_TO_FABRIC_TOOLS["create-frames"]).toContain(
			"fabric_create_frame",
		);
	});
});

describe("extractEnabledBuiltInToolKeys", () => {
	it("returns enabled built-in keys (no connectionId, no mcp: prefix)", () => {
		expect(
			extractEnabledBuiltInToolKeys({
				"project-context": { enabled: true },
				"web-search": { enabled: true },
				"create-frames": { enabled: false },
			}),
		).toEqual(["project-context", "web-search"]);
	});

	it("treats missing 'enabled' as enabled (legacy default)", () => {
		expect(
			extractEnabledBuiltInToolKeys({
				"project-context": {},
			}),
		).toEqual(["project-context"]);
	});

	it("excludes MCP-prefixed entries", () => {
		expect(
			extractEnabledBuiltInToolKeys({
				"project-context": { enabled: true },
				"mcp:some-config-id": { enabled: true },
			}),
		).toEqual(["project-context"]);
	});

	it("excludes integration-backed entries that carry a connectionId", () => {
		expect(
			extractEnabledBuiltInToolKeys({
				notion: { enabled: true, connectionId: "abc" },
				"project-context": { enabled: true },
			}),
		).toEqual(["project-context"]);
	});

	it("returns an empty array for missing or non-object inputs", () => {
		expect(extractEnabledBuiltInToolKeys(null)).toEqual([]);
		expect(extractEnabledBuiltInToolKeys(undefined)).toEqual([]);
		expect(extractEnabledBuiltInToolKeys("not-an-object")).toEqual([]);
	});
});

describe("getBuiltInToolConfig", () => {
	it("returns the config object for an enabled built-in tool", () => {
		expect(
			getBuiltInToolConfig(
				{
					"project-context": {
						enabled: true,
						projectId: "proj_abc",
					},
				},
				"project-context",
			),
		).toEqual({ enabled: true, projectId: "proj_abc" });
	});

	it("returns null when the tool is explicitly disabled", () => {
		expect(
			getBuiltInToolConfig(
				{
					"project-context": {
						enabled: false,
						projectId: "proj_abc",
					},
				},
				"project-context",
			),
		).toBeNull();
	});

	it("returns null when the tool key is missing", () => {
		expect(
			getBuiltInToolConfig(
				{ "web-search": { enabled: true } },
				"project-context",
			),
		).toBeNull();
	});

	it("returns null when toolConnections is null/undefined/non-object", () => {
		expect(getBuiltInToolConfig(null, "project-context")).toBeNull();
		expect(getBuiltInToolConfig(undefined, "project-context")).toBeNull();
		expect(getBuiltInToolConfig("string", "project-context")).toBeNull();
	});

	it("returns null when the entry value is not an object (e.g., array)", () => {
		expect(
			getBuiltInToolConfig({ "project-context": [] }, "project-context"),
		).toBeNull();
	});
});

describe("mapBuiltInKeysToFabricToolIds", () => {
	it("expands project-context to the project_rag_query tool", () => {
		expect(mapBuiltInKeysToFabricToolIds(["project-context"])).toEqual([
			"project_rag_query",
		]);
	});

	it("ignores keys without a registered mapping", () => {
		expect(
			mapBuiltInKeysToFabricToolIds(["project-context", "made-up-key"]),
		).toEqual(["project_rag_query"]);
	});

	it("flattens multiple keys into the union of their tool ids", () => {
		expect(
			mapBuiltInKeysToFabricToolIds(["project-context", "create-images"]),
		).toEqual(["project_rag_query", "fabric_generate_image"]);
	});

	it("returns an empty array when no built-in keys are enabled", () => {
		expect(mapBuiltInKeysToFabricToolIds([])).toEqual([]);
	});
});
