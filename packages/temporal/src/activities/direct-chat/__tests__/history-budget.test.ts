import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONTEXT_WINDOW_TOKENS,
	fitHistoryToContext,
	historyCharBudget,
	omittedHistoryNote,
	resolveContextWindow,
} from "../history-budget";

/**
 * Direct replayed the whole transcript with no input budget, so a thread
 * with a few large pastes outgrew the model's window and every later turn
 * failed at the provider (review F38).
 */
const turn = (i: number, chars: number) => ({
	role: i % 2 === 0 ? "user" : "assistant",
	content: `${i}:${"x".repeat(chars)}`,
});

describe("fitHistoryToContext", () => {
	it("keeps a history that fits unchanged", () => {
		const history = [turn(0, 100), turn(1, 100)];
		const fitted = fitHistoryToContext({
			history,
			contextWindow: 200_000,
			fixedPromptChars: 10_000,
		});
		expect(fitted).toEqual({
			history,
			omittedCount: 0,
			truncatedNewest: false,
		});
	});

	it("drops the oldest turns of a history past the window, keeping the newest", () => {
		// 40 turns of 30k chars = 1.2M chars; a 128k-token window cannot hold it.
		const history = Array.from({ length: 40 }, (_, i) => turn(i, 30_000));
		const fitted = fitHistoryToContext({
			history,
			contextWindow: 128_000,
			fixedPromptChars: 20_000,
		});
		const kept = fitted.history.reduce(
			(sum, entry) => sum + entry.content.length,
			0,
		);
		expect(fitted.omittedCount).toBeGreaterThan(0);
		expect(kept).toBeLessThanOrEqual(
			historyCharBudget({
				contextWindow: 128_000,
				fixedPromptChars: 20_000,
			}),
		);
		expect(fitted.history.at(-1)).toBe(history.at(-1));
		expect(fitted.history[0]).toBe(
			history[history.length - fitted.history.length],
		);
	});

	it("falls back to a conservative window when the model has none", () => {
		const history = Array.from({ length: 10 }, (_, i) => turn(i, 20_000));
		const withoutWindow = fitHistoryToContext({
			history,
			fixedPromptChars: 0,
		});
		expect(historyCharBudget({ fixedPromptChars: 0 })).toBeLessThan(
			DEFAULT_CONTEXT_WINDOW_TOKENS * 3,
		);
		expect(withoutWindow.omittedCount).toBeGreaterThan(0);
	});

	it("cuts one oversized newest entry instead of dropping everything", () => {
		const history = [turn(0, 10), turn(1, 2_000_000)];
		const fitted = fitHistoryToContext({
			history,
			contextWindow: 200_000,
			fixedPromptChars: 0,
		});
		expect(fitted.truncatedNewest).toBe(true);
		expect(fitted.history).toHaveLength(1);
		expect(fitted.history[0].content.length).toBeLessThan(
			history[1].content.length,
		);
		expect(fitted.history[0].content.endsWith("x")).toBe(true);
	});
});

describe("fitHistoryToContext — floors and empty turns", () => {
	it("keeps recent turns when a heavy system context leaves no room on paper", () => {
		const history = Array.from({ length: 20 }, (_, i) => turn(i, 200));
		const fitted = fitHistoryToContext({
			history,
			fixedPromptChars: 100_000,
		});
		expect(fitted.history.length).toBeGreaterThanOrEqual(15);
		expect(fitted.history.at(-1)).toBe(history.at(-1));
	});

	it("skips empty turns, which the provider refuses", () => {
		const history = [
			{ role: "user", content: "Build the diagram" },
			{ role: "assistant", content: "" },
			{ role: "user", content: "Continue from where you stopped." },
			{ role: "assistant", content: "   " },
		];
		const fitted = fitHistoryToContext({
			history,
			contextWindow: 200_000,
			fixedPromptChars: 0,
		});
		expect(fitted.history.map((e) => e.content)).toEqual([
			"Build the diagram",
			"Continue from where you stopped.",
		]);
		expect(fitted.omittedCount).toBe(0);
	});
});

describe("resolveContextWindow", () => {
	const lookup = (id: string) =>
		id === "claude-sonnet-5" ? 200_000 : undefined;

	it("uses the resolved model's window", () => {
		expect(resolveContextWindow({ contextWindow: 128_000 }, lookup)).toBe(
			128_000,
		);
	});

	it("looks up a picker-selected model in the catalog", () => {
		expect(
			resolveContextWindow(
				{ canonicalName: "claude-sonnet-5", modelString: "prod-chat" },
				lookup,
			),
		).toBe(200_000);
	});

	it("leaves an unknown model to the conservative default", () => {
		expect(
			resolveContextWindow({ modelString: "my-endpoint" }, lookup),
		).toBeUndefined();
	});
});

describe("omittedHistoryNote", () => {
	it("says nothing when nothing was left out", () => {
		expect(
			omittedHistoryNote({ omittedCount: 0, truncatedNewest: false }),
		).toBeNull();
	});

	it("tells the model how many messages it cannot see", () => {
		expect(
			omittedHistoryNote({ omittedCount: 12, truncatedNewest: false }),
		).toMatch(/12 earliest messages/);
	});
});
