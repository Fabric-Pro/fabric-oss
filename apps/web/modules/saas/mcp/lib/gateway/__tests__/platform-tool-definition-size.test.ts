/**
 * The platform tool definitions stay small (Fizzy #2991).
 *
 * Many MCP clients resend every tool definition on every request, so on those
 * clients each character of a description or schema here is paid every turn.
 * The definitions had grown to about 64,000 characters (roughly 16k tokens),
 * mostly prose that steered the model in rare cases. Guidance that matters
 * only at one moment belongs in that tool's error or result. The handshake
 * instructions reach gateway clients but not `/mcp` ones, so guidance every
 * client needs stays in the description.
 *
 * A budget that fails names what grew. Raise it only when the new text has to
 * be read before the tool is chosen or called; otherwise move the text.
 */

import { describe, expect, it } from "vitest";
import { PLATFORM_TOOL_DEFINITIONS } from "../platform-tools";

// Measured after the Fizzy #2991 cut: 33,610 characters in total, plus ~10% headroom.
// Raised for the page tools (viewer, data, files, comments, ask, connected reads) and the
// version tools (list, restore, duplicate): 13 + 3 tools that a page or the agent reads
// before it calls, about 5,200 characters. Measured 42,149, plus ~10% headroom.
// The assigned-item and snapshot readers add 1,137 and 1,053 characters of
// required pre-call contracts; exact sprint selection adds 872 to review config.
// CI measured 53,042 before the document-base contract (Fizzy #2946), which
// adds 21 for the read and 181 for the write. Keep only that combined allowance.
const TOTAL_BUDGET = 53_244;
// The complete bounded sprint config makes configure-story-review the largest
// pre-call schema at 2,334 characters. Other tools retain the original cap below.
const PER_TOOL_BUDGET = 2_190;
const SPRINT_CONFIG_BUDGET = 2_334;

/**
 * Name, description and input schema: the same measure the budgets were set
 * with. Annotations, which clients are also sent, are not counted.
 */
function serializedSize(tool: (typeof PLATFORM_TOOL_DEFINITIONS)[number]) {
	return JSON.stringify({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
	}).length;
}

describe("platform tool definition size", () => {
	it("measures every tool, so the budgets cannot pass on an empty list", () => {
		expect(PLATFORM_TOOL_DEFINITIONS.length).toBeGreaterThan(40);
	});

	it("keeps the serialized total within budget", () => {
		const total = PLATFORM_TOOL_DEFINITIONS.reduce(
			(sum, tool) => sum + serializedSize(tool),
			0,
		);
		expect(total).toBeLessThanOrEqual(TOTAL_BUDGET);
	});

	it("keeps each tool within its cap", () => {
		const over = PLATFORM_TOOL_DEFINITIONS.map((tool) => ({
			name: tool.name,
			size: serializedSize(tool),
		}))
			.filter(
				({ name, size }) =>
					size >
					(name === "fabric_page_configure_story_review"
						? SPRINT_CONFIG_BUDGET
						: PER_TOOL_BUDGET),
			)
			.map(({ name, size }) => `${name}: ${size}`);
		expect(over).toEqual([]);
	});
});
