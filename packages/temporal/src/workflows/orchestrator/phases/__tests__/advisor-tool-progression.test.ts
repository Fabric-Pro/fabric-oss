/**
 * Tool progression in the Advisor's iterative loop: whether each tool call
 * leaves the model able to take the next useful step.
 *
 * Runs the real `executeIterativePhase` with the workflow SDK and the activity
 * proxy mocked (the `prompt-audit-patch` harness), and scripts the model turn
 * by turn. Every `patched()` marker is ON — a run recorded today — unless a
 * test turns one off to pin what a history recorded before it replays as.
 *
 * Each case names what the model must still be able to see or do after a
 * tool call (ordinary turns are pinned in `advisor-baseline-turns.test.ts`):
 *   - a document page that would not fit keeps its pagination fields;
 *   - a loaded skill survives history pruning;
 *   - a repeated, identical observation is labelled as such;
 *   - a search that finds nothing ends in a truthful answer;
 *   - the stub-catalog prompt does not promise schemas outlive the turn.
 * Repository paging and read-failure reporting are activity-side and live in
 * `__tests__/orchestrator/code-search-handler-progression.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const activities = new Map<string, ReturnType<typeof vi.fn>>();
	const stub = (name: string) => {
		let fn = activities.get(name);
		if (!fn) {
			fn = vi.fn();
			activities.set(name, fn);
		}
		return fn;
	};
	return {
		stub,
		resetAll: () => {
			for (const fn of activities.values()) {
				fn.mockReset();
			}
		},
		/** Markers a test switches off to replay an older history. */
		off: new Set<string>(),
	};
});

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: vi.fn((id: string) => !mocks.off.has(id)),
	proxyActivities: vi.fn(
		() =>
			new Proxy({}, { get: (_target, name) => mocks.stub(String(name)) }),
	),
	workflowInfo: vi.fn(() => ({
		runId: "test-run-id",
		unsafe: { isReplaying: false },
	})),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import { TOOL_RESULTS } from "../../orchestrator-config";
import {
	DISCOVER_REPO_TOOLS,
	FILE_TEXT,
	finalResponse,
	installDefaultStubs,
	LONG_DOC_BODY,
	preloaded,
	runTurn,
	SKILL_BODY,
	type Step,
	slackResult,
	toolMessage,
} from "./advisor-scenario-harness";

beforeEach(() => {
	installDefaultStubs(mocks);
});

// ---------------------------------------------------------------------------
// R1 — a page that does not fit keeps its pagination.
// ---------------------------------------------------------------------------

/** Read the long document, then follow nextOffset if the model can see it. */
const READ_LONG_DOC_THEN_NEXT_PAGE: Step[] = [
	{
		calls: [
			{
				name: "fabric_get_project_document",
				args: { document: "doc-long" },
			},
		],
	},
	(history) => {
		const tools = history.filter((m) => m.role === "tool");
		const last = tools[tools.length - 1]?.content ?? "";
		const next = last.match(/"nextOffset":\s*(\d+)/);
		return next
			? {
					calls: [
						{
							name: "fabric_get_project_document",
							args: {
								document: "doc-long",
								offset: Number(next[1]),
							},
						},
					],
				}
			: { answer: "I cannot tell where the next part starts." };
	},
	{ answer: "Read both parts." },
];

