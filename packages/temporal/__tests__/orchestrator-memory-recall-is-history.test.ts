/**
 * A recalled conversation is history, not current state.
 *
 * A user asked the Orchestrator for a weekly status page; the workflow it set
 * up was deleted later that day. Asked again, the assistant answered "Done — I
 * previously set this up ... Also ran once immediately" with no tool call: the
 * memory context listed the earlier conversation's summary as a plain
 * statement, and the model reported it as what is true now.
 *
 * These tests drive the real memory activity (real data assembly, real Prompt
 * Library resolution with nothing bound, so the seeded default body) into the
 * real initialization phase, and pin that the system prompt the model receives
 * frames that summary as history to check with a tool before reporting it —
 * and never as done in this turn.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	getOrchestratorMemoryPreferences: vi.fn(),
	getRecentEpisodes: vi.fn(),
	buildOrchestratorMemoryContext: vi.fn(),
	getBoundPromptForAgent: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		buildMemoryContextPromptVariables:
			actual.buildMemoryContextPromptVariables,
		...db,
	};
});

vi.mock("@repo/ai", () => ({
	embed: vi.fn(),
	getAIEmbeddingModel: vi.fn(),
}));

vi.mock("@repo/rag/lib/vector-store", () => ({
	searchSimilarEpisodes: vi.fn().mockResolvedValue([]),
	storeEpisodeEmbedding: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const activityStubs = vi.hoisted(() => ({
	preloadResourcesActivity: vi.fn(),
	loadOrchestratorMemoryActivity: vi.fn(),
	updateRecentActivityActivity: vi.fn(),
	initializeLettaMemory: vi.fn(),
	getHybridRoutingSuggestions: vi.fn(),
	applyPolicyEnrichment: vi.fn(),
	applyFabricPatternEnrichment: vi.fn(),
	loadInstanceMemoryActivity: vi.fn(),
	createSandboxActivity: vi.fn(),
	updateWeaveExecutionActivity: vi.fn(),
	getProjectMetadataActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	proxyActivities: vi.fn(() => activityStubs),
	patched: vi.fn(() => true),
	workflowInfo: vi.fn(() => ({ unsafe: { isReplaying: false } })),
}));

import { loadOrchestratorMemoryActivity } from "../src/activities/orchestrator-memory/index";
import { executeInitializationPhase } from "../src/workflows/orchestrator/phases/initialization";
import {
	createInitialState,
	type OrchestratorWorkflowInput,
} from "../src/workflows/orchestrator/types";

const REQUEST =
	"Every Monday at 08:00 Europe/London, write a short HTML status page for this project and publish it as an artifact here. Run it once now too.";

const DELETED_WORKFLOW_EPISODE = {
	id: "episode-example-1",
	conversationId: "conversation-example-1",
	title: "Weekly project status page",
	summary:
		"Created a scheduled workflow that writes an HTML status page every Monday at 08:00 Europe/London and publishes it as an artifact; ran it once immediately.",
	keyTopics: ["workflow", "schedule", "status page"],
	userIntents: ["schedule a weekly status page"],
	outcome: "success",
	messageCount: 4,
	turnCount: 2,
	toolsUsed: ["create_workflow", "run_workflow"],
	agentsUsed: [],
	conversationStartedAt: new Date("2026-10-16T08:58:00.000Z"),
	conversationEndedAt: new Date("2026-10-16T09:05:00.000Z"),
	projectId: "project-example-1",
	workspaceId: null,
	qdrantPointId: "point-example-1",
};

const EMPTY_PREFERENCES = {
	preferences: {},
	recentProjectIds: [],
	recentWorkspaceIds: [],
};

const MEMORY_INPUT = {
	userId: "user-example-1",
	organizationId: "org-example-1",
	projectId: "project-example-1",
	currentQuery: REQUEST,
};

const RULE_HEADING = "## Recalled Conversations Are History, Not Current State";
const NOT_DONE_THIS_TURN =
	"Never report anything as done in this turn because a past conversation says it was done.";
const CHECK_WITH_A_TOOL = "check it now with a tool";

beforeEach(() => {
	vi.clearAllMocks();
	db.getOrchestratorMemoryPreferences.mockResolvedValue(EMPTY_PREFERENCES);
	db.getRecentEpisodes.mockResolvedValue([DELETED_WORKFLOW_EPISODE]);
	db.buildOrchestratorMemoryContext.mockResolvedValue({
		preferences: EMPTY_PREFERENCES,
		recentEpisodes: [DELETED_WORKFLOW_EPISODE],
		projectEpisodes: [DELETED_WORKFLOW_EPISODE],
		workspaceEpisodes: [],
		relevantEpisodes: [DELETED_WORKFLOW_EPISODE],
	});
	db.getBoundPromptForAgent.mockResolvedValue(null);
});

describe("loadOrchestratorMemoryActivity", () => {
	it("frames a recalled episode that created a workflow as history to verify", async () => {
		const { memoryContextPrompt } =
			await loadOrchestratorMemoryActivity(MEMORY_INPUT);

		expect(memoryContextPrompt).toContain(RULE_HEADING);
		expect(memoryContextPrompt).toContain(NOT_DONE_THIS_TURN);
		expect(memoryContextPrompt).toContain(CHECK_WITH_A_TOOL);
		expect(memoryContextPrompt).toContain(
			"- [2026-10-16] Weekly project status page: Created a scheduled workflow",
		);
		// The rule precedes every summary it governs.
		expect(memoryContextPrompt.indexOf(RULE_HEADING)).toBeLessThan(
			memoryContextPrompt.indexOf("Created a scheduled workflow"),
		);
	});

	it("resolves the wording from the Prompt Library for the run's scope", async () => {
		db.getBoundPromptForAgent.mockResolvedValue({
			format: "HANDLEBARS",
			version: {
				version: 3,
				content:
					"Organization memory rules.\n{{#if has_project_discussions}}{{{project_discussions}}}{{/if}}",
			},
		});

		const { memoryContextPrompt } =
			await loadOrchestratorMemoryActivity(MEMORY_INPUT);

		expect(db.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "orchestrator_memory_context",
				documentType: "GENERAL",
				userId: "user-example-1",
				organizationId: "org-example-1",
				projectId: "project-example-1",
			}),
		);
		expect(memoryContextPrompt).toBe(
			"Organization memory rules.\n- [2026-10-16] Weekly project status page: Created a scheduled workflow that writes an HTML status page every Monday at 08:00 Europe/London and publishes it as an artifact; ran it once immediately.",
		);
	});
});

describe("orchestrator initialization with only recalled memory", () => {
	beforeEach(() => {
		activityStubs.preloadResourcesActivity.mockResolvedValue({
			mcpTools: [],
			toolMap: {},
			agents: [],
			loadDurationMs: 5,
		});
		activityStubs.updateRecentActivityActivity.mockResolvedValue(undefined);
		activityStubs.initializeLettaMemory.mockResolvedValue(null);
		activityStubs.getHybridRoutingSuggestions.mockResolvedValue({
			suggestions: [],
			warnings: [],
			stats: {},
		});
		activityStubs.applyFabricPatternEnrichment.mockResolvedValue({
			fabricAvailable: false,
			composedPrompt: "",
			cacheHits: 0,
			components: {},
		});
		activityStubs.loadInstanceMemoryActivity.mockResolvedValue({
			fileCount: 0,
			memoryPrompt: "",
		});
		activityStubs.getProjectMetadataActivity.mockResolvedValue(null);
	});

	it("gives the model the rule that a recalled outcome is not done in this turn", async () => {
		activityStubs.loadOrchestratorMemoryActivity.mockResolvedValue(
			await loadOrchestratorMemoryActivity(MEMORY_INPUT),
		);
		const input: OrchestratorWorkflowInput = {
			executionId: "exec-example-1",
			message: REQUEST,
			userId: "user-example-1",
			organizationId: "org-example-1",
			projectId: "project-example-1",
			executionMode: "balanced",
			history: [],
		};
		const state = createInitialState(input);

		const result = await executeInitializationPhase(state, input, vi.fn());

		expect(result.success).toBe(true);
		const systemPrompt = result.data?.enrichedSystemPrompt ?? "";
		expect(systemPrompt).toContain("Created a scheduled workflow");
		expect(systemPrompt).toContain(RULE_HEADING);
		expect(systemPrompt).toContain(NOT_DONE_THIS_TURN);
		expect(systemPrompt).toContain(CHECK_WITH_A_TOOL);
	});
});
