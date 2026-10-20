/**
 * "Every Monday at 9:00 make me a status page from my Azure DevOps items" has
 * to lead the Orchestrator to `fabric_create_workflow`. A chat finds its tools
 * through `search_tools`, which reads the Fabric AI catalogue — so the workflow
 * tools are in it, described from the same definitions the Fabric MCP gateway
 * serves, with the words people use for schedules.
 *
 * The capability store and the embedding call are stand-ins, so the search runs
 * on the in-memory keyword index, which every chat falls back to and which
 * ranks on the same descriptions the embeddings are made from.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	FABRIC_CHAT_TOOL_DEFINITIONS,
	FABRIC_GATEWAY_TOOL_DEFINITIONS,
} from "../../../../lib/fabric-gateway-tools";
import {
	type FabricToolDefinition,
	withoutDryRun,
	withoutDryRunNote,
} from "../../../../lib/fabric-tool-definition";
import { selectFabricToolsByName } from "../select-tools-by-name";

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: { mCPConfig: { findMany: async () => [] } },
}));
vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbedding: vi.fn(async () => ({ embedding: [0.1, 0.2] })),
	generateEmbeddings: vi.fn(async () => ({ embeddings: [] })),
}));
vi.mock("@repo/rag/lib/vector-store/capability-store", () => ({
	isCapabilityStoreAvailable: vi.fn(async () => false),
	searchCapabilities: vi.fn(),
	getCapabilitiesByTenant: vi.fn(),
	upsertCapabilities: vi.fn(),
	deleteCapabilitiesByServer: vi.fn(),
}));

const { ToolIndex } = await import("../tool-index");
const { getAllFabricAiTools, getFabricAiTools } = await import(
	"../fabric-ai-tools"
);
const { extractKeywordsFromDescription } = await import(
	"../capability-keywords"
);

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

async function indexed() {
	const index = new ToolIndex();
	await index.addServer("fabric-ai-server", "Fabric AI", getFabricAiTools(), {
		persistToQdrant: false,
	});
	return index;
}

async function rank(
	query: string,
	enabledFabricToolIds: string[] | null = null,
): Promise<string[]> {
	const results = await (await indexed()).search({
		query,
		minConfidence: 0,
		limit: 5,
		enabledFabricToolIds,
	});
	return results.map((result) => result.tool.toolName);
}

describe("the catalogue's gateway tools", () => {
	it.each([
		["ADO work item types", "fabric_list_project_pm_work_item_types"],
		["ADO assigned items", "fabric_list_project_pm_assigned_items"],
		["ADO item snapshots", "fabric_get_project_pm_item_snapshots"],
		["list Fabric projects workspaces", "fabric_list_projects"],
		[
			"coding instructions configs count configurations",
			"fabric_list_project_instructions",
		],
		[
			"runtime tools frame fabric call list sources project",
			"fabric_list_page_tools",
		],
		["connected servers integrations", "fabric_list_connected_servers"],
		[
			"ADO connected project management binding",
			"fabric_get_project_pm_connection",
		],
		[
			"ADO project members assignee dropdown",
			"fabric_list_project_pm_members",
		],
		[
			"Azure DevOps work item counts",
			"fabric_get_project_work_item_counts",
		],
	])("discovers %s as %s", async (query, name) => {
		expect(await rank(query)).toContain(name);
	});
	it("lists every workflow, frame and page tool the chat offers, visibly", () => {
		const visible = getFabricAiTools().map((tool) => tool.name);
		for (const { name } of FABRIC_CHAT_TOOL_DEFINITIONS) {
			expect(visible).toContain(name);
		}
	});

	it("does not list a tool only a page's script has a use for", () => {
		const listed = getAllFabricAiTools().map((tool) => tool.name);
		const gatewayTools: readonly FabricToolDefinition[] =
			FABRIC_GATEWAY_TOOL_DEFINITIONS;
		for (const { name } of gatewayTools.filter(
			(tool) => tool.pageOnly === true,
		)) {
			expect(listed, name).not.toContain(name);
		}
	});

	it("takes each tool's input schema from the gateway's definition, not a copy, less dryRun", () => {
		for (const definition of FABRIC_CHAT_TOOL_DEFINITIONS) {
			const entry = getAllFabricAiTools().find(
				(tool) => tool.name === definition.name,
			);
			expect(entry?.inputSchema).toEqual(
				withoutDryRun(definition.inputSchema),
			);
			expect(entry?.description).toContain(
				withoutDryRunNote(definition.description),
			);
		}
	});

	it("never offers the model dryRun, so it makes the real call and the approval card is the question", () => {
		for (const name of [
			"fabric_create_workflow",
			"fabric_update_workflow",
		]) {
			const entry = getAllFabricAiTools().find(
				(tool) => tool.name === name,
			);
			const properties = (
				entry?.inputSchema as
					| { properties?: Record<string, unknown> }
					| undefined
			)?.properties;

			expect(properties, name).toBeDefined();
			expect(properties, name).not.toHaveProperty("dryRun");
			expect(entry?.description, name).not.toContain("dryRun");
		}
	});

	it("still serves dryRun to a client that sees it: the gateway's definitions are untouched", () => {
		const create = FABRIC_CHAT_TOOL_DEFINITIONS.find(
			(tool) => tool.name === "fabric_create_workflow",
		);

		expect(create?.inputSchema.properties).toHaveProperty("dryRun");
		expect(create?.description).toContain("`dryRun` writes nothing.");
	});

	it("tells the model to make the real call and not to ask in prose first", () => {
		const description =
			getAllFabricAiTools().find(
				(tool) => tool.name === "fabric_create_workflow",
			)?.description ?? "";

		expect(description).toContain("Make the real call");
		expect(description).not.toMatch(/dryRun first/i);
	});

	it("offers the frame create and update tools with the page, its place and its tools, as the gateway does", () => {
		for (const name of ["fabric_create_frame", "fabric_update_frame"]) {
			const properties = (
				getAllFabricAiTools().find((tool) => tool.name === name)
					?.inputSchema as
					| { properties?: Record<string, unknown> }
					| undefined
			)?.properties;

			expect(Object.keys(properties ?? {}), name).toEqual(
				expect.arrayContaining(["surface", "runtimeTools"]),
			);
		}
		const create = getAllFabricAiTools().find(
			(tool) => tool.name === "fabric_create_frame",
		)?.inputSchema as { properties?: Record<string, unknown> } | undefined;
		expect(create?.properties).toHaveProperty("sharedWithOrganization");
	});

	it("gives each tool the phrases people use, in the form the keyword step reads", () => {
		for (const { name } of FABRIC_CHAT_TOOL_DEFINITIONS) {
			const description = getAllFabricAiTools().find(
				(tool) => tool.name === name,
			)?.description;
			expect(
				extractKeywordsFromDescription(description ?? "").length,
			).toBeGreaterThanOrEqual(3);
		}
	});
});

describe("finding the tool from a plain request", () => {
	it("leads a scheduled status page to fabric_create_workflow", async () => {
		const names = await rank(
			"Every Monday at 9:00 make me a status page from my Azure DevOps items",
		);

		expect(names[0]).toBe("fabric_create_workflow");
	});

	it.each([
		[
			"send me a digest of new work items every morning",
			"fabric_create_workflow",
		],
		["set up a recurring weekly report page", "fabric_create_workflow"],
		["what workflows do I have scheduled", "fabric_list_workflows"],
		["did my weekly workflow run last night", "fabric_list_workflow_runs"],
		["pause the weekly status routine", "fabric_pause_workflow"],
		["change the schedule of my digest workflow", "fabric_update_workflow"],
		["publish the workflow", "fabric_publish_workflow"],
		[
			"go back to the earlier version of my page",
			"fabric_restore_frame_version",
		],
		["show the version history of this page", "fabric_list_frame_versions"],
		["make my own copy of this page", "fabric_duplicate_frame"],
		["share this page with my colleagues", "fabric_share_frame"],
		["summarize the poll results on my page", "fabric_page_data_list"],
		["save a record in the page data", "fabric_page_data_set"],
		["who is viewing this page", "fabric_get_page_viewer"],
		["leave a comment on this page", "fabric_page_comment_add"],
	])("%s", async (query, expected) => {
		expect(await rank(query)).toContain(expected);
	});

	it("still offers the workflow tools when the person's Fabric tool list names others", async () => {
		const names = await rank(
			"Every Monday at 9:00 make me a status page from my Azure DevOps items",
			["fabric_web_search"],
		);

		expect(names).toContain("fabric_create_workflow");
	});
});

describe("the Automations & pages skill's searches by name", () => {
	const skill = readFileSync(
		resolve(
			process.cwd(),
			"../database/prisma/skills-seed/automations-and-pages/SKILL.md",
		),
		"utf8",
	);
	const searches = [
		...skill.matchAll(/search_tools\(\{ query: "([^"]+)" \}\)/g),
	].map((match) => match[1] ?? "");

	it("load every tool they name from the catalogue", () => {
		expect(searches.length).toBeGreaterThanOrEqual(2);
		for (const query of searches) {
			const named = query.split(" ");
			expect(
				selectFabricToolsByName(query, getFabricAiTools()).map(
					(tool) => tool.name,
				),
			).toEqual(named);
		}
	});
});
