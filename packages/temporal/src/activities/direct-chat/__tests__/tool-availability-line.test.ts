import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeToolAvailability } from "../tool-availability-line";

/**
 * The workflow retries a failed tools-bound turn with tools disabled. The
 * retry used to be told "No tools connected. Suggest the user connect tools
 * in Settings." — so it sent users to Settings for tools that were connected
 * and had merely failed (Fizzy #2040, review F4).
 */
describe("describeToolAvailability", () => {
	it("tells a turn with tools to use them", () => {
		expect(describeToolAvailability({ toolsEnabled: true })).toMatch(
			/You have access to tools/,
		);
	});

	it("keeps the Settings hint for a user with nothing connected", () => {
		expect(describeToolAvailability({ toolsEnabled: false })).toMatch(
			/No tools connected/,
		);
	});

	it("tells the degraded retry the tools failed, with the reason", () => {
		const line = describeToolAvailability({
			toolsEnabled: false,
			forceDisableTools: true,
			toolFailureSummary: "MCP server rejected the tool schema",
		});

		expect(line).not.toMatch(/No tools connected/);
		expect(line).toMatch(/failed earlier in this turn/);
		expect(line).toMatch(/MCP server rejected the tool schema/);
		expect(line).toMatch(/Do not tell them to connect tools/);
	});

	it("stays honest when the workflow could not pass a reason", () => {
		// Histories recorded before `direct-chat-honest-no-tools-retry-v1`
		// replay the retry without a summary.
		const line = describeToolAvailability({
			toolsEnabled: false,
			forceDisableTools: true,
		});

		expect(line).not.toMatch(/No tools connected/);
		expect(line).toMatch(/ARE connected/);
	});

	it("bounds a very long failure summary", () => {
		const line = describeToolAvailability({
			toolsEnabled: false,
			forceDisableTools: true,
			toolFailureSummary: "x".repeat(5_000),
		});

		expect(line.length).toBeLessThan(1_000);
	});
});

describe("degraded retry wiring", () => {
	const activity = readFileSync(
		join(process.cwd(), "src/activities/direct-chat/ai-execution.ts"),
		"utf-8",
	);
	const workflow = readFileSync(
		join(process.cwd(), "src/workflows/direct-chat.ts"),
		"utf-8",
	);

	it("builds the tools line from the helper, not the old literal", () => {
		expect(activity).toMatch(/\$\{describeToolAvailability\(\{/);
		expect(activity).not.toMatch(
			/"- No tools connected\. Suggest the user connect tools in Settings\."\}/,
		);
	});

	it("flags an answer that came from the degraded retry", () => {
		expect(activity).toMatch(
			/input\.forceDisableTools\s*\?\s*\{\s*toolsFailedThisTurn: \{/,
		);
	});

	it("passes the first failure to the retry behind a patch marker", () => {
		expect(workflow).toMatch(
			/const honestNoToolsRetry = patched\(\s*"direct-chat-honest-no-tools-retry-v1",?\s*\);/,
		);
		expect(workflow).toMatch(/toolFailureSummary: firstError,/);
		// The unpatched branch must stay the pre-marker call.
		expect(workflow).toMatch(
			/: await executeDirectChatActivity\(\s*\{ \.\.\.input, ragContext, forceDisableTools: true \},/,
		);
	});
});
