import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockFindMany = vi.fn();
const mockGetMcpClient = vi.fn();
const mockCloseMcpClientSafe = vi.fn();
const mockGetCapabilitiesByTenant = vi.fn();

// Explicit mocks — importOriginal would load real @repo/database
// (PrismaPg pool) and hang vitest exit (vitest #4373).
vi.mock("@repo/database", () => ({
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
	getAiProviderApiKey: vi.fn().mockResolvedValue({ apiKey: null }),
	updateProviderLastUsed: vi.fn().mockResolvedValue(undefined),
	// Registry hook called by @repo/payments at module init.
	setAiUsageRecorder: vi.fn(),
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
	getMcpClient: mockGetMcpClient,
	closeMcpClientSafe: mockCloseMcpClientSafe,
}));

vi.mock("@repo/rag/lib/vector-store/capability-store", () => ({
	getCapabilitiesByTenant: mockGetCapabilitiesByTenant,
	searchCapabilities: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/activities/oauth-tool-ingestion", () => ({
	ingestOAuthIntegrationToolsActivity: vi.fn(),
}));

vi.mock("@repo/mcp-registry", () => ({
	GITHUB_ACCOUNT: { mcps: [] },
	MICROSOFT_TEAMS_ACCOUNT: { mcps: [] },
}));

let fetchToolsFromExplicitServers: typeof import("../src/activities/orchestrator/tools/search-tools").fetchToolsFromExplicitServers;
let searchAvailableTools: typeof import("../src/activities/orchestrator/tools/search-tools").searchAvailableTools;

describe("explicit MCP server tool fetch", () => {
	beforeAll(async () => {
		({ fetchToolsFromExplicitServers, searchAvailableTools } = await import(
			"../src/activities/orchestrator/tools/search-tools"
		));
	});

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetCapabilitiesByTenant.mockResolvedValue([]);
		mockCloseMcpClientSafe.mockResolvedValue(undefined);
	});

	it("preserves raw inputSchema for explicitly requested server tools", async () => {
		mockFindMany.mockResolvedValue([
			{
				id: "config-context7",
				userId: "user-1",
				organizationId: null,
				enabled: true,
				displayName: "Context7",
				baseUrl: "https://mcp.context7.com/mcp",
				mcpServer: {
					name: "Context7",
					transport: "HTTP",
					defaultUrl: "https://mcp.context7.com/mcp",
				},
			},
		]);

		mockGetMcpClient.mockResolvedValue({
			serverName: "Context7",
			client: {
				tools: async () => ({
					"resolve-library-id": {
						description: "Resolve a library id",
						inputSchema: {
							type: "object",
							properties: {
								libraryName: { type: "string" },
								query: { type: "string" },
							},
							required: ["libraryName", "query"],
						},
					},
				}),
			},
		});

		const result = await fetchToolsFromExplicitServers(
			"user-1",
			undefined,
			["Context7"],
		);

		expect(result).not.toBeNull();
		expect(result?.results).toHaveLength(1);
		expect(result?.results[0]?.toolName).toBe("resolve-library-id");
		expect(result?.results[0]?.inputSchema).toEqual({
			type: "object",
			properties: {
				libraryName: { type: "string" },
				query: { type: "string" },
			},
			required: ["libraryName", "query"],
		});
	});

	it("unwraps jsonSchema-wrapped inputSchema for explicitly requested server tools", async () => {
		mockFindMany.mockResolvedValue([
			{
				id: "config-context7",
				userId: "user-1",
				organizationId: null,
				enabled: true,
				displayName: "Context7",
				baseUrl: "https://mcp.context7.com/mcp",
				mcpServer: {
					name: "Context7",
					transport: "HTTP",
					defaultUrl: "https://mcp.context7.com/mcp",
				},
			},
		]);

		mockGetMcpClient.mockResolvedValue({
			serverName: "Context7",
			client: {
				tools: async () => ({
					"resolve-library-id": {
						description: "Resolve a library id",
						inputSchema: {
							jsonSchema: {
								type: "object",
								properties: {
									libraryName: { type: "string" },
									query: { type: "string" },
								},
								required: ["libraryName", "query"],
							},
						},
					},
				}),
			},
		});

		const result = await fetchToolsFromExplicitServers(
			"user-1",
			undefined,
			["Context7"],
		);

		expect(result?.results[0]?.inputSchema).toEqual({
			type: "object",
			properties: {
				libraryName: { type: "string" },
				query: { type: "string" },
			},
			required: ["libraryName", "query"],
		});
	});

	it("uses originalQuery to enforce explicit server-only results", async () => {
		mockFindMany.mockResolvedValue([
			{
				id: "config-context7",
				userId: "user-1",
				organizationId: null,
				enabled: true,
				displayName: "Context7",
				baseUrl: "https://mcp.context7.com/mcp",
				mcpServer: {
					name: "Context7",
					transport: "HTTP",
					defaultUrl: "https://mcp.context7.com/mcp",
				},
			},
		]);

		mockGetMcpClient.mockResolvedValue({
			serverName: "Context7",
			client: {
				tools: async () => ({
					"resolve-library-id": {
						description: "Resolve a library id",
						inputSchema: {
							type: "object",
							properties: {
								libraryName: { type: "string" },
								query: { type: "string" },
							},
							required: ["libraryName", "query"],
						},
					},
					"query-docs": {
						description: "Query docs",
						inputSchema: {
							type: "object",
							properties: {
								libraryId: { type: "string" },
								query: { type: "string" },
							},
							required: ["libraryId", "query"],
						},
					},
				}),
			},
		});

		const result = await searchAvailableTools({
			query: "Explain React and recommend the best learning path",
			originalQuery:
				"Use Context7 MCP only. Explain what React is and recommend the best learning path.",
			userId: "user-1",
			organizationId: undefined,
			enabledFabricToolIds: [
				"fabric_web_search",
				"fabric_search_and_analyze",
			],
		});

		expect(result.results.length).toBeGreaterThan(0);
		expect(result.results.every((r) => r.serverName === "Context7")).toBe(
			true,
		);
		expect(result.telemetry?.strategy).toBe("explicit_server");
		expect(result.results.map((r) => r.toolName)).toEqual(
			expect.arrayContaining(["resolve-library-id", "query-docs"]),
		);
		expect(result.results.map((r) => r.toolName)).not.toContain(
			"fabric_web_search",
		);
	});
});
