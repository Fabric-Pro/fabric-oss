/**
 * Tools indexed for an MCP config stay in the capability store after the
 * config is turned off: a GitLab server's tile Delete turns its config off
 * without deleting them, and the caller-selected id lists the index is read
 * with (`enabledMcpConfigIds`) are a preference, not the row's state. Every
 * read of the index — Qdrant search, Qdrant load, and the in-memory search —
 * must therefore leave out the tools of a config whose row is off now.
 *
 * The capability store and the embedding call are stand-ins; the config rows
 * come from a fake `db.mCPConfig.findMany` that applies the `where` it is
 * given.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type ConfigRow = { id: string; enabled: boolean };
const rows: ConfigRow[] = [];

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		mCPConfig: {
			findMany: async (args: {
				where: { id: { in: string[] }; enabled: boolean };
			}) =>
				rows
					.filter(
						(row) =>
							args.where.id.in.includes(row.id) &&
							row.enabled === args.where.enabled,
					)
					.map((row) => ({ id: row.id })),
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
				category: "project_management",
				isReadOnly: true,
			},
		},
	};
}

const GITLAB_TOOL = indexed("cfg-gitlab", "list_issues", "GitLab");
const LINEAR_TOOL = indexed("cfg-linear", "list_linear_issues", "Linear");

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	rows.length = 0;
	// The GitLab tile was deleted: its config row is kept, turned off.
	rows.push(
		{ id: "cfg-gitlab", enabled: false },
		{ id: "cfg-linear", enabled: true },
	);
	store.searchCapabilities.mockReset();
	store.getCapabilitiesByTenant.mockReset();
	store.searchCapabilities.mockResolvedValue([GITLAB_TOOL, LINEAR_TOOL]);
	store.getCapabilitiesByTenant.mockResolvedValue([GITLAB_TOOL, LINEAR_TOOL]);
});

describe("the tool index leaves out tools of a config turned off now", () => {
	it.each([
		["no preference list", null],
		[
			"a preference list that still names the GitLab config",
			["cfg-gitlab", "cfg-linear"],
		],
	])("Qdrant search, with %s", async (_name, enabledMcpConfigIds) => {
		const index = new ToolIndex();

		const results = await index.search({
			query: "list issues",
			userId: "user-1",
			organizationId: "example-org",
			minConfidence: 0,
			enabledMcpConfigIds,
		});

		expect(results.map((result) => result.tool.configId)).toEqual([
			"cfg-linear",
		]);
	});

	it("Qdrant load, and the in-memory search over what was loaded", async () => {
		const index = new ToolIndex();

		const loaded = await index.loadFromQdrant("user-1", "example-org", [
			"cfg-gitlab",
			"cfg-linear",
		]);

		expect(loaded).toBe(true);
		expect(index.getServerTools("GitLab")).toEqual([]);
		expect(
			index.getServerTools("Linear").map((tool) => tool.toolName),
		).toEqual(["list_linear_issues"]);
	});

	it("the in-memory search drops a tool whose config was turned off after it was loaded", async () => {
		rows[0].enabled = true;
		const index = new ToolIndex();
		await index.loadFromQdrant("user-1", "example-org", null);
		expect(index.getServerTools("GitLab")).toHaveLength(1);

		// Turned off afterwards; the search falls back to the in-memory index.
		rows[0].enabled = false;
		const results = await index.search({
			query: "list issues",
			minConfidence: 0,
		});

		expect(results.map((result) => result.tool.configId)).not.toContain(
			"cfg-gitlab",
		);
	});

	it("keeps a turned-on config's tools and the virtual sources untouched", async () => {
		rows[0].enabled = true;
		store.searchCapabilities.mockResolvedValue([
			GITLAB_TOOL,
			indexed("fabric-ai-server", "create_document", "Fabric AI"),
			indexed("oauth:integration:int-1", "send_message", "Slack"),
		]);
		const index = new ToolIndex();

		const results = await index.search({
			query: "list issues",
			userId: "user-1",
			organizationId: "example-org",
			minConfidence: 0,
		});

		expect(results.map((result) => result.tool.configId).sort()).toEqual([
			"cfg-gitlab",
			"fabric-ai-server",
			"oauth:integration:int-1",
		]);
	});
});
