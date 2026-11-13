import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	preload: vi.fn(),
	memory: vi.fn(),
	letta: vi.fn(),
	routing: vi.fn(),
	enrichment: vi.fn(),
}));
vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	proxyActivities: vi.fn(() => ({
		preloadResourcesActivity: mocks.preload,
		loadOrchestratorMemoryActivity: mocks.memory,
		initializeLettaMemory: mocks.letta,
		getHybridRoutingSuggestions: mocks.routing,
		applyFabricPatternEnrichment: mocks.enrichment,
		updateRecentActivityActivity: vi.fn(),
	})),
	patched: vi.fn(() => true),
	workflowInfo: vi.fn(() => ({ unsafe: { isReplaying: false } })),
}));

import { executeInitializationPhase } from "../src/workflows/orchestrator/phases/initialization";
import { createInitialState } from "../src/workflows/orchestrator/types";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.preload.mockResolvedValue({
		mcpTools: [],
		toolMap: {},
		agents: [],
		workflowGuidance: "",
		loadDurationMs: 1,
	});
	mocks.memory.mockResolvedValue({
		preferences: {},
		memoryContextPrompt: "",
		relevantEpisodes: [],
		recentEpisodes: [],
	});
	mocks.letta.mockResolvedValue(null);
	mocks.routing.mockResolvedValue({
		suggestions: [],
		warnings: [],
		stats: {},
	});
	mocks.enrichment.mockResolvedValue({
		fabricAvailable: false,
		composedPrompt: "",
		components: {},
	});
});
describe("reuse input at the existing initialization command", () => {
	it.each([false, true])(
		"sends optional preload scope only for the captured decision %s",
		async (enabled) => {
			const input = {
				executionId: "example-run",
				userId: "example-user",
				organizationId: "example-org",
				conversationId: "example-chat",
				turnId: "example-turn",
				message: "Read",
				executionMode: "balanced" as const,
				history: [],
			};
			const state = createInitialState(input);
			state.advisorResultReuseEnabled = enabled;
			const result = await executeInitializationPhase(
				state,
				input,
				vi.fn(),
			);
			expect(result.success).toBe(true);
			expect(mocks.preload).toHaveBeenCalledTimes(1);
			const args = mocks.preload.mock.calls[0][0];
			expect(args).toMatchObject({
				userId: input.userId,
				organizationId: input.organizationId,
			});
			if (enabled) {
				expect(args.advisorResultReuse).toEqual({
					conversationId: input.conversationId,
					turnId: input.turnId,
				});
			} else {
				expect(args).not.toHaveProperty("advisorResultReuse");
			}
		},
	);
});
