import { describe, expect, it, vi } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { handleClaudeAgentsFramework } from "@/lib/frameworks/claude-agents";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(async function* () {
		yield { type: "result", result: "Example result" };
	}),
}));

describe("Claude agent framework model IDs", () => {
	it.each([
		[undefined, "claude-sonnet-5-5"],
		["anthropic/claude-opus-5.5", "claude-opus-5-5"],
		["anthropic/claude-sonnet-5.5", "claude-sonnet-5-5"],
		["anthropic/claude-haiku-5.5", "claude-haiku-5-5"],
		["anthropic/claude-sonnet-5", "claude-sonnet-5"],
		["anthropic/claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"],
	])("resolves %s to the direct ID %s", async (selected, direct) => {
		const stream = await handleClaudeAgentsFramework(
			"https://example.com/mcp",
			undefined,
			[{ role: "user", content: "Example request" }],
			"Example instructions",
			undefined,
			selected,
		);
		const reader = stream.getReader();
		while (!(await reader.read()).done) {}
		expect(query).toHaveBeenCalledWith(
			expect.objectContaining({
				options: expect.objectContaining({ model: direct }),
			}),
		);
	});
});
