import { describe, expect, it } from "vitest";
import {
	DIRECT_CHAT_MEMORY_FALLBACK_BODY,
	DIRECT_CHAT_MEMORY_PROMPT_AGENT_KEY,
} from "../lib/direct-chat-memory-prompt";
import {
	ORCHESTRATOR_MEMORY_FALLBACK_BODY,
	ORCHESTRATOR_MEMORY_PROMPT_AGENT_KEY,
} from "../lib/orchestrator-memory-prompt";
import { renderTemplate } from "../template-renderer";

const render = async (template: string, variables: Record<string, unknown>) => {
	const result = await renderTemplate({
		format: "HANDLEBARS",
		template,
		variables,
		escape: false,
	});
	expect(result.error).toBeUndefined();
	return result.rendered;
};

const NO_MEMORY = {
	has_memory: false,
	has_preferences: false,
	has_learned_patterns: false,
	has_recalled_conversations: false,
	has_recent_conversations: false,
	has_project_discussions: false,
	has_workspace_discussions: false,
	has_relevant_conversations: false,
};

describe("agent keys", () => {
	it("are the exact strings the seed, the catalog and the activities share", () => {
		// A typo resolves no binding and falls back forever, silently.
		expect(ORCHESTRATOR_MEMORY_PROMPT_AGENT_KEY).toBe(
			"orchestrator_memory_context",
		);
		expect(DIRECT_CHAT_MEMORY_PROMPT_AGENT_KEY).toBe(
			"direct_chat_memory_context",
		);
	});
});

describe("the default Orchestrator memory instructions", () => {
	it("frame a recalled conversation that created a workflow as history to verify", async () => {
		const rendered = await render(ORCHESTRATOR_MEMORY_FALLBACK_BODY, {
			...NO_MEMORY,
			has_memory: true,
			has_recalled_conversations: true,
			has_project_discussions: true,
			project_discussions:
				"- [2026-10-16] Weekly status page: Created a workflow that publishes a status page every Monday and ran it once.",
		});

		expect(rendered).toContain(
			"## Recalled Conversations Are History, Not Current State",
		);
		expect(rendered).toContain(
			"Never report anything as done in this turn because a past conversation says it was done.",
		);
		expect(rendered).toContain("check it now with a tool");
		expect(rendered).toContain(
			"- [2026-10-16] Weekly status page: Created a workflow",
		);
		// The rule comes before the summaries it governs.
		expect(rendered.indexOf("Not Current State")).toBeLessThan(
			rendered.indexOf("Weekly status page"),
		);
	});

	it("place each recalled list under its own heading", async () => {
		const rendered = await render(ORCHESTRATOR_MEMORY_FALLBACK_BODY, {
			...NO_MEMORY,
			has_memory: true,
			has_recalled_conversations: true,
			has_recent_conversations: true,
			recent_conversations: "- [2026-10-15] Recent one: r",
			has_workspace_discussions: true,
			workspace_discussions: "- [2026-10-14] Workspace one: w",
			has_relevant_conversations: true,
			relevant_conversations: "- [2026-10-13] Relevant one: v",
		});

		expect(rendered).toContain("## Recent Conversations\n- [2026-10-15]");
		expect(rendered).toContain(
			"## Related Workspace Discussions\n- [2026-10-14]",
		);
		expect(rendered).toContain("## Relevant Past Conversations");
		expect(rendered).not.toContain("## Related Project Discussions");
	});

	it("keep preferences and learned patterns without the history rule when nothing was recalled", async () => {
		const rendered = await render(ORCHESTRATOR_MEMORY_FALLBACK_BODY, {
			...NO_MEMORY,
			has_memory: true,
			has_preferences: true,
			preferences: "- Response style: concise",
			has_learned_patterns: true,
			learned_patterns: "- Always use tables",
		});

		expect(rendered).toContain("# Orchestrator Memory Context");
		expect(rendered).toContain(
			"## User Preferences\n- Response style: concise",
		);
		expect(rendered).toContain("## MANDATORY User Learned Patterns");
		expect(rendered).toContain("- Always use tables");
		expect(rendered).not.toContain("Not Current State");
	});

	it("render only the capabilities when there is no memory", async () => {
		const rendered = await render(
			ORCHESTRATOR_MEMORY_FALLBACK_BODY,
			NO_MEMORY,
		);

		expect(rendered).not.toContain("# Orchestrator Memory Context");
		expect(rendered).toContain("## Memory-Enhanced Capabilities");
		expect(rendered).toContain(
			"present what it did as something that happened on that date, not as how things stand now",
		);
	});

	it("render without leaving template syntax behind", async () => {
		const rendered = await render(ORCHESTRATOR_MEMORY_FALLBACK_BODY, {
			...NO_MEMORY,
			has_memory: true,
			has_recalled_conversations: true,
			has_recent_conversations: true,
			recent_conversations: "- [2026-10-15] a: b",
		});

		expect(rendered).not.toMatch(/\{\{|\}\}/);
	});
});

describe("the default Direct memory instructions", () => {
	it("frame the fenced session memory as history to verify", async () => {
		const rendered = await render(DIRECT_CHAT_MEMORY_FALLBACK_BODY, {});

		expect(rendered).toContain(
			'<retrieved_context source="session_memory">',
		);
		expect(rendered).toContain("history, not current state");
		expect(rendered).toContain(
			"Never report anything as done in this turn because a past execution did it.",
		);
		expect(rendered).toContain("check it now with a tool");
		expect(rendered).not.toMatch(/\{\{|\}\}/);
	});
});
