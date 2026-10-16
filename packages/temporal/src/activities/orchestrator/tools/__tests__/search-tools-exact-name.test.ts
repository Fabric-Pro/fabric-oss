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
}));

// Explicit mock (no importOriginal): the real @repo/database would keep
// pg.Pool handles alive past vitest exit.
vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: vi.fn(),
	db: { mCPConfig: { findMany: vi.fn().mockResolvedValue([]) } },
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
	getMcpClient: vi.fn(),
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

import { searchAvailableTools } from "../search-tools";

const TENANT = { userId: "user-example-1", organizationId: "org-example-1" };

beforeEach(() => {
	vi.clearAllMocks();
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
