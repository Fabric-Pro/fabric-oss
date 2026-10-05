/**
 * Fabric AI tools (`configId: "fabric-ai-server"`) answer only to the Fabric
 * tool list (`enabledFabricToolIds`, null = all). The MCP config list names
 * user-added servers: a focused agent's list names its own servers, not
 * this virtual one, so applying it to Fabric tools hid the project repository
 * readers (`code_tree`, `code_file_get`) from `search_tools`. Both reads of
 * the index — Qdrant search and Qdrant load — must apply the same rule.
 *
 * The capability store and the embedding call are stand-ins, and
 * `db.mCPConfig.findMany` is a stub that reports no config as turned off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		mCPConfig: {
			// Every config row is turned on; none is reported as disabled.
			findMany: async () => [],
		},
	},
}));

vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbedding: vi.fn(async () => ({ embedding: [0.1, 0.2] })),
	generateEmbeddings: vi.fn(async () => ({ embeddings: [] })),
}));

const store = vi.hoisted(() => ({
	searchCapabilities: vi.fn(),
	getCapabilitiesByTenant: vi.fn(),
}));
vi.mock("@repo/rag/lib/vector-store/capability-store", () => ({
	isCapabilityStoreAvailable: vi.fn(async () => true),
	searchCapabilities: store.searchCapabilities,
	getCapabilitiesByTenant: store.getCapabilitiesByTenant,
	upsertCapabilities: vi.fn(),
	deleteCapabilitiesByServer: vi.fn(),
}));

import { ToolIndex } from "../tool-index";

/** An indexed tool as the capability store returns it. */
function indexed(configId: string, name: string, serverName: string) {
	return {
		score: 0.9,
		capability: {
			id: `user-1:${serverName}:${name}`,
			name,
			description: `${name} on ${serverName}`,
			metadata: {
				configId,
				serverName,
				category: "development",
				isReadOnly: true,
			},
		},
	};
}

const FABRIC = "fabric-ai-server";
const CODE_TREE = indexed(FABRIC, "code_tree", "Fabric AI");
const CODE_FILE_GET = indexed(FABRIC, "code_file_get", "Fabric AI");
const CREATE_DOCUMENT = indexed(FABRIC, "create_document", "Fabric AI");
// In INFRASTRUCTURE_FABRIC_TOOLS: kept whatever the Fabric list says.
const GET_PROJECT_DOCUMENT = indexed(
	FABRIC,
	"fabric_get_project_document",
	"Fabric AI",
);
const DRAW = indexed("cfg-excalidraw", "create_drawing", "Excalidraw");
const LINEAR = indexed("cfg-linear", "list_linear_issues", "Linear");

const ALL = [
	CODE_TREE,
	CODE_FILE_GET,
	CREATE_DOCUMENT,
	GET_PROJECT_DOCUMENT,
	DRAW,
	LINEAR,
];

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	store.searchCapabilities.mockReset();
	store.getCapabilitiesByTenant.mockReset();
	store.searchCapabilities.mockResolvedValue(ALL);
	store.getCapabilitiesByTenant.mockResolvedValue(ALL);
});

async function searchNames(
	enabledMcpConfigIds: string[] | null,
	enabledFabricToolIds: string[] | null,
): Promise<string[]> {
	const results = await new ToolIndex().search({
		query: "browse the repository file tree",
		userId: "user-1",
		organizationId: "example-org",
		minConfidence: 0,
		enabledMcpConfigIds,
		enabledFabricToolIds,
	});
	return results.map((result) => result.tool.toolName).sort();
}

async function loadedNames(
	enabledMcpConfigIds: string[] | null,
	enabledFabricToolIds: string[] | null,
): Promise<string[]> {
	const index = new ToolIndex();
	const loaded = await index.loadFromQdrant(
		"user-1",
		"example-org",
		enabledMcpConfigIds,
		null,
		enabledFabricToolIds,
	);
	expect(loaded).toBe(true);
	return index
		.getAllEntries()
		.map((entry) => entry.toolName)
		.sort();
}

describe.each([
	["Qdrant search", searchNames],
	["Qdrant load", loadedNames],
])("%s: Fabric AI tools follow the Fabric tool list only", (_name, read) => {
	it("a focused agent (MCP list names only its own server) still gets the repository tools", async () => {
		expect(await read(["cfg-excalidraw"], null)).toEqual(
			[
				"code_file_get",
				"code_tree",
				"create_document",
				"create_drawing",
				"fabric_get_project_document",
			].sort(),
		);
	});

	it("an empty MCP list turns off MCP servers, not Fabric AI tools", async () => {
		expect(await read([], null)).toEqual(
			[
				"code_file_get",
				"code_tree",
				"create_document",
				"fabric_get_project_document",
			].sort(),
		);
	});

	it("an explicit Fabric list keeps only its tools and the infrastructure tools", async () => {
		expect(await read(["cfg-excalidraw"], ["code_tree"])).toEqual(
			[
				"code_tree",
				"create_drawing",
				"fabric_get_project_document",
			].sort(),
		);
	});

	it("an empty Fabric list keeps only the infrastructure tools", async () => {
		expect(await read(null, [])).toEqual(
			[
				"create_drawing",
				"fabric_get_project_document",
				"list_linear_issues",
			].sort(),
		);
	});
});

describe("Qdrant search: tools of servers a request does not use cannot crowd out the rest", () => {
	it("still finds code_tree when ten higher-ranked matches belong to other servers", async () => {
		const others = Array.from({ length: 10 }, (_, i) => ({
			...indexed("cfg-github", `github_tool_${i}`, "GitHub"),
			score: 0.9 - i * 0.01,
		}));
		const ranked = [...others, { ...CODE_TREE, score: 0.7 }];
		// The store honours the limit it is asked for, as Qdrant does.
		store.searchCapabilities.mockImplementation(
			async (options: { limit?: number }) =>
				ranked.slice(0, options.limit ?? 10),
		);

		const results = await new ToolIndex().search({
			query: "browse the repository file tree",
			userId: "user-1",
			organizationId: "example-org",
			minConfidence: 0,
			limit: 10,
			enabledMcpConfigIds: ["cfg-excalidraw"],
			enabledFabricToolIds: null,
		});

		expect(results.map((result) => result.tool.toolName)).toEqual([
			"code_tree",
		]);
	});

	it("returns at most the requested limit after filtering", async () => {
		const many = Array.from({ length: 30 }, (_, i) => ({
			...indexed(FABRIC, `fabric_tool_${i}`, "Fabric AI"),
			score: 0.9 - i * 0.01,
		}));
		store.searchCapabilities.mockImplementation(
			async (options: { limit?: number }) =>
				many.slice(0, options.limit ?? 10),
		);

		const results = await new ToolIndex().search({
			query: "anything",
			userId: "user-1",
			organizationId: "example-org",
			minConfidence: 0,
			limit: 5,
		});

		expect(results).toHaveLength(5);
	});
});
