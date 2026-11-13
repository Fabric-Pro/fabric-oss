import { readFileSync } from "node:fs";
import { log, patched, startChild } from "@temporalio/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planFinalizationRequest } from "../../../../activities/orchestrator/execution/finalization-fit";
import { toolBinding } from "../../advisor-call-tool";
import { boundedHistoryV2Decision } from "../../advisor-history-retention";
import {
	advisorResultReadsEnabled,
	extractMcpResultText,
	RESULT_READS_PATCH,
	readAdvisorResult,
	resultReadPlaceholder,
} from "../../advisor-result-read";
import { isLoopBuiltInReadTool } from "../../fabric-catalog-access";
import type { IterativeMessage } from "../../types";
import { buildWorkflowOutput, executeCompletionPhase } from "../completion";
import {
	maybeCompactConversationHistory,
	summarizeAccomplishments,
} from "../iterative-execution";

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
		startTime: new Date(Date.now()),
		runId: "test-run-id",
		unsafe: { isReplaying: false },
	})),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import {
	installDefaultStubs,
	preloaded,
	runTurn,
	type Step,
	toolMessage,
} from "./advisor-scenario-harness";

beforeEach(() => {
	installDefaultStubs(mocks);
	vi.mocked(patched).mockClear();
	vi.mocked(log.info).mockClear();
	vi.mocked(startChild).mockClear();
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());
const enabled = { turnId: "turn-example" };
const done = { answer: "The evidence is complete." };
const call = (name: string, args = {}): Step => ({ calls: [{ name, args }] });
function fixture(text: unknown) {
	mocks.stub("executeMcpTool").mockResolvedValue({
		output: text,
		success: true,
		durationMs: 1,
		cached: false,
		readOnly: true,
	});
	return {
		enabledMcpConfigIds: ["config-example"],
		preload: preloaded(["example_read"], "config-example", "Example"),
	};
}
function required<T>(value: T | null | undefined): T {
	if (value == null) {
		throw new Error("Expected a recorded result in this scenario");
	}
	return value;
}

function pagesIn(history: IterativeMessage[]) {
	return history
		.filter(
			(m) => m.role === "tool" && m.content.startsWith('{"v":1,"ref":'),
		)
		.map((m) => JSON.parse(m.content));
}

describe("Advisor result reads in the real iterative loop", () => {
	it.each([undefined, "call_tool"])(
		"offers and dispatches the built-in on request one, loading=%s",
		async (toolLoadingMode) => {
			const turn = await runTurn(mocks, {
				message: "Read earlier results",
				projectId: null,
				input: { ...enabled, toolLoadingMode },
				steps: [call("advisor_result_read", { ref: "r99" }), done],
			});
			expect(turn.seen[0].tools).toContain("advisor_result_read");
			expect(toolMessage(turn.seen, 1, "call-1-0")).toBe(
				'{"v":1,"status":"unavailable"}',
			);
			expect(mocks.stub("executeMcpTool")).not.toHaveBeenCalled();
			expect(turn.state.toolCalls[0].name).toBe("advisor_result_read");
			expect(
				turn.state.iterativeConversationHistory?.find(
					(m) => m.role === "tool",
				),
			).toMatchObject({ toolResultReadOnly: true });
			expect(
				toolBinding(
					"advisor_result_read",
					undefined,
					undefined,
					false,
					true,
				),
			).toEqual({ kind: "loop" });
			expect(
				toolBinding(
					"advisor_result_read",
					undefined,
					undefined,
					false,
					false,
				),
			).toEqual({ kind: "offered_lookup" });
			expect(
				isLoopBuiltInReadTool("advisor_result_read", false, true),
			).toBe(true);
			expect(
				isLoopBuiltInReadTool("advisor_result_read", false, false),
			).toBe(false);
		},
	);
	it.each([
		{ kind: "text", output: "plain result" },
		{ kind: "JSON", output: { records: [{ id: "record-example" }] } },
		{ kind: "cap boundary", output: "x".repeat(32_000) },
	])(
		"keeps an under-cap result byte-identical with result reads on and off: $kind",
		async ({ output }) => {
			const contents: string[] = [];
			for (const markerEnabled of [false, true]) {
				mocks.off[markerEnabled ? "delete" : "add"](RESULT_READS_PATCH);
				const setup = fixture(output);
				const turn = await runTurn(mocks, {
					...setup,
					message: "Read",
					input: enabled,
					steps: [call("example_read"), done],
				});
				contents.push(toolMessage(turn.seen, 1, "call-1-0"));
			}
			expect(contents[1]).toBe(contents[0]);
			expect(contents[1]).toBe(extractMcpResultText(output));
		},
	);
	it("keeps frame JSON parseable and byte-identical in the next loop request", async () => {
		const output = {
			frameId: "frame-example",
			title: "Example frame",
			frameType: "html",
		};
		const contents: string[] = [];
		for (const markerEnabled of [false, true]) {
			mocks.off[markerEnabled ? "delete" : "add"](RESULT_READS_PATCH);
			fixture(output);
			const turn = await runTurn(mocks, {
				message: "Create an example frame",
				input: enabled,
				enabledMcpConfigIds: ["config-example"],
				preload: preloaded(
					["fabric_create_frame"],
					"config-example",
					"Example",
				),
				steps: [
					call("fabric_create_frame", {
						title: "Example frame",
						html: "<p>Example</p>",
					}),
					done,
				],
			});
			contents.push(toolMessage(turn.seen, 1, "call-1-0"));
		}
		expect(contents[1]).toBe(contents[0]);
		expect(JSON.parse(contents[1])).toEqual(output);
		expect(JSON.parse(contents[1]).frameId).toBe("frame-example");
	});
	it("summarizes an over-cap skill file exactly as the disabled run does", async () => {
		const data = "skill-reference ".repeat(8000);
		const output = {
			kind: "file",
			file: {
				path: "reference.txt",
				contentType: "text/plain",
				encoding: "utf-8",
				data,
				sizeBytes: data.length,
			},
		};
		const contents: string[] = [];
		for (const markerEnabled of [false, true]) {
			mocks.off[markerEnabled ? "delete" : "add"](RESULT_READS_PATCH);
			mocks.stub("executeSkillToolActivity").mockResolvedValue(output);
			mocks.stub("summarizeLargeToolResult").mockClear();
			const turn = await runTurn(mocks, {
				message: "Read a skill reference",
				input: enabled,
				steps: [
					call("read_skill_file", {
						slug: "example-skill",
						path: "reference.txt",
					}),
					done,
				],
			});
			expect(
				mocks.stub("summarizeLargeToolResult"),
			).toHaveBeenCalledTimes(1);
			expect(mocks.stub("summarizeLargeToolResult")).toHaveBeenCalledWith(
				expect.objectContaining({
					toolName: "read_skill_file",
					toolResult: JSON.stringify(output),
					maxOutputLength: 63_500,
				}),
			);
			contents.push(toolMessage(turn.seen, 1, "call-1-0"));
		}
		expect(contents[1]).toBe(contents[0]);
		expect(contents[1]).not.toContain("advisor_result_read");
	});

	it.each([{}, { turnId: "" }, { ...enabled, markerOff: true }])(
		"preserves the legacy bytes and summarizer with %j",
		async (variant) => {
			const setup = fixture("x".repeat(100_000));
			const steps = [call("example_read"), done];
			if ("markerOff" in variant) {
				mocks.off.add(RESULT_READS_PATCH);
			}
			const turn = await runTurn(mocks, {
				...setup,
				message: "Read",
				input: variant,
				steps,
			});
			expect(turn.seen[0].tools).not.toContain("advisor_result_read");
			expect(toolMessage(turn.seen, 1, "call-1-0")).toBe(
				"Condensed summary of the tool output.",
			);
			expect(
				mocks.stub("summarizeLargeToolResult"),
			).toHaveBeenCalledTimes(1);
			expect(
				turn.state.iterativeConversationHistory?.some(
					(m) => m.toolResultRef,
				),
			).toBe(false);
			expect(
				vi
					.mocked(patched)
					.mock.calls.filter(([id]) => id === RESULT_READS_PATCH),
			).toHaveLength("markerOff" in variant ? 1 : 0);
		},
	);
	it.each([{}, { turnId: "" }, { ...enabled, markerOff: true }])(
		"keeps legacy external routing and presentation for a same-named tool: %j",
		async (variant) => {
			if ("markerOff" in variant) {
				mocks.off.add(RESULT_READS_PATCH);
			}
			fixture("External tool result");
			const turn = await runTurn(mocks, {
				message: "Read",
				input: variant,
				enabledMcpConfigIds: ["config-example"],
				preload: preloaded(
					["advisor_result_read"],
					"config-example",
					"Example",
				),
				steps: [call("advisor_result_read", { ref: "r1" }), done],
			});
			expect(mocks.stub("executeMcpTool")).toHaveBeenCalledWith(
				expect.objectContaining({ toolName: "advisor_result_read" }),
			);
			expect(toolMessage(turn.seen, 1, "call-1-0")).toBe(
				"External tool result",
			);
			expect(turn.state.advisorResultReadsEnabled).toBe(false);
			expect(turn.state.toolCalls[0].result).toBe("External tool result");
			const output = buildWorkflowOutput(turn.state, "completed");
			expect(output.toolCalls[0].result).toBe("External tool result");
			expect(output.artifacts?.[0].content).toBe("External tool result");
			expect(
				summarizeAccomplishments(turn.state, { includeFindings: true }),
			).toContain("External tool result");
		},
	);

	it("keeps disabled pruner placeholders byte-identical", async () => {
		mocks.off.add(RESULT_READS_PATCH);
		const text = "line\n".repeat(500);
		const setup = fixture(text);
		const turn = await runTurn(mocks, {
			...setup,
			message: "Read",
			input: { turnId: "turn-example" },
			steps: [
				call("example_read"),
				call("example_read", { page: 2 }),
				call("example_read", { page: 3 }),
				call("example_read", { page: 4 }),
				done,
			],
		});
		expect(toolMessage(turn.seen, 4, "call-1-0")).toBe(
			`[Previous tool result pruned to save context. Tool: example_read returned ${text.length} chars. Summary: ${text.substring(0, 300).replace(/\n/g, " ")}...]`,
		);
	});
	it("keeps legacy placeholders when disabled even if a message carries ref metadata", async () => {
		mocks.off.add(RESULT_READS_PATCH);
		const text = "x".repeat(2000);
		const setup = fixture(text);
		const turn = await runTurn(mocks, {
			...setup,
			message: "Read",
			input: { turnId: "turn-example" },
			onIterationInput: (request) => {
				for (const message of request.conversationHistory) {
					if (message.role === "tool") {
						message.toolResultRef = "r1";
					}
				}
			},
			steps: [
				...Array.from({ length: 4 }, (_, page) =>
					call("example_read", { page }),
				),
				done,
			],
		});
		expect(toolMessage(turn.seen, 4, "call-1-0")).not.toContain(
			"Read it again with advisor_result_read",
		);
	});

	it.each(["abc😀".repeat(20_000), '\u0000"\\\n😀'.repeat(20_000)])(
		"feeds an exact head and pages that reassemble a large MCP result",
		async (text) => {
			const setup = fixture({ content: [{ type: "text", text }] });
			let assembled = "";
			let next = 0;
			const readNext: Step = (history) => {
				if (!assembled) {
					const head = required(
						history.find((m) => m.role === "tool"),
					).content;
					const note = required(
						head.match(
							/\n\n\[Host note: this is the exact result up to character (\d+) of (\d+)/,
						),
					);
					assembled = head.slice(0, note.index);
					expect(Number(note[1])).toBe(assembled.length);
					expect(Number(note[2])).toBe(text.length);
					expect(head.length).toBeLessThanOrEqual(32_000);
					next = assembled.length;
				} else {
					const page = required(pagesIn(history).at(-1));
					expect(page.offset).toBe(next);
					assembled += page.text;
					next = assembled.length;
				}
				return next < text.length
					? call("advisor_result_read", { ref: "r1", offset: next })
					: done;
			};
			const turn = await runTurn(mocks, {
				...setup,
				message: "Read",
				input: enabled,
				steps: [
					call("example_read"),
					...Array.from({ length: 19 }, () => readNext),
				],
			});
			expect(assembled).toBe(text);
			expect(
				mocks.stub("summarizeLargeToolResult"),
			).not.toHaveBeenCalled();
			expect(extractMcpResultText(turn.state.toolCalls[0].result)).toBe(
				text,
			);
			const pages = required(
				turn.state.iterativeConversationHistory,
			).filter((m) => m.role === "tool" && m.toolCallId !== "call-1-0");
			expect(pages.every((m) => m.toolResultRef === undefined)).toBe(
				true,
			);
			const pageLogs = vi
				.mocked(log.info)
				.mock.calls.filter(
					([message, fields]) =>
						message === "Adding tool result to conversation" &&
						fields?.toolName === "advisor_result_read",
				);
			expect(pageLogs.length).toBeGreaterThan(0);
			for (const [, fields] of pageLogs) {
				expect(fields).not.toHaveProperty("resultPreview");
			}
		},
	);
	it("keeps continuation and repeat notes, and distinct pages do not repeat", async () => {
		const text = JSON.stringify({
			body: "x".repeat(80_000),
			nextCursor: "cursor-example",
		});
		const setup = fixture(text);
		const turn = await runTurn(mocks, {
			...setup,
			message: "Read",
			input: enabled,
			steps: [
				call("example_read"),
				call("example_read"),
				call("advisor_result_read", { ref: "r1", limit: 1000 }),
				call("advisor_result_read", {
					ref: "r1",
					offset: 1000,
					limit: 1000,
				}),
				call("advisor_result_read", {
					ref: "r1",
					offset: 1000,
					limit: 1000,
				}),
				done,
			],
		});
		expect(toolMessage(turn.seen, 1, "call-1-0")).toContain(
			'"nextCursor":"cursor-example"',
		);
		expect(toolMessage(turn.seen, 2, "call-2-0")).toContain(
			"repeat the observation",
		);
		expect(toolMessage(turn.seen, 4, "call-4-0")).not.toContain(
			"repeat the observation",
		);
		expect(toolMessage(turn.seen, 5, "call-5-0")).toContain(
			"repeat the observation",
		);
		expect(mocks.stub("summarizeLargeToolResult")).not.toHaveBeenCalled();
	});
	it("keeps the call_tool search plain-cut exception when result reads are enabled", async () => {
		mocks.stub("searchAvailableTools").mockResolvedValue({
			results: Array.from({ length: 1 }, () => ({
				toolName: `example_${"x".repeat(40_000)}`,
				description: "description",
				inputSchema: { type: "object", properties: {} },
				serverName: "Example",
				configId: "config-example",
			})),
			totalToolsSearched: 1,
			semanticSearchUsed: false,
			durationMs: 1,
		});
		const turn = await runTurn(mocks, {
			message: "Search",
			input: { ...enabled, toolLoadingMode: "call_tool" },
			steps: [call("search_tools", { query: "example" }), done],
		});
		expect(toolMessage(turn.seen, 1, "call-1-0")).toContain("[TRUNCATED:");
		expect(toolMessage(turn.seen, 1, "call-1-0")).not.toContain(
			"exact result up to character",
		);
		expect(mocks.stub("summarizeLargeToolResult")).not.toHaveBeenCalled();
	});
	it("retains the local schema when discovery returns a same-named external tool", async () => {
		mocks.stub("searchAvailableTools").mockResolvedValue({
			results: preloaded(
				["advisor_result_read"],
				"config-example",
				"Example",
			),
			totalToolsSearched: 1,
			semanticSearchUsed: false,
			durationMs: 1,
		});
		const schemas: unknown[] = [];
		await runTurn(mocks, {
			message: "Read",
			input: enabled,
			onIterationInput: (request) =>
				schemas.push(request.availableTools.advisor_result_read),
			steps: [call("search_tools", { query: "example" }), done],
		});
		for (const schema of schemas) {
			expect(schema).toMatchObject({
				inputSchema: { required: ["ref"], additionalProperties: false },
			});
		}
	});

	it("excludes pages structurally from over-cap processing even if future cap rules change", () => {
		const source = readFileSync(
			new URL("../iterative-execution.ts", import.meta.url),
			"utf8",
		);
		expect(source).toMatch(/if\s*\(\s*!isResultPage\s*&&\s*\(overCapAlone/);
	});

	it.each([undefined, "call_tool"])(
		"refs survive the age pruner and pages are prunable, loading=%s",
		async (toolLoadingMode) => {
			const text = "x".repeat(80_000);
			const setup = fixture(text);
			const turn = await runTurn(mocks, {
				...setup,
				message: "Read",
				input: { ...enabled, toolLoadingMode },
				steps: [
					call("example_read"),
					...Array.from({ length: 5 }, (_, i) =>
						call("advisor_result_read", {
							ref: "r1",
							offset: i * 1000,
							limit: 1000,
						}),
					),
					done,
				],
			});
			const placeholder = toolMessage(turn.seen, 6, "call-1-0");
			expect(placeholder).toContain(
				'Read it again with advisor_result_read {"ref":"r1"}',
			);
			expect(placeholder.length).toBeLessThanOrEqual(300);
			expect(toolMessage(turn.seen, 6, "call-2-0")).toContain(
				"[Previous tool result pruned",
			);
			expect(toolMessage(turn.seen, 6, "call-2-0")).not.toContain(
				"Read it again with advisor_result_read",
			);
			let restored = "";
			while (restored.length < text.length) {
				restored += JSON.parse(
					readAdvisorResult(
						turn.state.toolCalls,
						{ ref: "r1", offset: restored.length },
						32_000,
					),
				).text;
			}
			expect(restored).toBe(text);
		},
	);
	it("wires read-back refs through the bounded pruner in a live loop", async () => {
		const text = "x".repeat(80_000);
		const setup = fixture(text);
		mocks.stub("compactConversationHistoryActivity").mockResolvedValue({
			summaryText: "",
			usage: { inputTokens: 0, outputTokens: 0 },
		});
		const turn = await runTurn(mocks, {
			...setup,
			message: "Read",
			input: { ...enabled, historyRetention: "bounded" },
			state: {
				advisorRequestSizing: {
					contextWindow: 20_000,
					extraInputTokens: 0,
				},
			},
			steps: [
				...Array.from({ length: 5 }, (_, page) =>
					call("example_read", { page }),
				),
				call("advisor_result_read", { ref: "r1" }),
				done,
			],
		});
		expect(toolMessage(turn.seen, 5, "call-1-0")).toContain(
			'Read it again with advisor_result_read {"ref":"r1"}',
		);
		expect(pagesIn(turn.seen[6].history).at(-1)?.text).toBe(
			text.slice(0, 16_000),
		);
	});

	it.each([false, true])(
		"bounded reset preserves ref discovery and full reads, wrapped=%s",
		async (wrapped) => {
			const text = "bounded-body ".repeat(8000);
			const setup = fixture(text);
			const turn = await runTurn(mocks, {
				...setup,
				message: "Read",
				input: {
					...enabled,
					...(wrapped ? { toolLoadingMode: "call_tool" } : {}),
				},
				steps: [
					call("example_read"),
					...Array.from({ length: 5 }, (_, i) =>
						call("advisor_result_read", {
							ref: "r1",
							offset: i * 2000,
							limit: 2000,
						}),
					),
					done,
				],
			});
			const history = structuredClone(turn.seen[6].history);
			// Use fresh full result messages to exercise bounded v2 independently of age pruning.
			for (const message of history.filter((m) => m.role === "tool")) {
				message.content = "x".repeat(32_000);
				message.toolResultReadOnly = true;
			}
			const decision = boundedHistoryV2Decision({
				request: {
					conversationHistory: history,
					availableTools: {},
					systemPrompt: "example",
				},
				allowance: 1_000_000,
				spent: 0,
				finalizationReserve: 8000,
				iteration: 20,
				contextWindow: 20_000,
				resultReadsEnabled: true,
				...(wrapped
					? { effectiveToolCalls: turn.state.advisorEffectiveCalls }
					: {}),
			});
			const disabled = boundedHistoryV2Decision({
				request: {
					conversationHistory: history,
					availableTools: {},
					systemPrompt: "example",
				},
				allowance: 1_000_000,
				spent: 0,
				finalizationReserve: 8000,
				iteration: 20,
				contextWindow: 20_000,
			});
			expect(
				disabled.history.find((m) => m.toolResultRef === "r1")?.content,
			).not.toContain("Read it again with advisor_result_read");
			expect(decision.pruned).toBeGreaterThan(0);
			const original = required(
				decision.history.find((m) => m.toolResultRef === "r1"),
			);
			expect(original.content).toContain(
				'advisor_result_read {"ref":"r1"}',
			);
			expect(original.content.length).toBeLessThanOrEqual(300);
			const pagePlaceholder = required(
				decision.history.find((m) => m.toolCallId === "call-2-0"),
			);
			expect(pagePlaceholder.content).not.toContain(
				"Read it again with advisor_result_read",
			);
			expect(
				decision.history.filter((m) =>
					m.content.startsWith("[Previous tool result pruned"),
				).length,
			).toBeGreaterThan(1);
			expect(
				JSON.parse(
					readAdvisorResult(
						turn.state.toolCalls,
						{ ref: "r1", offset: 64_000 },
						32_000,
					),
				).text,
			).toBe(text.slice(64_000, 80_000));
		},
	);
	it.each([undefined, "call_tool"])(
		"reads an exact old result after automatic compaction, loading=%s",
		async (toolLoadingMode) => {
			const text = "older exact result ".repeat(400);
			const setup = fixture(text);
			mocks.stub("compactConversationHistoryActivity").mockResolvedValue({
				summaryText: "Earlier reads are complete.",
				usage: { inputTokens: 1, outputTokens: 1 },
			});
			const turn = await runTurn(mocks, {
				...setup,
				message: "Read",
				input: { ...enabled, toolLoadingMode },
				modeConfig: { maxIterations: 20, maxTotalTokens: 200_000 },
				steps: [
					...Array.from({ length: 7 }, (_, i) => ({
						calls: [{ name: "example_read", args: { page: i } }],
						usage: { inputTokens: 20_000, outputTokens: 0 },
					})),
					(history) => {
						const summary = history.find((m) =>
							m.content.startsWith("[CONTEXT SUMMARY"),
						);
						expect(summary?.content).toContain('"ref":"r1"');
						return call("advisor_result_read", { ref: "r1" });
					},
					done,
				],
			});
			expect(
				mocks.stub("compactConversationHistoryActivity"),
			).toHaveBeenCalled();
			expect(pagesIn(turn.seen[8].history).at(-1)?.text).toBe(text);
			expect(mocks.stub("executeMcpTool")).toHaveBeenCalledTimes(7);
		},
	);

	it("compaction carries bounded refs and output truncation leaves the live store intact", async () => {
		const text = Array.from(
			{ length: 8000 },
			(_, i) => `${String(i).padStart(6, "0")}=record!\n`,
		).join("");
		const setup = fixture(text);
		const turn = await runTurn(mocks, {
			...setup,
			message: "Read",
			input: enabled,
			steps: [
				...Array.from({ length: 8 }, (_, i) =>
					call("example_read", { page: i }),
				),
				call("advisor_result_read", { ref: "r1", offset: 0 }),
				call("advisor_result_read", { ref: "r1", offset: 16_000 }),
				call("advisor_result_read", { ref: "r1", offset: 32_000 }),
				call("example_read", { page: 8 }),
				done,
			],
		});
		const before = JSON.stringify(turn.state.toolCalls);
		mocks.stub("compactConversationHistoryActivity").mockResolvedValue({
			summaryText: "Earlier reads are complete.",
			usage: { inputTokens: 1, outputTokens: 1 },
		});
		await maybeCompactConversationHistory(
			turn.state,
			required(turn.state.iterativeConversationHistory),
			20,
			80_000,
			100_000,
			"user-1",
			"org-1",
		);
		const summary = required(
			required(turn.state.iterativeConversationHistory).find((m) =>
				m.content.startsWith("[CONTEXT SUMMARY"),
			),
		);
		expect(summary.content).toContain(
			'"ref":"r1","tool":"example_read","totalCharacters":120000',
		);
		expect(summary.content).not.toContain("000001=record!");
		expect(
			JSON.parse(
				readAdvisorResult(
					turn.state.toolCalls,
					{ ref: "r1", offset: 100_000 },
					32_000,
				),
			).text,
		).toBe(text.slice(100_000, 116_000));
		const escapedBody = JSON.stringify(text).slice(1, -1);
		const fullBodyCopies = (value: unknown) =>
			JSON.stringify(value).split(escapedBody).length - 1;
		const originals = turn.state.toolCalls.filter(
			(entry) => entry.name === "example_read",
		);
		expect(fullBodyCopies(turn.state)).toBe(originals.length);
		const reads = turn.state.toolCalls.filter(
			(entry) => entry.name === "advisor_result_read",
		);
		for (const [index, read] of reads.entries()) {
			expect(read.result).toEqual({
				v: 1,
				status: "success",
				ref: "r1",
				tool: "example_read",
				offset: index * 16_000,
				nextOffset: (index + 1) * 16_000,
				returnedCharacters: 16_000,
				totalCharacters: text.length,
			});
		}
		expect(summary.content).toContain('"ref":"r12"');
		for (const page of [
			text.slice(0, 16_000),
			text.slice(16_000, 32_000),
			text.slice(32_000, 48_000),
		]) {
			const escaped = JSON.stringify(page).slice(1, -1);
			expect(
				JSON.stringify(turn.state.toolCalls).split(escaped).length - 1,
			).toBe(originals.length);
		}
		await executeCompletionPhase(
			turn.state,
			{
				executionId: "exec-advisor-1",
				userId: "user-1",
				organizationId: "org-1",
				message: "Read",
				history: [],
				executionMode: "balanced",
			},
			{ reflection: false } as never,
			{ reflection: { onFinalOutput: false } } as never,
			"Answer",
			vi.fn(),
		);
		const starts = vi.mocked(startChild).mock.calls as unknown as Array<
			[unknown, { args: unknown[] }]
		>;
		const childInput = starts[0]?.[1].args[0];
		expect(childInput).toBeDefined();
		expect(fullBodyCopies(childInput)).toBe(originals.length);
		const { iterativeConversationHistory: _history, ...otherInput } =
			childInput as Record<string, unknown>;
		for (const page of [
			text.slice(0, 16_000),
			text.slice(16_000, 32_000),
			text.slice(32_000, 48_000),
		]) {
			const escaped = JSON.stringify(page).slice(1, -1);
			expect(JSON.stringify(otherInput).split(escaped).length - 1).toBe(
				originals.length,
			);
		}
		expect(
			pagesIn(required(turn.state.iterativeConversationHistory)).some(
				(page) => page.text === text.slice(32_000, 48_000),
			),
		).toBe(true);
		const output = buildWorkflowOutput(
			turn.state,
			"completed",
			undefined,
			"Answer",
		);
		expect(output).not.toHaveProperty("advisorResultReadsEnabled");
		expect(output.toolCalls[0].result).not.toBe(text);
		expect(JSON.stringify(turn.state.toolCalls)).toBe(before);
		expect(extractMcpResultText(turn.state.toolCalls[0].result)).toBe(text);
	});
	it("keeps the ref instruction in bounded finalization findings", async () => {
		const placeholder = resultReadPlaceholder(
			"example_read",
			"x".repeat(32_000),
			"r1",
		);
		const history: IterativeMessage[] = [
			{
				role: "user",
				content: "Read captured evidence",
				timestamp: "2026-01-01",
			},
			{
				role: "assistant",
				content: "",
				timestamp: "2026-01-01",
				iteration: 1,
				toolCalls: [{ id: "c1", name: "example_read", args: {} }],
			},
			{
				role: "tool",
				content: placeholder,
				toolCallId: "c1",
				toolResultRef: "r1",
				timestamp: "2026-01-01",
				iteration: 1,
			},
		];
		const plan = await planFinalizationRequest({
			room: 9000,
			instructions: "Use the captured evidence",
			fullMessages: [{ role: "user", content: "x".repeat(200_000) }],
			fullMaxOutputTokens: 16_384,
			history,
		});
		expect(plan.kind).toBe("bounded");
		expect(JSON.stringify(plan)).toContain(
			JSON.stringify(placeholder).slice(1, -1),
		);
	});

	it("wires the decision once at run start and retains existing serialization boundaries", () => {
		const source = readFileSync(
			new URL("../../index.ts", import.meta.url),
			"utf8",
		);
		expect(
			source.match(/advisorResultReadsEnabled\(input, patched\)/g),
		).toHaveLength(1);
		const decide = vi.fn(() => true);
		expect(advisorResultReadsEnabled(enabled, decide)).toBe(true);
		expect(decide).toHaveBeenCalledTimes(1);
	});
});

describe("Advisor store metadata in the real tool loop", () => {
	it("threads distinct call positions across two rounds including a failed call", async () => {
		const tools = fixture("example content");
		mocks
			.stub("executeMcpTool")
			.mockResolvedValueOnce({
				success: true,
				output: "example first",
				durationMs: 1,
				cached: false,
			})
			.mockResolvedValueOnce({
				success: false,
				output: { error: "example failed read" },
				durationMs: 1,
				cached: false,
			})
			.mockResolvedValueOnce({
				success: true,
				output: "example third",
				durationMs: 1,
				cached: false,
			});
		const { state } = await runTurn(mocks, {
			...tools,
			message: "Read the evidence",
			input: {
				turnId: "example-turn",
				conversationId: "example-conversation",
			},
			steps: [
				{
					calls: [
						{
							name: "example_read",
							args: {
								query: "example first",
								userId: "example-forged",
								conversationId: "example-forged",
							},
						},
						{
							name: "example_read",
							args: { query: "example second" },
						},
					],
				},
				call("example_read", { query: "example third" }),
				done,
			],
		});
		const calls = mocks.stub("executeMcpTool").mock.calls;
		expect(calls).toHaveLength(3);
		expect(
			calls.map(([input]) => input.advisorResultStore.sourceKey),
		).toEqual(["exec-advisor-1:0", "exec-advisor-1:1", "exec-advisor-1:2"]);
		expect(state.toolCalls.map((call) => call.status)).toEqual([
			"success",
			"error",
			"success",
		]);
		for (const [index, [input]] of calls.entries()) {
			expect(input).toMatchObject({
				userId: "user-1",
				organizationId: "org-1",
				advisorResultStore: {
					conversationId: "example-conversation",
					turnId: "example-turn",
					sourceKey: `exec-advisor-1:${index}`,
					toolName: "example_read",
				},
			});
		}
	});

	it.each([
		{},
		{ conversationId: "example-conversation" },
		{ turnId: "example-turn" },
	])(
		"does not add store metadata without both chat identifiers: %j",
		async (input) => {
			const tools = fixture("example content");
			await runTurn(mocks, {
				...tools,
				message: "Read the evidence",
				input,
				steps: [call("example_read"), done],
			});
			expect(
				mocks.stub("executeMcpTool").mock.calls[0][0],
			).not.toHaveProperty("advisorResultStore");
		},
	);
});