describe("R1: a document page keeps its way to the next page", () => {
	it("a default read fits the loop's cap and shows truncated/nextOffset", async () => {
		const { seen } = await runTurn(mocks, {
			message: "Summarize the PRD.",
			steps: READ_LONG_DOC_THEN_NEXT_PAGE,
		});
		const first = toolMessage(seen, 1, "call-1-0");
		expect(first.length).toBeLessThanOrEqual(TOOL_RESULTS.maxChars);
		expect(first).toContain('"truncated":true');
		expect(first).toMatch(/"nextOffset":\d+/);
		expect(mocks.stub("summarizeLargeToolResult")).not.toHaveBeenCalled();
	});

	it("the follow-up read returns the next, non-overlapping part", async () => {
		const { seen } = await runTurn(mocks, {
			message: "Summarize the PRD.",
			steps: READ_LONG_DOC_THEN_NEXT_PAGE,
		});
		expect(seen).toHaveLength(3);
		const first = JSON.parse(toolMessage(seen, 2, "call-1-0"));
		const second = JSON.parse(toolMessage(seen, 2, "call-2-0"));
		expect(second.offset).toBe(first.offset + first.returnedLength);
		expect(
			LONG_DOC_BODY.slice(second.offset).startsWith(second.content),
		).toBe(true);
	});

	it("an over-cap result that is summarized keeps its continuation fields", async () => {
		const { seen } = await runTurn(mocks, {
			message: "List every record.",
			preload: preloaded(
				["example_list_records"],
				"cfg-records",
				"Records",
			),
			enabledMcpConfigIds: ["cfg-records"],
			steps: [
				{ calls: [{ name: "example_list_records", args: {} }] },
				{ answer: "Listed the first page." },
			],
		});
		expect(mocks.stub("summarizeLargeToolResult")).toHaveBeenCalledTimes(1);
		const shown = toolMessage(seen, 1, "call-1-0");
		expect(shown).toContain("Condensed summary of the tool output.");
		expect(shown).toContain('"nextCursor":"cursor-page-2"');
		expect(shown).toContain('"hasMore":true');
	});

	it("an over-cap result that falls back to truncation keeps its continuation fields", async () => {
		mocks
			.stub("summarizeLargeToolResult")
			.mockRejectedValue(new Error("summarizer unavailable"));
		const { seen } = await runTurn(mocks, {
			message: "List every record.",
			preload: preloaded(
				["example_list_records"],
				"cfg-records",
				"Records",
			),
			enabledMcpConfigIds: ["cfg-records"],
			steps: [
				{ calls: [{ name: "example_list_records", args: {} }] },
				{ answer: "Listed the first page." },
			],
		});
		const shown = toolMessage(seen, 1, "call-1-0");
		expect(shown).toContain("[TRUNCATED:");
		expect(shown).toContain('"nextCursor":"cursor-page-2"');
	});

	it("with orch-paged-read-fit-v1 off (older history) the read and the over-cap path are unchanged", async () => {
		mocks.off.add("orch-paged-read-fit-v1");
		const { seen } = await runTurn(mocks, {
			message: "Summarize the PRD.",
			steps: [
				{
					calls: [
						{
							name: "fabric_get_project_document",
							args: { document: "doc-long" },
						},
					],
				},
				{ answer: "Done." },
			],
		});
		expect(mocks.stub("executeMcpTool").mock.calls[0][0].args).toEqual({
			document: "doc-long",
		});
		expect(toolMessage(seen, 1, "call-1-0")).toBe(
			"Condensed summary of the tool output.",
		);
	});
});

// ---------------------------------------------------------------------------
// R4 — loaded skill instructions survive pruning.
// ---------------------------------------------------------------------------

const SKILL_THEN_TWO_ROUNDS: Step[] = [
	DISCOVER_REPO_TOOLS,
	{
		calls: [
			{ name: "load_skill", args: { slug: "example-skill" } },
			{ name: "search_slack_messages", args: { query: "launch" } },
		],
	},
	{
		calls: [
			{
				name: "code_file_get",
				args: { repo: "example-org/app", path: "src/flags.ts" },
			},
		],
	},
	{
		calls: [
			{
				name: "fabric_get_project_document",
				args: { document: "doc-short" },
			},
		],
	},
	{ answer: "Report rendered with the skill." },
];

