import { describe, expect, it } from "vitest";
import {
	BUILT_IN_TO_FABRIC_TOOLS,
	extractEnabledBuiltInToolKeys,
	getBuiltInToolConfig,
	mapBuiltInKeysToFabricToolIds,
} from "../prisma/queries/agent-templates";

const PROJECT_CONTEXT_TOOLS = [
	"project_rag_query",
	"fabric_list_meeting_transcripts",
	"fabric_list_project_features",
	"fabric_get_project_feature",
	"fabric_list_project_documents",
	"fabric_get_project_document",
	"fabric_list_project_sources",
	"fabric_get_project_source",
];

describe("BUILT_IN_TO_FABRIC_TOOLS", () => {
	it("registers project-context as a built-in capability backed by project_rag_query", () => {
		expect(BUILT_IN_TO_FABRIC_TOOLS["project-context"]).toEqual(
			PROJECT_CONTEXT_TOOLS,
		);
	});

	// Fizzy #2578: RAG returns a similarity sample, so "list the documents"
	// or "which files are on the Context tab" needs the exact live listings.
	it("ships the live document and source reads alongside project RAG", () => {
		expect(BUILT_IN_TO_FABRIC_TOOLS["project-context"]).toEqual(
			expect.arrayContaining([
				"fabric_list_project_documents",
				"fabric_get_project_document",
				"fabric_list_project_sources",
				"fabric_get_project_source",
			]),
		);
	});

	// Fizzy #2309: RAG cannot answer "what is In Review?" or "status of F-040";
	// project context must carry the live roadmap reads.
	it("ships the live roadmap reads alongside project RAG", () => {
		expect(BUILT_IN_TO_FABRIC_TOOLS["project-context"]).toEqual(
			expect.arrayContaining([
				"fabric_list_project_features",
				"fabric_get_project_feature",
			]),
		);
	});

	// Regression lock for Fizzy #2473: semantic search cannot filter or order by
	// date, so an agent granted project context without the date-aware meeting
	// lookup will answer "any transcripts from the 10th?" from whatever its
	// similarity sample held — and report that guess as fact.
	it("ships the date-aware meeting lookup alongside project RAG", () => {
		expect(BUILT_IN_TO_FABRIC_TOOLS["project-context"]).toContain(
			"fabric_list_meeting_transcripts",
		);
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
	it("expands project-context to the project RAG, meeting lookup and roadmap tools", () => {
		expect(mapBuiltInKeysToFabricToolIds(["project-context"])).toEqual(
			PROJECT_CONTEXT_TOOLS,
		);
	});

	it("ignores keys without a registered mapping", () => {
		expect(
			mapBuiltInKeysToFabricToolIds(["project-context", "made-up-key"]),
		).toEqual(PROJECT_CONTEXT_TOOLS);
	});

	it("flattens multiple keys into the union of their tool ids", () => {
		expect(
			mapBuiltInKeysToFabricToolIds(["project-context", "create-images"]),
		).toEqual([...PROJECT_CONTEXT_TOOLS, "fabric_generate_image"]);
	});

	it("returns an empty array when no built-in keys are enabled", () => {
		expect(mapBuiltInKeysToFabricToolIds([])).toEqual([]);
	});
});
