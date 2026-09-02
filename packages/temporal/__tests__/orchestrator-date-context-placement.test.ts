import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fizzy #2345 — the orchestrator's hand-rolled date context.
 *
 * Temporal workflow code runs in a sandboxed isolate and cannot import
 * `@repo/ai`, so `initialization.ts` cannot call `getCurrentDateContext()`
 * and formats "today" itself. These tests pin the two properties that keep
 * the provider prompt-cache prefix stable:
 *
 *   1. the date is rendered at day granularity (no time-of-day), so two calls
 *      on the same calendar day produce byte-identical prompts; and
 *   2. it is the LAST segment of the system prompt, after every other
 *      enrichment step, mirroring agent-execution-core/context-builder.ts.
 */

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
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	proxyActivities: vi.fn(() => activityStubs),
	patched: vi.fn(() => true),
	workflowInfo: vi.fn(() => ({ unsafe: { isReplaying: false } })),
}));

import { executeInitializationPhase } from "../src/workflows/orchestrator/phases/initialization";
import { createInitialState } from "../src/workflows/orchestrator/types";

const BASE_PROMPT = "Base system prompt";
const POLICY_ADDITIONS = "Policy enrichment additions";
const WORKFLOW_GUIDANCE = "Workflow guidance from connected integrations";
const MEMORY_PROMPT = "Use the user's past preferences and memory.";

const DATE_ONLY_SENTENCE =
	/^Today is (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\.$/;

async function runInitialization() {
	const input = {
		executionId: "exec-1",
		message: "Help me inspect this bug",
		userId: "user-1",
		organizationId: "org-1",
		executionMode: "default",
		history: [],
		systemPrompt: BASE_PROMPT,
		// Truthy so Step 3 runs applyPolicyEnrichment (mocked above).
		policyContext: { policyIds: ["policy-1"] },
	} as any;
	const state = createInitialState(input);
	const result = await executeInitializationPhase(state, input, vi.fn());
	expect(result.success).toBe(true);
	return result.data?.enrichedSystemPrompt ?? "";
}

describe("orchestrator initialization date context", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		activityStubs.preloadResourcesActivity.mockResolvedValue({
			mcpTools: [],
			toolMap: {},
			agents: [],
			loadDurationMs: 5,
			workflowGuidance: WORKFLOW_GUIDANCE,
		});
		activityStubs.loadOrchestratorMemoryActivity.mockResolvedValue({
			preferences: {
				preferences: {},
				recentProjectIds: [],
				recentWorkspaceIds: [],
			},
			memoryContextPrompt: MEMORY_PROMPT,
			relevantEpisodes: [],
			recentEpisodes: [],
		});
		activityStubs.updateRecentActivityActivity.mockResolvedValue(undefined);
		activityStubs.initializeLettaMemory.mockResolvedValue(null);
		activityStubs.getHybridRoutingSuggestions.mockResolvedValue({
			suggestions: [],
			warnings: [],
			stats: {},
		});
		activityStubs.applyPolicyEnrichment.mockResolvedValue({
			blocked: false,
			enrichedMessage: "Help me inspect this bug",
			systemPromptAdditions: POLICY_ADDITIONS,
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

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders the date at day granularity with no time-of-day", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-02T14:37:00.000Z"));

		const prompt = await runInitialization();
		const lastSegment = prompt.split("\n\n").at(-1) ?? "";

		expect(lastSegment).toBe("Today is Wednesday, September 2, 2026.");
		expect(lastSegment).toMatch(DATE_ONLY_SENTENCE);
		expect(prompt).not.toMatch(/\d{1,2}:\d{2} (AM|PM)/);
		expect(prompt).not.toContain("UTC");
	});

	it("keeps the stable prompt content at position 0 and the date last", async () => {
		const prompt = await runInitialization();

		expect(prompt.startsWith(BASE_PROMPT)).toBe(true);

		const dateIndex = prompt.lastIndexOf("Today is ");
		expect(dateIndex).toBeGreaterThan(-1);
		for (const segment of [
			BASE_PROMPT,
			POLICY_ADDITIONS,
			WORKFLOW_GUIDANCE,
			MEMORY_PROMPT,
		]) {
			const index = prompt.indexOf(segment);
			expect(index, `expected "${segment}" in prompt`).toBeGreaterThan(
				-1,
			);
			expect(index, `expected "${segment}" before the date`).toBeLessThan(
				dateIndex,
			);
		}
		// Nothing follows the date sentence.
		expect(prompt.slice(dateIndex)).toMatch(DATE_ONLY_SENTENCE);
	});

	it("keeps the date out of the Fabric basePrompt and after the composed prompt", async () => {
		// Step 4 may replace the whole prompt with Fabric's composedPrompt. The
		// date must not be in what Fabric receives (it would sit inside the
		// composed text, i.e. before later segments) and must still land last.
		const COMPOSED_PREFIX = "[Fabric composed]";
		activityStubs.applyFabricPatternEnrichment.mockImplementation(
			async ({ basePrompt }: { basePrompt: string }) => ({
				fabricAvailable: true,
				composedPrompt: `${COMPOSED_PREFIX}\n\n${basePrompt}`,
				cacheHits: 0,
				components: { pattern: "summarize" },
			}),
		);

		const prompt = await runInitialization();

		const { basePrompt } =
			activityStubs.applyFabricPatternEnrichment.mock.calls[0][0];
		expect(basePrompt).not.toContain("Today is ");

		expect(prompt.startsWith(COMPOSED_PREFIX)).toBe(true);
		const dateIndex = prompt.lastIndexOf("Today is ");
		expect(prompt.indexOf(WORKFLOW_GUIDANCE)).toBeLessThan(dateIndex);
		expect(prompt.indexOf(MEMORY_PROMPT)).toBeLessThan(dateIndex);
		expect(prompt.slice(dateIndex)).toMatch(DATE_ONLY_SENTENCE);
	});

	it("produces an identical prompt for two calls on the same calendar day", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });

		vi.setSystemTime(new Date("2026-09-02T00:01:00.000Z"));
		const morning = await runInitialization();

		vi.setSystemTime(new Date("2026-09-02T23:58:00.000Z"));
		const night = await runInitialization();

		expect(night).toBe(morning);
	});
});
