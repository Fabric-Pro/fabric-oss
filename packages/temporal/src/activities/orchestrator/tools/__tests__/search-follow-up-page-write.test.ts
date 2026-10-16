/**
 * A follow-up turn that writes to a page Fabric Agent just built ("add one
 * decision to that page") has to find the page data tools and must not hand
 * the job to Fabric Agent itself.
 *
 * On staging the model searched with `category: "documentation"`. The guess
 * was applied as a filter, so only the RAG tools were left; the agent search
 * then offered Fabric Agent's own registration as a delegation target, the
 * chat delegated the write to itself, and the nested run failed.
 *
 * The tool index, the Fabric catalogue and the agent search are real here;
 * the capability store, embeddings and the database are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	getAgentsWithEmbeddings: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	checkConversationTurnDispatchable: vi.fn(),
	getAgentsWithEmbeddings: hoisted.getAgentsWithEmbeddings,
	updateAgentEmbedding: vi.fn().mockResolvedValue(undefined),
	db: { mCPConfig: { findMany: async () => [] } },
}));
vi.mock("@repo/database/prisma/queries/lib/oauth-app-row", () => ({
	OAUTH_APP_ROW_NAMES: [],
}));
vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbedding: vi.fn(async () => ({
		embedding: [0.1, 0.2],
		model: "m",
	})),
	generateEmbeddings: vi.fn(async () => ({ embeddings: [] })),
}));
vi.mock("@repo/rag/lib/vector-store/capability-store", () => ({
	isCapabilityStoreAvailable: vi.fn(async () => false),
	searchCapabilities: vi.fn(async () => []),
	getCapabilitiesByTenant: vi.fn(async () => []),
	upsertCapabilities: vi.fn(),
	deleteCapabilitiesByServer: vi.fn(),
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
vi.mock("../../../../lib/redis-cache", () => ({
	CacheKeys: { queryEmbedding: () => "q", agentEmbedding: () => "a" },
	CacheTTL: { queryEmbedding: 60, agentEmbedding: 60 },
	RedisCache: {
		get: vi.fn().mockResolvedValue(null),
		set: vi.fn().mockResolvedValue(undefined),
	},
}));

const { searchAvailableTools } = await import("../search-tools");
const { searchAvailableAgents } = await import("../search-agents");

const TENANT = { userId: "user-example-1", organizationId: "org-example-1" };

/** The query the model sent on staging, word for word. */
const STAGING_QUERY =
	"Fabric page data set/update record for existing workspace page add one decision record";

const AGENT = {
	name: "agent",
	displayName: "Agent",
	description: "Writes things down and keeps decision records",
	status: "ACTIVE",
	lastHealthCheck: null,
	metadata: {},
	skills: [],
	limitations: [],
	cachedEmbedding: [0.1, 0.2],
	cachedEmbeddingModel: "m",
};

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a follow-up page write", () => {
	it("finds the page data tools although the model guessed another category", async () => {
		const result = await searchAvailableTools({
			query: STAGING_QUERY,
			category: "documentation",
			limit: 10,
			minConfidence: 0.3,
			enabledMcpConfigIds: [],
			...TENANT,
		});

		expect(result.results.map((r) => r.toolName)).toContain(
			"fabric_page_data_set",
		);
	});

	it("is never offered Fabric Agent itself as an agent to delegate to", async () => {
		hoisted.getAgentsWithEmbeddings.mockResolvedValue([
			{
				...AGENT,
				agentId: "fabric-workspace-assistant",
				name: "Fabric Agent",
			},
			{ ...AGENT, agentId: "fabric-ai", name: "Fabric AI" },
			{ ...AGENT, agentId: "agent-note-taker", name: "Note taker" },
		]);

		const result = await searchAvailableAgents({
			query: STAGING_QUERY,
			...TENANT,
		});

		const offered = result.results.map((r) => r.agentId);
		expect(offered).not.toContain("fabric-workspace-assistant");
		expect(offered).not.toContain("fabric-ai");
		expect(offered).toContain("agent-note-taker");
	});
});
