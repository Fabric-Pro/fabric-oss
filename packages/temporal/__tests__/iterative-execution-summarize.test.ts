/**
 * summarizeAccomplishments — deterministic fallback for budget-exhaustion synthesis.
 *
 * The exhaustion path produces this output verbatim when the LLM-driven
 * synthesis returns < MIN_USEFUL_SYNTHESIS_CHARS. It must be useful on its
 * own: the user may see this string verbatim as their final response.
 *
 * Locking the format also locks the failure modes — the prior implementation
 * regressed silently to "tool names only" output (production incident,
 * 2026-04-29).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: vi.fn(() => true),
	proxyActivities: vi.fn(() => ({})),
	workflowInfo: vi.fn(() => ({ unsafe: { isReplaying: false } })),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import { summarizeAccomplishments } from "../src/workflows/orchestrator/phases/iterative-execution";
import type { WorkflowState } from "../src/workflows/orchestrator/types";

type ToolCall = WorkflowState["toolCalls"][number];

function tc(
	name: string,
	args: unknown,
	status: ToolCall["status"] = "success",
): ToolCall {
	return {
		id: `tc-${name}-${Math.random().toString(36).slice(2, 6)}`,
		name,
		args,
		result: undefined,
		status,
		durationMs: 100,
	};
}

function buildState(overrides: Partial<WorkflowState> = {}): WorkflowState {
	return {
		executionId: "orch-test",
		enrichedMessage: "",
		toolCalls: [],
		currentIteration: 0,
		...overrides,
	} as unknown as WorkflowState;
}

describe("summarizeAccomplishments", () => {
	it("includes the original task heading when enrichedMessage is set", () => {
		const out = summarizeAccomplishments(
			buildState({
				enrichedMessage: "Review PR #8966 in Example_SaaS",
			}),
		);
		expect(out).toContain("## Original request");
		expect(out).toContain("Review PR #8966 in Example_SaaS");
	});

	it("truncates a very long original task with an ellipsis", () => {
		const long = "x".repeat(1000);
		const out = summarizeAccomplishments(
			buildState({ enrichedMessage: long }),
		);
		expect(out).toContain("…");
		// The whole original task should not be in the output verbatim.
		expect(out.includes(long)).toBe(false);
	});

	it("handles the empty-toolCalls case with the iteration count", () => {
		const out = summarizeAccomplishments(
			buildState({
				enrichedMessage: "Do the thing",
				currentIteration: 3,
				toolCalls: [],
			}),
		);
		expect(out).toContain("3 iteration");
		expect(out).toContain("To continue");
	});

	it("groups identical tool names with counts and lists distinguishing args", () => {
		const out = summarizeAccomplishments(
			buildState({
				currentIteration: 2,
				toolCalls: [
					tc("repo_list_directory", { path: "/a/b" }),
					tc("repo_list_directory", { path: "/a/b/c" }),
					tc("repo_list_directory", { path: "/a/b/d" }),
					tc("repo_get_pull_request_by_id", { pullRequestId: 8966 }),
				],
			}),
		);
		// Tool grouping: each tool name appears exactly once with a count.
		expect(out.match(/\*\*repo_list_directory\*\*/g)?.length).toBe(1);
		expect(out).toContain("repo_list_directory** (×3)");
		expect(out).toContain("repo_get_pull_request_by_id** (×1)");
		// Identifying args are present.
		expect(out).toContain('path="/a/b"');
		expect(out).toContain("pullRequestId=8966");
	});

	it("never reports just tool names with no args (the regression case)", () => {
		// This is the exact failure the original incident produced: the
		// summary was a literal list of tool names with nothing to act on.
		const state = buildState({
			currentIteration: 9,
			toolCalls: [
				tc("repo_list_directory", { path: "/foo" }),
				tc("repo_list_directory", { path: "/bar" }),
				tc("repo_list_directory", { path: "/baz" }),
			],
		});
		const out = summarizeAccomplishments(state);
		// Confirm the summary contains specific arg values, not just the tool name.
		expect(out).toMatch(/path="\/foo"/);
		expect(out).toMatch(/path="\/bar"/);
		expect(out).toMatch(/path="\/baz"/);
	});

	it("flags failed calls so the user can see what didn't work", () => {
		const out = summarizeAccomplishments(
			buildState({
				currentIteration: 2,
				toolCalls: [
					tc("repo_get_file", { path: "/a" }, "success"),
					tc("repo_get_file", { path: "/b" }, "error"),
				],
			}),
		);
		expect(out).toContain("1 failed");
		expect(out).toContain("— failed");
	});

	it("caps long string arg values to keep the output compact", () => {
		const long = "y".repeat(500);
		const out = summarizeAccomplishments(
			buildState({
				toolCalls: [tc("search_code", { query: long })],
			}),
		);
		// Truncation marker is present and the full value is not.
		expect(out).toContain("…");
		expect(out.includes(long)).toBe(false);
	});

	it("skips nested-object args rather than dumping their JSON", () => {
		const out = summarizeAccomplishments(
			buildState({
				toolCalls: [
					tc("complex_tool", {
						scalar: 42,
						nested: { deep: { stuff: "x" } },
					}),
				],
			}),
		);
		expect(out).toContain("scalar=42");
		expect(out).not.toContain("deep");
	});

	it("limits the number of unique tools listed and notes the rest", () => {
		const tools = Array.from({ length: 12 }, (_, i) =>
			tc(`tool_${String.fromCharCode(65 + i)}`, { i }),
		);
		const out = summarizeAccomplishments(buildState({ toolCalls: tools }));
		expect(out).toMatch(/and 4 other tool/);
	});

	it("limits per-tool call detail and reports the overflow", () => {
		const calls = Array.from({ length: 10 }, (_, i) =>
			tc("repo_list_directory", { path: `/p${i}` }),
		);
		const out = summarizeAccomplishments(buildState({ toolCalls: calls }));
		expect(out).toContain("repo_list_directory** (×10)");
		expect(out).toMatch(/\(\d+ more\)/);
	});

	it("is deterministic — same state yields the same output", () => {
		const state = buildState({
			enrichedMessage: "do work",
			currentIteration: 4,
			toolCalls: [
				tc("a", { x: 1 }),
				tc("b", { y: 2 }),
				tc("a", { x: 3 }),
			],
		});
		expect(summarizeAccomplishments(state)).toBe(
			summarizeAccomplishments(state),
		);
	});

	it("never returns the empty string for any state shape", () => {
		expect(summarizeAccomplishments(buildState()).length).toBeGreaterThan(
			0,
		);
		expect(
			summarizeAccomplishments(
				buildState({ enrichedMessage: "x", currentIteration: 1 }),
			).length,
		).toBeGreaterThan(0);
		expect(
			summarizeAccomplishments(buildState({ toolCalls: [tc("t", {})] }))
				.length,
		).toBeGreaterThan(0);
	});
});
