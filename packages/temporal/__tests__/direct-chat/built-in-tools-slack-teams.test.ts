/**
 * Tests for the search_slack_messages and search_teams_messages Fabric tool
 * factories in direct-chat built-in tools. Verifies:
 *
 *  - Each factory is registered when its ID appears in `enabledFabricToolIds`.
 *  - Each factory calls the corresponding live-search activity with the right
 *    inputs (projectId, query, userId, organizationId, clamped limit).
 *  - The factories degrade gracefully when no project is attached.
 *  - The auto-enable path (no `enabledFabricToolIds` provided) wires both
 *    new tools when a `projectId` is present, and does NOT wire them when
 *    no `projectId` is attached.
 *  - The explicit-empty contract is preserved (`enabledFabricToolIds: []`
 *    returns an empty record).
 *
 * All heavy upstream modules (`@repo/ai`, `@repo/database`, search/storage
 * stubs) are mocked because ESM evaluation of `built-in-tools.ts` pulls them
 * in at import time. The new factories under test only need
 * `searchProjectSlackMessages` and `searchProjectTeamsMessages` mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const searchProjectSlackMessagesMock = vi.fn();
const searchProjectTeamsMessagesMock = vi.fn();

vi.mock("@repo/ai", () => ({
	tool: (def: unknown) => def,
}));

vi.mock("@repo/database", () => ({
	canCreateProjectStory: vi.fn(),
	db: {
		organization: { findUnique: vi.fn() },
		userStory: { update: vi.fn() },
	},
	getMergedSearchProviderConfigs: vi.fn().mockResolvedValue([]),
	getSearchProviderConfig: vi.fn(),
	resolveModelWithCredentials: vi.fn(),
}));

vi.mock("@repo/search", () => ({
	createProvider: vi.fn(),
}));

vi.mock("@repo/storage", () => ({
	uploadFile: vi.fn(),
}));

vi.mock("../../src/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: vi.fn(),
}));

vi.mock("../../src/activities/orchestrator/utils", () => ({
	jsonSchemaToZod: () => ({}),
}));

// Surface a minimal catalog that includes our two new tool IDs plus
// project_rag_query (for parity assertions). The factory only reads
// `name` + `inputSchema` from each entry, so a thin stub is enough.
vi.mock("../../src/activities/orchestrator/tools/fabric-ai-tools", () => ({
	getAllFabricAiTools: () => [
		{
			name: "project_rag_query",
			description: "stub",
			inputSchema: { type: "object", properties: {} },
		},
		{
			name: "search_slack_messages",
			description: "stub-slack",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
			},
		},
		{
			name: "search_teams_messages",
			description: "stub-teams",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
			},
		},
	],
}));

// The factory reads tool definitions through `getFabricToolDefinitionMap`,
// which converts the catalog into a name→definition map. Stub it so the
// catalog entries above are visible to the factory under test.
vi.mock("../../src/activities/shared/fabric-content-tools", () => ({
	getFabricToolDefinitionMap: (
		tools: Array<{
			name: string;
			description?: string;
			inputSchema?: Record<string, unknown>;
		}>,
	) => new Map(tools.map((t) => [t.name, t])),
}));

vi.mock("../../src/activities/shared/frame-service", () => ({
	createFirstClassFrame: vi.fn(),
	getFirstClassFrame: vi.fn(),
	listFirstClassFrames: vi.fn(),
	shareFirstClassFrame: vi.fn(),
	updateFirstClassFrame: vi.fn(),
}));

vi.mock("../../src/activities/direct-chat/rag-retrieval", () => ({
	retrieveWorkspaceDocumentsActivity: vi.fn(),
}));

// The factories under test lazy-import these modules. Returning the same
// mock fn instance on every dynamic import means assertions on call args
// reflect whatever the factory passed in.
vi.mock("../../src/activities/search-project-slack-messages", () => ({
	searchProjectSlackMessages: searchProjectSlackMessagesMock,
}));

vi.mock("../../src/activities/search-project-teams-messages", () => ({
	searchProjectTeamsMessages: searchProjectTeamsMessagesMock,
}));

// The project_rag_query factory pulls retrieveProjectContextsActivity via
// dynamic import; stub it so auto-enable tests don't blow up touching
// neighbouring branches.
vi.mock("../../src/activities/project-metadata", () => ({
	retrieveProjectContextsActivity: vi.fn().mockResolvedValue({
		context: "",
		chunkCount: 0,
	}),
}));

// `createCodeSearchTool` and `createSymbolSearchTool` live inline in
// `built-in-tools.ts`. Auto-enable invokes them when projectId is set;
// each starts with a `getProjectCodeIndex`/related DB read against the
// `@repo/database` mock above, which returns `undefined` and short-circuits
// the tool body — no extra mocking required.

import { createBuiltInTools } from "../../src/activities/direct-chat/built-in-tools";

interface ToolShape {
	description: string;
	inputSchema: unknown;
	execute: (args: Record<string, unknown>) => Promise<unknown>;
}

const BASE_CTX = {
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project-1",
};

describe("createBuiltInTools — Slack/Teams live-search tools", () => {
	beforeEach(() => {
		searchProjectSlackMessagesMock.mockReset();
		searchProjectTeamsMessagesMock.mockReset();
	});

	describe("auto-enable path (no enabledFabricToolIds)", () => {
		it("includes search_slack_messages and search_teams_messages when a projectId is attached", async () => {
			const tools = await createBuiltInTools(BASE_CTX);

			expect(tools).toHaveProperty("search_slack_messages");
			expect(tools).toHaveProperty("search_teams_messages");
			expect(tools).toHaveProperty("project_rag_query");
		});

		it("omits both tools when no projectId is attached", async () => {
			const tools = await createBuiltInTools({
				userId: "user-1",
				organizationId: "org-1",
			});

			expect(tools).not.toHaveProperty("search_slack_messages");
			expect(tools).not.toHaveProperty("search_teams_messages");
		});
	});

	describe("explicit enabledFabricToolIds path", () => {
		it("returns {} when enabledFabricToolIds is empty (existing contract preserved)", async () => {
			const tools = await createBuiltInTools({
				...BASE_CTX,
				enabledFabricToolIds: [],
			});

			expect(tools).toEqual({});
		});

		it("registers search_slack_messages when its ID is in the list", async () => {
			const tools = await createBuiltInTools({
				...BASE_CTX,
				enabledFabricToolIds: ["search_slack_messages"],
			});

			expect(tools).toHaveProperty("search_slack_messages");
			expect(tools).not.toHaveProperty("search_teams_messages");
		});

		it("registers search_teams_messages when its ID is in the list", async () => {
			const tools = await createBuiltInTools({
				...BASE_CTX,
				enabledFabricToolIds: ["search_teams_messages"],
			});

			expect(tools).toHaveProperty("search_teams_messages");
			expect(tools).not.toHaveProperty("search_slack_messages");
		});
	});

	describe("search_slack_messages factory behaviour", () => {
		it("invokes searchProjectSlackMessages with the supplied query, clamped limit, and tenant context", async () => {
			searchProjectSlackMessagesMock.mockResolvedValueOnce({
				messages: [],
				totalCount: 0,
				query: "auth",
				searchedChannels: [],
				errors: [],
			});

			const tools = (await createBuiltInTools({
				...BASE_CTX,
				enabledFabricToolIds: ["search_slack_messages"],
			})) as { search_slack_messages: ToolShape };

			await tools.search_slack_messages.execute({
				query: "auth",
				limit: 200, // out of range — should clamp to 50
			});

			expect(searchProjectSlackMessagesMock).toHaveBeenCalledTimes(1);
			expect(searchProjectSlackMessagesMock).toHaveBeenCalledWith({
				projectId: "project-1",
				query: "auth",
				userId: "user-1",
				organizationId: "org-1",
				limit: 50,
			});
		});

		it("defaults limit to 15 when omitted", async () => {
			searchProjectSlackMessagesMock.mockResolvedValueOnce({
				messages: [],
				totalCount: 0,
				query: "auth",
				searchedChannels: [],
				errors: [],
			});

			const tools = (await createBuiltInTools({
				...BASE_CTX,
				enabledFabricToolIds: ["search_slack_messages"],
			})) as { search_slack_messages: ToolShape };

			await tools.search_slack_messages.execute({ query: "auth" });

			expect(searchProjectSlackMessagesMock).toHaveBeenCalledWith(
				expect.objectContaining({ limit: 15 }),
			);
		});

		it("returns an error and does NOT call the activity when no projectId is attached", async () => {
			const tools = (await createBuiltInTools({
				userId: "user-1",
				organizationId: "org-1",
				enabledFabricToolIds: ["search_slack_messages"],
			})) as { search_slack_messages: ToolShape };

			const result = await tools.search_slack_messages.execute({
				query: "auth",
			});

			expect(result).toEqual({
				error: "No project is attached to this chat.",
			});
			expect(searchProjectSlackMessagesMock).not.toHaveBeenCalled();
		});
	});

	describe("search_teams_messages factory behaviour", () => {
		it("invokes searchProjectTeamsMessages with the supplied query, clamped limit, and tenant context", async () => {
			searchProjectTeamsMessagesMock.mockResolvedValueOnce({
				messages: [],
				totalCount: 0,
				query: "auth",
				searchedChats: [],
				errors: [],
			});

			const tools = (await createBuiltInTools({
				...BASE_CTX,
				enabledFabricToolIds: ["search_teams_messages"],
			})) as { search_teams_messages: ToolShape };

			await tools.search_teams_messages.execute({
				query: "auth",
				limit: 0, // out of range — should clamp to 1
			});

			expect(searchProjectTeamsMessagesMock).toHaveBeenCalledTimes(1);
			expect(searchProjectTeamsMessagesMock).toHaveBeenCalledWith({
				projectId: "project-1",
				query: "auth",
				userId: "user-1",
				organizationId: "org-1",
				limit: 1,
			});
		});

		it("returns an error and does NOT call the activity when no projectId is attached", async () => {
			const tools = (await createBuiltInTools({
				userId: "user-1",
				organizationId: "org-1",
				enabledFabricToolIds: ["search_teams_messages"],
			})) as { search_teams_messages: ToolShape };

			const result = await tools.search_teams_messages.execute({
				query: "auth",
			});

			expect(result).toEqual({
				error: "No project is attached to this chat.",
			});
			expect(searchProjectTeamsMessagesMock).not.toHaveBeenCalled();
		});
	});
});
