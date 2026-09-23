/**
 * The deterministic fallback for a budget-exhausted turn. Behind
 * `orch-synthesis-compacted-v1` it names this answer's step budget (as the
 * handoff card does) and carries the latest findings; without the flag the
 * text is exactly what histories recorded before the change produced.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: vi.fn(() => true),
	proxyActivities: vi.fn(() => ({})),
}));

const { summarizeAccomplishments } = await import("../iterative-execution");

type State = Parameters<typeof summarizeAccomplishments>[0];

const state = {
	enrichedMessage: "Find stale feature flags",
	currentIteration: 14,
	toolCalls: [
		{
			id: "1",
			name: "code_search",
			args: { query: "flag" },
			result: "services/billing/flags.ts: LEGACY_CHECKOUT still read",
			status: "success",
			durationMs: 5,
		},
		{
			id: "2",
			name: "code_tree",
			args: {},
			result: { error: "timeout" },
			status: "error",
			durationMs: 5,
		},
	],
} as unknown as State;

describe("summarizeAccomplishments", () => {
	it("keeps the original text without the flag", () => {
		const text = summarizeAccomplishments(state);
		expect(text).toContain(
			"Reached the conversation limit after 14 iteration(s). Made 2 tool call(s) — 1 successful, 1 failed.",
		);
		expect(text).toContain(
			"## To continue\n\nOpen a new chat. The summary above will be carried over as context.",
		);
		expect(text).not.toContain("What I found so far");
	});

	it("names the step budget and carries the latest findings with the flag", () => {
		const text = summarizeAccomplishments(state, { includeFindings: true });
		expect(text).toContain(
			"Ran out of this answer's step budget after 14 iteration(s).",
		);
		expect(text).not.toContain("conversation limit");
		expect(text).toContain("## What I found so far");
		expect(text).toContain("LEGACY_CHECKOUT still read");
		expect(text).toContain("Ask me to continue, narrow the question");
	});
});
