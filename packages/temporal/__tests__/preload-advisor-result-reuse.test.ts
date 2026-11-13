import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@repo/database", () => {
	const model = {
		findUnique: async () => null,
		findFirst: async () => null,
		findMany: async () => [],
	};
	return {
		db: new Proxy({}, { get: () => model }),
		loadProjectDatabricksKnowledgeBinding: vi.fn().mockResolvedValue(null),
	};
});
vi.mock("../src/activities/advisor-result-reuse", () => ({
	loadAdvisorStoredResults: mocks.load,
}));
vi.mock("../src/activities/shared/databricks-knowledge", () => ({
	buildDatabricksKnowledgeToolDefinition: vi.fn(),
	databricksKnowledgeToolName: vi.fn(),
	loadAgentDatabricksBindings: vi.fn().mockResolvedValue([]),
	mergeDatabricksBindings: () => [],
}));
vi.mock("@repo/mcp-registry", () => ({
	GITHUB_ACCOUNT: { id: "github", mcps: [] },
	MICROSOFT_TEAMS_ACCOUNT: { id: "teams", mcps: [] },
	getAlwaysEnabledWorkflowGuidance: () => "",
	getGuidanceByServerName: () => undefined,
}));

import { preloadResourcesActivity } from "../src/activities/orchestrator/preload/preload-resources";

const scope = { userId: "example-user", organizationId: "example-org" };
beforeEach(() => {
	vi.clearAllMocks();
});
describe("optional stored-result preload contract", () => {
	it("keeps the old output shape and performs no reads on old input", async () => {
		const result = await preloadResourcesActivity(scope);
		expect(mocks.load).not.toHaveBeenCalled();
		expect(result).not.toHaveProperty("advisorStoredResults");
	});
	it("uses outer server-owned scope and returns the optional listing", async () => {
		const listing = [
			{
				ref: "s:example-row",
				tool: "code_tree",
				storedAt: "2026-01-01",
				sizeBytes: 4,
				excerpt: "text",
			},
		];
		mocks.load.mockResolvedValue(listing);
		const result = await preloadResourcesActivity({
			...scope,
			advisorResultReuse: {
				conversationId: "example-chat",
				turnId: "example-turn",
				userId: "example-forged",
				organizationId: "example-forged",
			} as never,
		});
		expect(mocks.load).toHaveBeenCalledExactlyOnceWith({
			...scope,
			conversationId: "example-chat",
			turnId: "example-turn",
		});
		expect(result.advisorStoredResults).toBe(listing);
	});
});