describe("R4: a loaded skill stays in the model's context", () => {
	it("keeps the load_skill body after two more tool rounds, and prunes the rest", async () => {
		const { seen } = await runTurn(mocks, {
			message: "Write the launch report with the example skill.",
			steps: SKILL_THEN_TWO_ROUNDS,
		});
		expect(seen).toHaveLength(5);
		// Iteration 2's results, two tool rounds later.
		expect(toolMessage(seen, 4, "call-2-0")).toContain(SKILL_BODY);
		expect(toolMessage(seen, 4, "call-2-1")).toMatch(
			/^\[Previous tool result pruned/,
		);
	});

	it("with orch-skill-body-retention-v1 off (older history) the skill body is pruned as before", async () => {
		mocks.off.add("orch-skill-body-retention-v1");
		const { seen } = await runTurn(mocks, {
			message: "Write the launch report with the example skill.",
			steps: SKILL_THEN_TWO_ROUNDS,
		});
		expect(toolMessage(seen, 4, "call-2-0")).toMatch(
			/^\[Previous tool result pruned/,
		);
	});
});

// ---------------------------------------------------------------------------
// R5 — a repeated, identical observation is labelled.
// ---------------------------------------------------------------------------

const REPEATS: Step[] = [
	DISCOVER_REPO_TOOLS,
	{
		calls: [
			{
				name: "code_file_get",
				args: { path: "src/flags.ts", repo: "example-org/app" },
			},
		],
	},
	{
		// Same call, keys in another order: the same request.
		calls: [
			{
				name: "code_file_get",
				args: { repo: "example-org/app", path: "src/flags.ts" },
			},
		],
	},
	{
		calls: [
			{ name: "search_slack_messages", args: { query: "launch date" } },
		],
	},
	{
		calls: [
			{ name: "search_slack_messages", args: { query: "launch date" } },
		],
	},
	{ answer: "The flag is on and the date moved." },
];

describe("R5: repeating an identical observation is labelled, not blocked", () => {
	beforeEach(() => {
		mocks
			.stub("searchProjectSlackMessages")
			.mockResolvedValueOnce(slackResult("Launch is on the 12th"))
			.mockResolvedValueOnce(slackResult("Launch moved to the 19th"));
	});

	it("prefixes the repeat with a host note naming the earlier iteration", async () => {
		const { seen, result } = await runTurn(mocks, {
			message: "Check the launch flag and date.",
			steps: REPEATS,
		});
		const firstRead = toolMessage(seen, 5, "call-2-0");
		const repeatRead = toolMessage(seen, 5, "call-3-0");
		expect(firstRead).toBe(FILE_TEXT);
		expect(repeatRead).toMatch(/^\[Host note:/);
		expect(repeatRead).toContain("iteration 2");
		expect(repeatRead).toContain("will not produce new information");
		expect(repeatRead.endsWith(FILE_TEXT)).toBe(true);
		// Labelling only: the turn runs on to the model's own answer.
		expect(seen).toHaveLength(6);
		expect(finalResponse(result)).toBe(
			"The flag is on and the date moved.",
		);
	});

	it("does not label a repeated call whose result changed", async () => {
		const { seen } = await runTurn(mocks, {
			message: "Check the launch flag and date.",
			steps: REPEATS,
		});
		expect(toolMessage(seen, 5, "call-5-0")).not.toContain("[Host note:");
		expect(toolMessage(seen, 5, "call-5-0")).toContain("moved to the 19th");
	});

	it("with orch-repeat-observation-label-v1 off (older history) nothing is labelled", async () => {
		mocks.off.add("orch-repeat-observation-label-v1");
		const { seen } = await runTurn(mocks, {
			message: "Check the launch flag and date.",
			steps: REPEATS,
		});
		expect(toolMessage(seen, 5, "call-3-0")).toBe(FILE_TEXT);
	});
});

// ---------------------------------------------------------------------------
// R6 — an unknown source ends truthfully.
// ---------------------------------------------------------------------------

describe("R6: search_tools finds nothing", () => {
	it("tells the model nothing matched and ends with the model's own answer", async () => {
		mocks.stub("searchAvailableTools").mockResolvedValue({
			results: [],
			totalToolsSearched: 120,
			semanticSearchUsed: true,
			durationMs: 5,
		});
		const { result, seen, state } = await runTurn(mocks, {
			message: "What does the Example CRM say about the launch?",
			steps: [
				{
					calls: [
						{
							name: "search_tools",
							args: { query: "Example CRM" },
						},
					],
				},
				{
					answer: "No connected source covers Example CRM, so I cannot answer from it.",
				},
			],
		});
		expect(toolMessage(seen, 1, "call-1-0")).toContain(
			"No tools found matching your query",
		);
		expect(mocks.stub("executeMcpTool")).not.toHaveBeenCalled();
		expect(state.toolSearchMetrics.zeroResultSearches).toBe(1);
		expect(finalResponse(result)).toBe(
			"No connected source covers Example CRM, so I cannot answer from it.",
		);
	});
});

// ---------------------------------------------------------------------------
// R7 — the stub-catalog prompt is accurate about schema lifetime.
// ---------------------------------------------------------------------------

describe("R7: stub-catalog schema lifetime", () => {
	const manyTools = preloaded(
		Array.from({ length: 31 }, (_, i) => `example_tool_${i}`),
		"cfg-example",
		"Example Server",
	);

	it("says a loaded schema lasts for this turn, not the whole conversation", async () => {
		const { seen } = await runTurn(mocks, {
			message: "Use the example tools.",
			preload: manyTools,
			enabledMcpConfigIds: ["cfg-example"],
			steps: [{ answer: "Done." }],
		});
		expect(seen[0].systemPrompt).toContain("FOCUSED AGENT");
		expect(seen[0].systemPrompt).not.toContain(
			"persists for the rest of this conversation",
		);
		expect(seen[0].systemPrompt).toContain(
			"stays loaded for the rest of this turn only",
		);
	});

	it("with orch-stub-catalog-turn-scope-v1 off (older history) keeps the recorded bytes", async () => {
		mocks.off.add("orch-stub-catalog-turn-scope-v1");
		const { seen } = await runTurn(mocks, {
			message: "Use the example tools.",
			preload: manyTools,
			enabledMcpConfigIds: ["cfg-example"],
			steps: [{ answer: "Done." }],
		});
		expect(seen[0].systemPrompt).toContain(
			"the loaded schema persists for the rest of this conversation.",
		);
	});
});

// ---------------------------------------------------------------------------
// Review round — the continuation note is exact, bounded and inside the cap;
// a result seen before is labelled even after a different one in between.
// ---------------------------------------------------------------------------

/** A generic MCP tool's answer: its page as JSON text, as MCP clients return it. */
function mcpPage(value: unknown) {
	return {
		output: {
			content: [{ type: "text", text: JSON.stringify(value) }],
			isError: false,
		},
		success: true,
		durationMs: 1,
		cached: false,
	};
}

function recordsPage(extra: Record<string, unknown>) {
	return {
		records: Array.from({ length: 400 }, (_, i) => ({
			id: `rec-${i}`,
			name: `Example record ${i}`,
		})),
		...extra,
	};
}

async function listRecords(page: unknown) {
	mocks.stub("executeMcpTool").mockResolvedValueOnce(mcpPage(page));
	const { seen } = await runTurn(mocks, {
		message: "List every record.",
		preload: preloaded(["example_list_records"], "cfg-records", "Records"),
		enabledMcpConfigIds: ["cfg-records"],
		steps: [
			{ calls: [{ name: "example_list_records", args: {} }] },
			{ answer: "Listed the first page." },
		],
	});
	return toolMessage(seen, 1, "call-1-0");
}

/** The continuation note at the end of a shown result ("" when none). */
function noteOf(shown: string): string {
	const at = shown.indexOf("\n\n[Host note: the full result");
	return at < 0 ? "" : shown.slice(at);
}

function noteFields(note: string): Record<string, unknown> {
	const json = note.match(/copied exactly: (\{.*\})\. Use them/s);
	if (!json) {
		throw new Error(`no fields in note: ${note.slice(0, 200)}`);
	}
	return JSON.parse(json[1]);
}

describe("fix 2: the continuation note", () => {
	it("keeps a 501-character nextCursor exactly", async () => {
		const cursor = `c-${"x".repeat(499)}`;
		const shown = await listRecords(
			recordsPage({ hasMore: true, nextCursor: cursor }),
		);
		expect(noteFields(noteOf(shown)).nextCursor).toBe(cursor);
	});

	it("marks a 3,000-character nextCursor as too long instead of dropping or cutting it", async () => {
		const cursor = `c-${"y".repeat(2998)}`;
		const shown = await listRecords(
			recordsPage({ hasMore: true, nextCursor: cursor }),
		);
		const note = noteOf(shown);
		expect(shown).not.toContain(cursor.slice(0, 2049));
		expect(String(noteFields(note).nextCursor)).toMatch(
			/too long to keep.*narrow the request/,
		);
		expect(note.length).toBeLessThanOrEqual(2_500);
	});

	it("stays bounded for 100 nested pagination objects", async () => {
		const pages = Object.fromEntries(
			Array.from({ length: 100 }, (_, i) => [
				`page${i}`,
				{ nextCursor: `cursor-${i}`, hasMore: true, offset: i * 10 },
			]),
		);
		const shown = await listRecords(recordsPage(pages));
		const note = noteOf(shown);
		expect(note.length).toBeGreaterThan(0);
		expect(note.length).toBeLessThanOrEqual(2_500);
		expect(Object.keys(noteFields(note)).length).toBeLessThanOrEqual(12);
	});

	it("summary plus note never exceeds the cap, and the summarizer is told so", async () => {
		mocks
			.stub("summarizeLargeToolResult")
			.mockResolvedValue("S".repeat(TOOL_RESULTS.maxChars));
		const shown = await listRecords(
			recordsPage({ hasMore: true, nextCursor: "cursor-page-2" }),
		);
		const note = noteOf(shown);
		expect(note).toContain("cursor-page-2");
		expect(shown.length).toBeLessThanOrEqual(TOOL_RESULTS.maxChars);
		const asked = mocks.stub("summarizeLargeToolResult").mock.calls[0][0]
			.maxOutputLength as number;
		expect(asked + note.length).toBeLessThanOrEqual(TOOL_RESULTS.maxChars);
	});

	it("truncated content plus note never exceeds the cap", async () => {
		mocks
			.stub("summarizeLargeToolResult")
			.mockRejectedValue(new Error("summarizer unavailable"));
		const shown = await listRecords(
			recordsPage({ hasMore: true, nextCursor: "cursor-page-2" }),
		);
		expect(shown).toContain("[TRUNCATED:");
		expect(noteOf(shown)).toContain("cursor-page-2");
		expect(shown.length).toBeLessThanOrEqual(TOOL_RESULTS.maxChars);
	});
});

describe("fix 5: A → B → A is still a repeat of A", () => {
	it("labels the third result with the iteration that first returned it", async () => {
		mocks
			.stub("searchProjectSlackMessages")
			.mockResolvedValueOnce(slackResult("Launch is on the 12th"))
			.mockResolvedValueOnce(slackResult("Launch moved to the 19th"))
			.mockResolvedValueOnce(slackResult("Launch is on the 12th"));
		const search = {
			calls: [
				{ name: "search_slack_messages", args: { query: "launch" } },
			],
		};
		const { seen } = await runTurn(mocks, {
			message: "When is the launch?",
			steps: [search, search, search, { answer: "It changed twice." }],
		});
		expect(toolMessage(seen, 3, "call-2-0")).not.toContain("[Host note:");
		const third = toolMessage(seen, 3, "call-3-0");
		expect(third).toMatch(/^\[Host note:/);
		expect(third).toContain("iteration 1");
	});
});

describe("a repeat label never pushes a result over the cap", () => {
	it("cuts a repeated result 50 characters under the cap so it fits with its label, without summarizing", async () => {
		const body = "z".repeat(TOOL_RESULTS.maxChars - 50);
		mocks.stub("executeMcpTool").mockResolvedValue({
			output: body,
			success: true,
			durationMs: 1,
			cached: false,
		});
		const read = {
			calls: [{ name: "example_read", args: { id: "item-1" } }],
		};
		const { seen } = await runTurn(mocks, {
			message: "Read the item.",
			steps: [read, read, { answer: "Read it twice." }],
		});
		expect(toolMessage(seen, 2, "call-1-0")).toBe(body);
		const repeat = toolMessage(seen, 2, "call-2-0");
		expect(repeat).toMatch(/^\[Host note:/);
		expect(repeat).toContain("iteration 1");
		expect(repeat.length).toBeLessThanOrEqual(TOOL_RESULTS.maxChars);
		expect(mocks.stub("summarizeLargeToolResult")).not.toHaveBeenCalled();
	});

	it("leaves a repeated result that fits with its label whole", async () => {
		const body = "z".repeat(1_000);
		mocks.stub("executeMcpTool").mockResolvedValue({
			output: body,
			success: true,
			durationMs: 1,
			cached: false,
		});
		const read = {
			calls: [{ name: "example_read", args: { id: "item-1" } }],
		};
		const { seen } = await runTurn(mocks, {
			message: "Read the item.",
			steps: [read, read, { answer: "Read it twice." }],
		});
		const repeat = toolMessage(seen, 2, "call-2-0");
		expect(repeat.endsWith(body)).toBe(true);
		expect(repeat).not.toContain("[TRUNCATED:");
	});
});

describe("round 2 fix 2: a label-forced cut keeps the pagination", () => {
	/** An MCP page of exactly `length` characters ending in its cursor. */
	function nearCapPage(length: number) {
		const tail = { hasMore: true, nextCursor: "cursor-page-2" };
		const shell = JSON.stringify({ filler: "", ...tail });
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						filler: "f".repeat(length - shell.length),
						...tail,
					}),
				},
			],
			isError: false,
		};
	}

	function mcpReturning(output: unknown) {
		mocks.stub("executeMcpTool").mockImplementation(async (req) =>
			req.toolName === "example_list_records"
				? { output, success: true, durationMs: 1, cached: false }
				: {
						output: "other result",
						success: true,
						durationMs: 1,
						cached: false,
					},
		);
	}

	const list = {
		calls: [{ name: "example_list_records", args: { page: 1 } }],
	};

	it("an 11,945-character result keeps its nextCursor when repeated", async () => {
		const page = nearCapPage(11_945);
		expect(page.content[0].text).toHaveLength(11_945);
		mcpReturning(page);
		const { seen } = await runTurn(mocks, {
			message: "List the records.",
			steps: [list, list, { answer: "Done." }],
		});
		expect(toolMessage(seen, 2, "call-1-0")).toBe(page.content[0].text);
		const repeat = toolMessage(seen, 2, "call-2-0");
		expect(repeat).toMatch(/^\[Host note:/);
		expect(repeat).toContain('"nextCursor":"cursor-page-2"');
		expect(repeat.length).toBeLessThanOrEqual(TOOL_RESULTS.maxChars);
		expect(mocks.stub("summarizeLargeToolResult")).not.toHaveBeenCalled();
	});

	it("a repeat after the original was pruned still carries the continuation", async () => {
		mcpReturning(nearCapPage(11_945));
		const other = {
			calls: [{ name: "example_other", args: {} }],
		};
		const { seen } = await runTurn(mocks, {
			message: "List the records.",
			steps: [list, other, other, list, { answer: "Done." }],
		});
		expect(toolMessage(seen, 4, "call-1-0")).toMatch(
			/^\[Previous tool result pruned/,
		);
		const repeat = toolMessage(seen, 4, "call-4-0");
		expect(repeat).toContain('"nextCursor":"cursor-page-2"');
		expect(repeat.length).toBeLessThanOrEqual(TOOL_RESULTS.maxChars);
	});
});

describe("round 3 fix 2: an escaped 2,048-character cursor survives exactly", () => {
	const cursor = '"\\'.repeat(1_024);

	it("is 2,048 raw characters of quotes and backslashes", () => {
		expect(cursor).toHaveLength(2_048);
	});

	it.each([
		["summarizer", true],
		["truncation", false],
	] as const)("%s path", async (_label, summarizes) => {
		if (summarizes) {
			mocks
				.stub("summarizeLargeToolResult")
				.mockResolvedValue("S".repeat(TOOL_RESULTS.maxChars));
		} else {
			mocks
				.stub("summarizeLargeToolResult")
				.mockRejectedValue(new Error("summarizer unavailable"));
		}
		const shown = await listRecords(
			recordsPage({ hasMore: true, nextCursor: cursor }),
		);
		expect(noteFields(noteOf(shown)).nextCursor).toBe(cursor);
		expect(shown.length).toBeLessThanOrEqual(TOOL_RESULTS.maxChars);
	});
});
