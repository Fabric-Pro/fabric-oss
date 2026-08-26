/**
 * `buildWorkflowOutput` — tool-call truncation tests.
 *
 * Regression for the bug where Excalidraw `create_view` payloads (~6-100KB
 * elements arrays) were being replaced with the truncation sentinel string
 * because the default 5KB cap was applied to every tool call. The sentinel
 * then arrived on the `completed`/`step_complete` SSE events and overwrote
 * the live-streamed args on the frontend, leaving the inline iframe with
 * an empty canvas while the dedicated panel (which re-fetches via
 * `read_checkpoint`) still rendered.
 *
 * The fix introduces:
 *   - a per-MCP-App-tool-call cap of 500KB (vs. the 5KB default), and
 *   - a shared per-workflow-output budget of 1.5MB summed across MCP App
 *     tool call payloads — bounds total output so a turn that produced
 *     many large diagrams cannot blow Temporal's 2MB payload limit.
 *
 * Plain (non-MCP-App) tool calls keep the 5KB cap unchanged. The same
 * tool call appearing in both `state.toolCalls` and the nested
 * `stepResults[].toolCalls` is deduped — its budget is charged once and
 * the same truncation decision is applied in both places.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/workflow", () => ({
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	patched: vi.fn(() => true),
	proxyActivities: vi.fn(() => ({})),
	workflowInfo: vi.fn(() => ({
		runId: "test-run-id",
		unsafe: { isReplaying: false },
	})),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import { createInitialState, type WorkflowState } from "../../types";
import { buildWorkflowOutput } from "../completion";

function buildState(overrides: Partial<WorkflowState> = {}): WorkflowState {
	const base = createInitialState({
		executionId: "exec-truncation-1",
		message: "ignored for these tests",
		userId: "user-1",
		organizationId: undefined,
		executionMode: "balanced",
	} as Parameters<typeof createInitialState>[0]);
	return { ...base, ...overrides };
}

// A fake elements array large enough to exceed the default 5KB cap by ~6x.
// Mirrors the shape Excalidraw `create_view` actually sends; the exact
// element fields don't matter — only that the JSON is large.
function buildLargeElements(count = 80): Array<Record<string, unknown>> {
	return Array.from({ length: count }, (_, i) => ({
		type: i % 2 === 0 ? "rectangle" : "text",
		id: `elem-${i}`,
		x: i * 12,
		y: i * 8,
		width: 200,
		height: 80,
		strokeColor: "#1e40af",
		backgroundColor: "#dbeafe",
		fillStyle: "solid",
		strokeWidth: 2,
		strokeStyle: "solid",
		roughness: 1,
		opacity: 100,
		groupIds: [],
		seed: 100_000 + i,
		version: 1,
		versionNonce: 200_000 + i,
		isDeleted: false,
		boundElements: [],
		updated: 1_700_000_000_000,
		link: null,
		locked: false,
		text: `Diagram element ${i} — placeholder text`,
		fontSize: 16,
		fontFamily: 1,
		textAlign: "center",
		verticalAlign: "middle",
		baseline: 14,
	}));
}

const TRUNCATION_SENTINEL_PREFIX = "[Object truncated,";

describe("buildWorkflowOutput — tool-call truncation", () => {
	it("preserves args/result on tool calls with `mcpAppResourceUri` (Excalidraw payload survives)", () => {
		const elements = buildLargeElements();
		const elementsJsonSize = JSON.stringify({ elements }).length;
		// Sanity: the payload must exceed the default 5KB cap to make this
		// test meaningful. If someone shrinks `buildLargeElements` below
		// the cap, the test would silently pass for the wrong reason.
		expect(elementsJsonSize).toBeGreaterThan(5_000);
		// And it must fit inside the per-call MCP App cap (500KB).
		expect(elementsJsonSize).toBeLessThan(500_000);

		const state = buildState({
			toolCalls: [
				{
					id: "tc-1",
					name: "create_view",
					args: { elements },
					result: {
						content: [
							{
								type: "text",
								text: 'Diagram displayed! Checkpoint id: "abc123".',
							},
						],
					},
					status: "success",
					durationMs: 42,
					mcpAppResourceUri: "ui://excalidraw/canvas-1",
					mcpAppConfigId: "cfg-excalidraw-1",
				},
			],
		});

		const output = buildWorkflowOutput(state, "completed");

		expect(output.toolCalls).toHaveLength(1);
		const tc = output.toolCalls[0];
		// Args MUST be the original object — the inline iframe needs the
		// full elements array to render the canvas. A sentinel string
		// here would re-introduce the regression.
		expect(typeof tc.args).toBe("object");
		expect(tc.args).toEqual({ elements });
		expect(tc.result).toEqual({
			content: [
				{
					type: "text",
					text: 'Diagram displayed! Checkpoint id: "abc123".',
				},
			],
		});
		// MCP App fields propagate so the frontend still mounts the iframe.
		expect(tc.mcpAppResourceUri).toBe("ui://excalidraw/canvas-1");
		expect(tc.mcpAppConfigId).toBe("cfg-excalidraw-1");
	});

	it("still truncates oversized args/result on plain (non-MCP-App) tool calls", () => {
		const bigBlob = "x".repeat(20_000);
		const state = buildState({
			toolCalls: [
				{
					id: "tc-2",
					name: "some_other_tool",
					args: { huge: bigBlob },
					result: { huge: bigBlob },
					status: "success",
					durationMs: 10,
				},
			],
		});

		const output = buildWorkflowOutput(state, "completed");

		const tc = output.toolCalls[0];
		// Both args and result are objects whose JSON exceeds 5KB and
		// have no MCP App URI → the existing truncation sentinel applies.
		expect(typeof tc.args).toBe("string");
		expect(tc.args).toContain(TRUNCATION_SENTINEL_PREFIX);
		expect(typeof tc.result).toBe("string");
		expect(tc.result).toContain(TRUNCATION_SENTINEL_PREFIX);
	});

	it("applies the same MCP-App exemption to nested step-result tool calls", () => {
		const elements = buildLargeElements();
		const state = buildState({
			stepResults: [
				{
					stepId: "step-1",
					stepDescription: "Render the diagram",
					status: "complete",
					response: "ok",
					durationMs: 100,
					toolCalls: [
						{
							id: "tc-step-1",
							name: "create_view",
							args: { elements },
							result: { ok: true },
							status: "success",
							durationMs: 42,
							mcpAppResourceUri: "ui://excalidraw/canvas-2",
							mcpAppConfigId: "cfg-excalidraw-2",
						},
						{
							id: "tc-step-2",
							name: "some_other_tool",
							args: { huge: "y".repeat(20_000) },
							result: { huge: "y".repeat(20_000) },
							status: "success",
							durationMs: 5,
						},
					],
				},
			],
		});

		const output = buildWorkflowOutput(state, "completed");

		const stepToolCalls = output.stepResults?.[0]?.toolCalls ?? [];
		expect(stepToolCalls).toHaveLength(2);

		// MCP App tool call — preserved.
		expect(stepToolCalls[0].args).toEqual({ elements });
		expect(stepToolCalls[0].mcpAppResourceUri).toBe(
			"ui://excalidraw/canvas-2",
		);

		// Plain tool call in the same step — still truncated.
		expect(typeof stepToolCalls[1].args).toBe("string");
		expect(stepToolCalls[1].args).toContain(TRUNCATION_SENTINEL_PREFIX);
	});

	it("truncates MCP-App tool calls when their payload exceeds the 500KB per-call cap", () => {
		// Pathological case: a huge string in `args.huge` whose JSON
		// length is well over 500KB. Even MCP App tool calls fall back
		// to the sentinel so we never blow the workflow output budget.
		const oversizedBlob = "z".repeat(700_000);
		const state = buildState({
			toolCalls: [
				{
					id: "tc-huge",
					name: "create_view",
					args: { huge: oversizedBlob },
					result: { ok: true },
					status: "success",
					durationMs: 1,
					mcpAppResourceUri: "ui://excalidraw/canvas-huge",
					mcpAppConfigId: "cfg-excalidraw-huge",
				},
			],
		});

		const output = buildWorkflowOutput(state, "completed");

		const tc = output.toolCalls[0];
		// args was 700KB — over the 500KB per-call cap, so it gets the
		// default 5KB-cap sentinel.
		expect(typeof tc.args).toBe("string");
		expect(tc.args).toContain(TRUNCATION_SENTINEL_PREFIX);
		// Resource URI / config ID still propagate so the dedicated
		// panel (which re-fetches via checkpoint) keeps working.
		expect(tc.mcpAppResourceUri).toBe("ui://excalidraw/canvas-huge");
		expect(tc.mcpAppConfigId).toBe("cfg-excalidraw-huge");
	});

	it("enforces a shared 1.5MB budget across many MCP App tool calls so the workflow output stays bounded", () => {
		// Build a payload where 8 tool calls × payload-per-call will
		// exceed the 1.5MB budget but each individual call is under the
		// 500KB per-call cap. Concrete sizing is checked at runtime so
		// the test stays valid as element JSON shape evolves.
		const mediumElements = buildLargeElements(600);
		const sizePerCall = JSON.stringify({
			args: { elements: mediumElements },
			result: { ok: true },
		}).length;
		expect(sizePerCall).toBeLessThan(500_000);
		// 8 × sizePerCall must exceed 1.5MB for the test to be
		// meaningful (otherwise no truncation would fire).
		expect(sizePerCall * 8).toBeGreaterThan(1_500_000);

		const state = buildState({
			toolCalls: Array.from({ length: 8 }, (_, i) => ({
				id: `tc-budget-${i}`,
				name: "create_view",
				args: { elements: mediumElements },
				result: { ok: true },
				status: "success" as const,
				durationMs: 10,
				mcpAppResourceUri: `ui://excalidraw/canvas-${i}`,
				mcpAppConfigId: "cfg-excalidraw-shared",
			})),
		});

		const output = buildWorkflowOutput(state, "completed");

		// Some prefix of the tool calls are preserved (objects); the
		// rest fall back to the sentinel string. Not every prefix
		// length is exact because the budget bookkeeping is per-call,
		// not fractional — but the budget MUST cap the total preserved
		// bytes and at least one call must be truncated.
		let preservedBytes = 0;
		let preservedCount = 0;
		let truncatedCount = 0;
		for (const tc of output.toolCalls) {
			if (typeof tc.args === "object") {
				preservedCount += 1;
				preservedBytes += JSON.stringify({
					args: tc.args,
					result: tc.result,
				}).length;
			} else {
				expect(tc.args).toContain(TRUNCATION_SENTINEL_PREFIX);
				truncatedCount += 1;
			}
		}
		expect(preservedCount).toBeGreaterThan(0);
		expect(truncatedCount).toBeGreaterThan(0);
		// Total preserved payload is bounded by the 1.5MB budget. Each
		// preserved call's actual size MUST have fit within `remaining`
		// at the time of consumption, so the cumulative preserved size
		// is at most 1.5MB.
		expect(preservedBytes).toBeLessThanOrEqual(1_500_000);
	});

	it("dedupes the budget when the same tool call appears in both flat and nested lists", () => {
		// Same tool call (same id) appears in both `toolCalls` and
		// inside a `stepResults[].toolCalls` list. The budget must
		// charge it once so both lists get the same truncation
		// decision (preserved, in this case) — otherwise the frontend
		// would see inconsistent args between the flat list and the
		// step list.
		const elements = buildLargeElements();
		const sharedToolCall = {
			id: "tc-shared",
			name: "create_view",
			args: { elements },
			result: { ok: true },
			status: "success" as const,
			durationMs: 42,
			mcpAppResourceUri: "ui://excalidraw/canvas-shared",
			mcpAppConfigId: "cfg-excalidraw-shared",
		};
		const state = buildState({
			toolCalls: [sharedToolCall],
			stepResults: [
				{
					stepId: "step-1",
					stepDescription: "Render the diagram",
					status: "complete",
					response: "ok",
					durationMs: 100,
					toolCalls: [sharedToolCall],
				},
			],
		});

		const output = buildWorkflowOutput(state, "completed");

		const flat = output.toolCalls[0];
		const nested = output.stepResults?.[0]?.toolCalls?.[0];
		// Both copies must be preserved (objects), not truncated.
		expect(typeof flat.args).toBe("object");
		expect(typeof nested?.args).toBe("object");
		expect(flat.args).toEqual({ elements });
		expect(nested?.args).toEqual({ elements });
	});
});
