import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockFindMany = vi.fn();
const mockSearch = vi.fn();
const mockNeedsRebuild = vi.fn();
const mockLoadFromQdrant = vi.fn();
const mockGetStats = vi.fn();
const mockGetServerTools = vi.fn();

// Explicit mock (no importOriginal) — loading real @repo/database
// would keep pg.Pool handles alive past vitest exit (vitest #4373).
vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		mCPConfig: {
			findMany: mockFindMany,
		},
		workflowIntegration: {
			findFirst: vi.fn().mockResolvedValue(null),
		},
		userCloudProviderConfig: {
			findFirst: vi.fn().mockResolvedValue(null),
		},
	},
	Prisma: {},
	getMcpConfigById: vi.fn(),
	getMcpServerByKey: vi.fn(),
	getMcpConfigForTenantAndServer: vi.fn(),
	listMcpConfigsForTenant: vi.fn().mockResolvedValue([]),
	listCustomMcpServersForTenant: vi.fn().mockResolvedValue([]),
	listMcpServersAccessibleToTenant: vi.fn().mockResolvedValue([]),
	listSystemMcpServers: vi.fn().mockResolvedValue([]),
	findProjectRepoCredentials: vi.fn(),
	getAiProviderApiKey: vi.fn().mockResolvedValue({ apiKey: null }),
	updateProviderLastUsed: vi.fn().mockResolvedValue(undefined),
	GATEWAY_PROVIDERS: [
		"VERCEL_GATEWAY",
		"OPENROUTER",
		"CLOUDFLARE_AI",
	] as const,
	DIRECT_PROVIDERS: ["OPENAI_DIRECT", "ANTHROPIC_DIRECT", "GROQ"] as const,
	AI_PROVIDER_METADATA: {},
	isGatewayProvider: () => false,
	isDirectProvider: () => false,
	getProviderDisplayName: (p: string) => p,
	getProviderMetadata: () => undefined,
}));

vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	closeMcpClientSafe: vi.fn(),
}));

vi.mock("@repo/rag/lib/vector-store/capability-store", () => ({
	getCapabilitiesByTenant: vi.fn().mockResolvedValue([]),
	searchCapabilities: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/activities/oauth-tool-ingestion", () => ({
	ingestOAuthIntegrationToolsActivity: vi.fn(),
}));

vi.mock("@repo/mcp-registry", () => ({
	GITHUB_ACCOUNT: { version: "1.0.0" },
	MICROSOFT_TEAMS_ACCOUNT: { version: "1.0.0" },
}));

vi.mock("../src/activities/orchestrator/tools/fabric-ai-tools", () => ({
	getFabricAiTools: vi.fn().mockReturnValue([]),
}));

vi.mock("../src/activities/orchestrator/tools/tool-index", () => ({
	toolIndex: {
		search: mockSearch,
		needsRebuild: mockNeedsRebuild,
		loadFromQdrant: mockLoadFromQdrant,
		getStats: mockGetStats,
		getServerTools: mockGetServerTools,
		getAllEntries: vi.fn().mockReturnValue([]),
	},
}));

let searchAvailableTools: typeof import("../src/activities/orchestrator/tools/search-tools").searchAvailableTools;

describe("searchAvailableTools lexical-first corpus ranking", () => {
	beforeAll(async () => {
		({ searchAvailableTools } = await import(
			"../src/activities/orchestrator/tools/search-tools"
		));
	});

	beforeEach(() => {
		vi.clearAllMocks();
		mockFindMany.mockResolvedValue([]);
		mockNeedsRebuild.mockReturnValue(true);
		mockLoadFromQdrant.mockResolvedValue(true);
		mockGetStats.mockReturnValue({ totalTools: 3, servers: 1 });
		mockGetServerTools.mockReturnValue([]);
	});

	it("returns full-corpus lexical matches without invoking semantic search", async () => {
		mockSearch.mockResolvedValueOnce([
			{
				tool: {
					id: "config-context7:query-docs",
					serverName: "Context7",
					toolName: "query-docs",
					description: "Query docs for a library",
					keywords: [],
					category: "search",
					riskLevel: "low",
					isReadOnly: true,
					configId: "config-context7",
					inputSchema: {
						type: "object",
						properties: { query: { type: "string" } },
					},
					lastUpdated: new Date("2026-01-01"),
				},
				confidence: 0.92,
				matchReason: "Keyword match: context7, docs",
				keywordMatches: ["context7", "docs"],
			},
		]);

		const result = await searchAvailableTools({
			query: "context7 react hooks docs",
			userId: "user-1",
			organizationId: undefined,
		});

		expect(mockSearch).toHaveBeenCalledTimes(1);
		expect(result.semanticSearchUsed).toBe(false);
		expect(result.telemetry?.strategy).toBe("indexed_keyword_shortcut");
		expect(result.results[0]?.serverName).toBe("Context7");
		expect(result.results[0]?.toolName).toBe("query-docs");
		expect(result.results[0]?.confidence).toBe(0.92);
	});
});
