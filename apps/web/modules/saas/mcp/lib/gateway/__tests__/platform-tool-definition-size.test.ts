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
const TOTAL_BUDGET = 36_900;
// Measured after the Fizzy #2991 cut: the largest tool (fabric_instruction_checks) was 1,994 characters, plus ~10% headroom.
const PER_TOOL_BUDGET = 2_190;

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
			.filter(({ size }) => size > PER_TOOL_BUDGET)
			.map(({ name, size }) => `${name}: ${size}`);
		expect(over).toEqual([]);
	});
});
