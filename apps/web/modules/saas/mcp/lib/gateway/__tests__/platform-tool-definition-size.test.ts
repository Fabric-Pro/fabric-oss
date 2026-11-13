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
// Four generic Workspace workflow controls add required pre-call schemas:
// binding action/current timestamps, run inputs/idempotency and bounded history.
// CI measured 55,621; removing 259 description characters leaves 55,362.
// Keep that exact combined allowance, with no extra headroom.
// A step-built workflow's `projectId` on create adds 31: without it a graph
// workflow could not belong to a project, so no project rule reached its runs.
// The generated-diagram marker (Fizzy #2946) adds 172 to the document read and
// write: an agent rewriting a body must know before the call to keep a
// diagram's `%% fabric-visual:` line. 9 of them fit the slack left above.
// The marker's limits add 188 to the write: Fabric restores it only for an
// unchanged diagram body, and an agent must not invent or copy one.
// A diagram's `%% caption:` line (Fizzy #2946) adds 52 to the read and 63 to
// the write: an agent rewriting a body must know the line is the caption.
// fabric_edit_frame_block (Fizzy #3344) adds a required pre-call schema and
// contract: an agent must know before the call that oldText matches once and
// which updatedAt to send. With fabric_get_frame's outline flag that is 894 net,
// after shortening the frame read and update descriptions to make room.
// The Coding Instructions plugin's 7 tools (specs/2026-10-21-ai-artifacts-hub:
// change instructions, rules on demand, the knowledge hub) are called directly
// by a person's coding tool, with descriptions cut to one line each; their
// schemas add 4,024. fabric_list_code_repositories (the workspace layout, §5.7)
// adds 239: the plugin's agent clones the project's repositories from its list.
// fabric_semantic_search adds 333: the plugin's agent asks the project's RAG
// before it walks the code.
// The two context-quality tools add 501 (explicit source/revision inspection)
// and 1,969 (bounded recorded-answer cases, source pins and expectations).
// Both schemas are required before calling; descriptions were shortened by
// 219 characters. Add exactly their measured sizes, without extra headroom.
// Saved context-quality runs (6 tools: 4,206), completed agent-result checks
// (2 tools: 1,277), saved-agent run and schedule controls (6 tools: 3,585),
// and Workspace document reads, project document links and bounded context
// assembly (6 tools: 4,659) add 13,727 of required pre-call schemas and
// scope/revision contracts; tightening existing descriptions offsets 4,789,
// leaving 8,938 net with no extra headroom.
// fabric_list_project_reports (316) and fabric_generate_report (381) add 697:
// one line each to choose the tool, the schemas needed to call it, and where
// instanceId comes from. Owner-only, AI credits, polling and parameter rules
// were moved to the list result, the refusal, the approval card and the
// errors. Add exactly that, with no extra headroom.
// fabric_get_report_content (304) and fabric_update_report_prompt (377) add
// 681: one line each, where instanceId comes from, and the instructions'
// length bound. What to do after a read or a change is said in the result.
// fabric_list_report_templates (322) and fabric_create_project_report (472) add
// 794: one line each, the schemas needed to call them, and where templateId
// comes from. What to connect and what to do next is said in the result.
// A report made from a prompt, with no template, adds 189: the optional prompt
// property, its default template, and tool wording that says what the
// instructions and the effective AI tasks are.
// The four Coding Instructions set tools (specs/2026-11-11-coding-instruction-
// sets: list 240, create 468, update 495, delete 289) add 1,492: one line each
// and the schemas needed to call them; the Fabric Agent manages sets with them.
// Where ids come from and what a refusal means is said in the result.
// fabric_list_project_instructions' optional `set` (a set's slug: only its
// folder's files) adds 81 net, after shortening the set list tool by 5: a
// coding tool in one set's repository must know before the call that it can
// narrow the list to that set.
const CONTEXT_QUALITY_BUDGETS: Readonly<Record<string, number>> = {
	fabric_inspect_context_quality_source: 501,
	fabric_evaluate_context_quality: 1_969,
};
const TOTAL_BUDGET =
	53_244 +
	2_118 +
	31 +
	163 +
	188 +
	115 +
	894 +
	4_024 +
	239 +
	333 +
	501 +
	1_969 +
	8_938 +
	697 +
	681 +
	794 +
	189 +
	1_492 +
	81;
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
						: (CONTEXT_QUALITY_BUDGETS[name] ?? PER_TOOL_BUDGET)),
			)
			.map(({ name, size }) => `${name}: ${size}`);
		expect(over).toEqual([]);
	});
});
