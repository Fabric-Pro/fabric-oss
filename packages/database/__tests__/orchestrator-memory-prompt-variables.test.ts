/**
 * The data the `orchestrator_memory_context` prompt is rendered against.
 *
 * `buildMemoryContextPromptVariables` assembles only data; the wording is the
 * Prompt Library's. Rendered here against the seeded default body, so the pair
 * is pinned end to end: an episode that says a workflow was created reaches the
 * model dated, under the rule that it is history to verify with a tool.
 */

import { ORCHESTRATOR_MEMORY_FALLBACK_BODY } from "@repo/utils/orchestrator-memory-prompt";
import { renderTemplate } from "@repo/utils/template-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma/client", () => ({ db: {} }));

import {
	buildMemoryContextPromptVariables,
	type EpisodeSummary,
} from "../prisma/queries/orchestrator-memory";

function episode(overrides: Partial<EpisodeSummary>): EpisodeSummary {
	return {
		id: "episode-example-1",
		conversationId: "conversation-example-1",
		title: "Weekly project status page",
		summary:
			"Created a scheduled workflow that publishes a status page every Monday; ran it once.",
		keyTopics: [],
		userIntents: [],
		outcome: "success",
		messageCount: 4,
		turnCount: 2,
		toolsUsed: [],
		agentsUsed: [],
		conversationStartedAt: new Date("2026-10-16T08:58:00.000Z"),
		conversationEndedAt: new Date("2026-10-16T09:05:00.000Z"),
		projectId: "project-example-1",
		workspaceId: null,
		qdrantPointId: null,
		...overrides,
	};
}

const NO_PREFERENCES = {
	preferences: {},
	recentProjectIds: [],
	recentWorkspaceIds: [],
};

const EMPTY = {
	preferences: NO_PREFERENCES,
	recentEpisodes: [],
	projectEpisodes: [],
	workspaceEpisodes: [],
	relevantEpisodes: [],
};

describe("buildMemoryContextPromptVariables", () => {
	it("dates each recalled episode by when its conversation ended", () => {
		const variables = buildMemoryContextPromptVariables({
			...EMPTY,
			projectEpisodes: [episode({})],
			recentEpisodes: [episode({ conversationEndedAt: null })],
		});

		expect(variables.project_discussions).toBe(
			"- [2026-10-16] Weekly project status page: Created a scheduled workflow that publishes a status page every Monday; ran it once.",
		);
		expect(variables.recent_conversations).toMatch(/^- \[ongoing\] /);
		expect(variables.has_recalled_conversations).toBe(true);
		expect(variables.has_memory).toBe(true);
	});

	it("lists a relevant episode's topics under it", () => {
		const variables = buildMemoryContextPromptVariables({
			...EMPTY,
			relevantEpisodes: [
				episode({ keyTopics: ["workflow", "schedule"] }),
			],
		});

		expect(variables.relevant_conversations).toBe(
			"- [2026-10-16] Weekly project status page: Created a scheduled workflow that publishes a status page every Monday; ran it once.\n  Topics: workflow, schedule",
		);
	});

	it("keeps the last ten learned patterns and only string ones", () => {
		const patterns = Array.from({ length: 12 }, (_, i) => `pattern ${i}`);
		const variables = buildMemoryContextPromptVariables({
			...EMPTY,
			preferences: {
				...NO_PREFERENCES,
				responseStyle: "concise",
				preferences: { learnedPatterns: [...patterns, 42] },
			},
		});

		expect(variables.learned_patterns.split("\n")).toEqual(
			patterns.slice(-10).map((pattern) => `- ${pattern}`),
		);
		expect(variables.preferences).toBe("- Response style: concise");
		expect(variables.has_recalled_conversations).toBe(false);
	});

	it("reports no memory when there is none", () => {
		const variables = buildMemoryContextPromptVariables(EMPTY);

		expect(variables.has_memory).toBe(false);
		expect(variables.has_preferences).toBe(false);
		expect(variables.has_learned_patterns).toBe(false);
	});

	it("with the seeded body, puts an episode that created a workflow under the verify-before-claiming rule", async () => {
		const variables = buildMemoryContextPromptVariables({
			...EMPTY,
			relevantEpisodes: [episode({})],
		});

		const { rendered, error } = await renderTemplate({
			format: "HANDLEBARS",
			template: ORCHESTRATOR_MEMORY_FALLBACK_BODY,
			variables,
			escape: false,
		});

		expect(error).toBeUndefined();
		const rule = rendered.indexOf("History, Not Current State");
		const summary = rendered.indexOf("Created a scheduled workflow");
		expect(rule).toBeGreaterThan(-1);
		expect(summary).toBeGreaterThan(rule);
		expect(rendered).toContain(
			"Never report anything as done in this turn because a past conversation says it was done.",
		);
		expect(rendered).toContain("check it now with a tool");
	});
});
