/**
 * search_tools loads the Fabric tools a query names exactly.
 *
 * A descriptive query ("create workspace page frame …") went to the ranked
 * searches, which left `fabric_create_frame` out of the results, so the agent
 * said it had no page tools. Named tools now load as named, before any ranked
 * search or embedding call, and only those the turn may use.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	generateEmbeddings: vi.fn(),
	toolIndexSearch: vi.fn(),
	findMany: vi.fn(),
	getMcpClient: vi.fn(),
}));

// Explicit mock (no importOriginal): the real @repo/database would keep
// pg.Pool handles alive past vitest exit.
vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: vi.fn(),
	db: { mCPConfig: { findMany: hoisted.findMany } },
}));

vi.mock("@repo/database/prisma/queries/lib/oauth-app-row", () => ({
	OAUTH_APP_ROW_NAMES: [],
}));

vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbedding: vi.fn(),
	generateEmbeddings: hoisted.generateEmbeddings,
}));

vi.mock("@repo/rag/lib/vector-store/capability-store", () => ({
	getCapabilitiesByTenant: vi.fn().mockResolvedValue([]),
	searchCapabilities: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/ai", () => ({
	getSystemEmbeddingRAGProviderConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: hoisted.getMcpClient,
	closeMcpClientSafe: vi.fn(),
}));

vi.mock("@repo/mcp-registry", () => ({
	GITHUB_ACCOUNT: { version: "1.0.0" },
	MICROSOFT_TEAMS_ACCOUNT: { version: "1.0.0" },
}));

vi.mock("../../../oauth-tool-ingestion", () => ({
	ingestOAuthIntegrationToolsActivity: vi.fn(),
}));

vi.mock("../fabric-ai-tools", () => ({
	getFabricAiTools: vi.fn().mockReturnValue([
		{
			name: "fabric_create_frame",
			description: "Create a page",
			inputSchema: { type: "object", properties: { title: {} } },
		},
		{ name: "fabric_list_frames", description: "List pages" },
		{ name: "fabric_list_workflows", description: "List workflows" },
	]),
}));

vi.mock("../tool-index", () => ({
	toolIndex: {
		search: hoisted.toolIndexSearch,
		needsRebuild: vi.fn().mockReturnValue(false),
		loadFromQdrant: vi.fn().mockResolvedValue(true),
		getStats: vi.fn().mockReturnValue({ totalTools: 0, servers: 0 }),
		getServerTools: vi.fn().mockReturnValue([]),
		getAllEntries: vi.fn().mockReturnValue([]),
	},
}));

vi.mock("../../../../lib/redis-cache", () => ({
	CacheKeys: { queryEmbedding: () => "query-key" },
	CacheTTL: { queryEmbedding: 60 },
	RedisCache: {
		get: vi.fn().mockResolvedValue(null),
		set: vi.fn().mockResolvedValue(undefined),
	},
}));

import { ALWAYS_AVAILABLE_CAPABILITIES } from "../capability-keywords";
import { getFabricAiTools } from "../fabric-ai-tools";
import {
	LOOP_DISPATCHED_PROJECT_TOOL_NAMES,
	PROJECT_TOOL_NAMES,
} from "../project-tools";
import { searchAvailableTools } from "../search-tools";
import { WORKSPACE_TOOL_NAMES } from "../workspace-tools";

const DEFAULT_FABRIC_TOOLS = vi.mocked(getFabricAiTools)();

const TENANT = { userId: "user-example-1", organizationId: "org-example-1" };

beforeEach(() => {
	vi.clearAllMocks();
	hoisted.findMany.mockResolvedValue([]);
	hoisted.getMcpClient.mockReset();
	vi.mocked(getFabricAiTools).mockReturnValue(DEFAULT_FABRIC_TOOLS);
	hoisted.generateEmbeddings.mockResolvedValue({ embeddings: [] });
	hoisted.toolIndexSearch.mockResolvedValue([]);
});

describe("searchAvailableTools exact names", () => {
	it("loads the named tools with their schemas and runs no ranked search", async () => {
		const result = await searchAvailableTools({
			query: "fabric_create_frame, fabric_list_frames",
			...TENANT,
		});

		expect(result.results.map((r) => r.toolName)).toEqual([
			"fabric_create_frame",
			"fabric_list_frames",
		]);
		expect(result.results[0]).toMatchObject({
			confidence: 1,
			configId: "fabric-ai-server",
			isReadOnly: false,
			inputSchema: { type: "object", properties: { title: {} } },
		});
		expect(result.results[1]?.isReadOnly).toBe(true);
		expect(result.telemetry?.strategy).toBe("exact_name");
		expect(hoisted.generateEmbeddings).not.toHaveBeenCalled();
		expect(hoisted.toolIndexSearch).not.toHaveBeenCalled();
	});

	it("loads a named tool from inside a sentence", async () => {
		const result = await searchAvailableTools({
			query: 'load "fabric_create_frame" to build the Workspace page',
			...TENANT,
		});

		expect(result.results.map((r) => r.toolName)).toEqual([
			"fabric_create_frame",
		]);
		expect(result.telemetry?.strategy).toBe("exact_name");
	});

	it("does not load a named tool the turn may not use", async () => {
		const result = await searchAvailableTools({
			query: "fabric_create_frame",
			enabledFabricToolIds: ["fabric_list_workflows"],
			...TENANT,
		});

		expect(result.results.map((r) => r.toolName)).not.toContain(
			"fabric_create_frame",
		);
		expect(result.telemetry?.strategy).not.toBe("exact_name");
	});

	it("leaves a descriptive query to the ranked searches", async () => {
		const result = await searchAvailableTools({
			query: "create workspace page frame",
			...TENANT,
		});

		expect(result.telemetry?.strategy).not.toBe("exact_name");
	});
});

describe("searchAvailableTools workspace context", () => {
	it.each(Object.values(WORKSPACE_TOOL_NAMES))(
		"continues past exact-name selection when %s has no workspace",
		async (name) => {
			const names = Object.values(WORKSPACE_TOOL_NAMES);
			vi.mocked(getFabricAiTools).mockReturnValue(
				names.map((toolName) => ({
					name: toolName,
					description: toolName,
					inputSchema: { type: "object" },
				})),
			);
			for (const workspaceIds of [undefined, [], ["ws-example"]]) {
				const result = await searchAvailableTools({
					query: `use ${name}`,
					...TENANT,
					workspaceIds,
				});
				const offered = result.results.map((r) => r.toolName);
				if (workspaceIds?.length === 0) {
					for (const toolName of names) {
						expect(offered).not.toContain(toolName);
					}
					expect(result.telemetry?.strategy).not.toBe("exact_name");
					expect(hoisted.toolIndexSearch).toHaveBeenCalled();
				} else {
					expect(offered).toEqual([name]);
					expect(result.telemetry?.strategy).toBe("exact_name");
				}
			}
		},
	);

	it("removes workspace capability matches before merging search results", async () => {
		// An empty catalog isolates capability matches from the keyword corpus.
		vi.mocked(getFabricAiTools).mockReturnValue([]);
		const mergedSummary = vi
			.spyOn(console, "log")
			.mockImplementation(() => {});
		try {
			for (const workspaceIds of [undefined, [], ["ws-example"]]) {
				mergedSummary.mockClear();
				const result = await searchAvailableTools({
					query: "search my documents in my files workspace attached files uploaded documents",
					...TENANT,
					workspaceIds,
				});
				expect(result.telemetry?.strategy).toBe("semantic");
				if (workspaceIds?.length === 0) {
					expect(result.results).toEqual([]);
					// This diagnostic counts the merged matches before the response filter.
					expect(mergedSummary).toHaveBeenCalledWith(
						expect.stringMatching(
							/Found 0 tools .*always-available: 0/,
						),
					);
				} else {
					expect(result.results).toHaveLength(1);
					expect(result.results[0]).toMatchObject({
						toolName: WORKSPACE_TOOL_NAMES.query,
						matchReason:
							expect.stringContaining("Always-available:"),
					});
					expect(mergedSummary).toHaveBeenCalledWith(
						expect.stringMatching(
							/Found 1 tools .*always-available: 1/,
						),
					);
				}
			}
		} finally {
			mergedSummary.mockRestore();
		}
	});

	it("filters same-named workspace tools from the focused MCP fallback", async () => {
		const names = Object.values(WORKSPACE_TOOL_NAMES);
		hoisted.findMany.mockResolvedValue([
			{
				id: "cfg-example",
				displayName: "Example Service",
				mcpServer: { name: "Example Service" },
			},
		]);
		hoisted.getMcpClient.mockResolvedValue({
			client: {
				tools: vi
					.fn()
					.mockResolvedValue(
						Object.fromEntries(
							[...names, "external_read"].map((name) => [
								name,
								{ description: name },
							]),
						),
					),
			},
		});
		for (const workspaceIds of [undefined, [], ["ws-example"]]) {
			const result = await searchAvailableTools({
				query: "retrieve external reference",
				...TENANT,
				workspaceIds,
				enabledMcpConfigIds: ["cfg-example"],
			});
			expect(result.telemetry?.strategy).toBe("focused_server_fallback");
			expect(result.results.map((r) => r.toolName).sort()).toEqual(
				(workspaceIds?.length === 0
					? ["external_read"]
					: [...names, "external_read"]
				).sort(),
			);
		}
	});
});

describe("searchAvailableTools project context", () => {
	it.each(PROJECT_TOOL_NAMES)(
		"continues past exact-name selection when %s has no project",
		async (name) => {
			const names = PROJECT_TOOL_NAMES;
			vi.mocked(getFabricAiTools).mockReturnValue(
				names.map((toolName) => ({
					name: toolName,
					description: toolName,
					inputSchema: { type: "object" },
				})),
			);
			for (const projectId of [undefined, null, "project-example"]) {
				const result = await searchAvailableTools({
					query: `use ${name}`,
					...TENANT,
					projectId,
				});
				const offered = result.results.map((r) => r.toolName);
				if (projectId === null) {
					expect(offered).not.toContain(name);
					expect(result.telemetry?.strategy).not.toBe("exact_name");
					expect(hoisted.toolIndexSearch).toHaveBeenCalled();
				} else {
					expect(offered).toEqual([name]);
					expect(result.telemetry?.strategy).toBe("exact_name");
				}
			}
		},
	);

	it("removes project capability matches before merging search results", async () => {
		// An empty catalog isolates capability matches from the keyword corpus.
		vi.mocked(getFabricAiTools).mockReturnValue([]);
		const mergedSummary = vi
			.spyOn(console, "log")
			.mockImplementation(() => {});
		try {
			for (const projectId of [undefined, null, "project-example"]) {
				mergedSummary.mockClear();
				const result = await searchAvailableTools({
					query:
						ALWAYS_AVAILABLE_CAPABILITIES.find(
							(capability) =>
								capability.id ===
								"fabric_list_feature_decisions",
						)?.description ?? "",
					...TENANT,
					projectId,
				});
				expect(result.telemetry?.strategy).toBe("semantic");
				if (projectId === null) {
					expect(result.results).toEqual([]);
					// This diagnostic counts the merged matches before the response filter.
					expect(mergedSummary).toHaveBeenCalledWith(
						expect.stringMatching(
							/Found 0 tools .*always-available: 0/,
						),
					);
				} else {
					expect(result.results).toHaveLength(1);
					expect(result.results[0]).toMatchObject({
						toolName: "fabric_list_feature_decisions",
						matchReason:
							expect.stringContaining("Always-available:"),
					});
					expect(mergedSummary).toHaveBeenCalledWith(
						expect.stringMatching(
							/Found 1 tools .*always-available: 1/,
						),
					);
				}
			}
		} finally {
			mergedSummary.mockRestore();
		}
	});

	it("filters same-named project tools from the focused MCP fallback", async () => {
		const names = PROJECT_TOOL_NAMES;
		hoisted.findMany.mockResolvedValue([
			{
				id: "cfg-example",
				displayName: "Example Service",
				mcpServer: { name: "Example Service" },
			},
		]);
		hoisted.getMcpClient.mockResolvedValue({
			client: {
				tools: vi
					.fn()
					.mockResolvedValue(
						Object.fromEntries(
							[...names, "external_read"].map((name) => [
								name,
								{ description: name },
							]),
						),
					),
			},
		});
		for (const projectId of [undefined, null, "project-example"]) {
			const result = await searchAvailableTools({
				query: "retrieve external reference",
				...TENANT,
				projectId,
				enabledMcpConfigIds: ["cfg-example"],
			});
			expect(result.telemetry?.strategy).toBe("focused_server_fallback");
			expect(result.results.map((r) => r.toolName).sort()).toEqual(
				(projectId === null
					? [
							...names.filter(
								(name) =>
									!new Set<string>(
										LOOP_DISPATCHED_PROJECT_TOOL_NAMES,
									).has(name),
							),
							"external_read",
						]
					: [...names, "external_read"]
				).sort(),
			);
		}
	});
});
