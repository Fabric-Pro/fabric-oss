import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emitCancelEvent } from "../../lib/cancel-telemetry";
import { useOrchestratorTurnState } from "../useOrchestratorTurnState";

vi.mock("../useOrchestratorPartyKit", () => ({
	useOrchestratorPartyKit: () => ({
		toolCalls: [],
		reset: vi.fn(),
		notifyStepStart: vi.fn(),
	}),
}));
vi.mock("../../lib/cancel-telemetry", () => ({ emitCancelEvent: vi.fn() }));
afterEach(() => vi.useRealTimers());

it("flushes Stop before the freeze gate and drops text on reset and unmount", () => {
	vi.useFakeTimers();
	const { result, unmount } = renderHook(() => useOrchestratorTurnState({}));
	let id = "";
	act(() => {
		id = result.current.beginTurn({
			content: "hi",
			displayImageUrls: undefined,
			forceNewChat: false,
			attachExecutionId: null,
			clientRequestKey: null,
			conversationId: null,
		}).assistantMessage.id;
	});
	act(() =>
		result.current.handleStreamEvent(
			{ type: "text_delta", content: "partial" },
			id,
		),
	);
	expect(result.current.messages[1].content).toBe("");
	act(() => result.current.flipToStopped("button"));
	expect(result.current.messages[1].content).toBe("partial");
	act(() => {
		result.current.handleStreamEvent(
			{ type: "text_delta", content: "late" },
			id,
		);
		vi.advanceTimersByTime(100);
	});
	expect(result.current.messages[1].content).toBe("partial");
	act(() => result.current.reset());
	act(() => {
		id = result.current.beginTurn(beginInput).assistantMessage.id;
	});
	act(() =>
		result.current.handleStreamEvent(
			{ type: "text_delta", content: "pending reset" },
			id,
		),
	);
	expect(vi.getTimerCount()).toBe(1);
	act(() => result.current.reset());
	expect(vi.getTimerCount()).toBe(0);
	act(() => vi.advanceTimersByTime(100));
	expect(result.current.messages).toEqual([]);
	act(() =>
		result.current.handleStreamEvent(
			{ type: "text_delta", content: "stale" },
			"other",
		),
	);
	unmount();
	expect(vi.getTimerCount()).toBe(0);
});

it.each(["completed", "error"] as const)(
	"flushes before %s and preserves tool separators and replacement",
	(type) => {
		vi.useFakeTimers();
		const { result } = renderHook(() => useOrchestratorTurnState({}));
		let id = "";
		act(() => {
			id = result.current.beginTurn({
				content: "hi",
				displayImageUrls: undefined,
				forceNewChat: false,
				attachExecutionId: null,
				clientRequestKey: null,
				conversationId: null,
			}).assistantMessage.id;
		});
		act(() => {
			result.current.handleStreamEvent(
				{ type: "text_delta", content: "old" },
				id,
			);
			result.current.handleStreamEvent({ type: "text_start" }, id);
			result.current.handleStreamEvent(
				{ type: "text_delta", content: "new" },
				id,
			);
			result.current.handleStreamEvent(
				{ type: "tool_start", toolName: "search", toolCallId: "t" },
				id,
			);
			result.current.handleStreamEvent(
				{ type: "text_delta", content: "end" },
				id,
			);
			result.current.handleStreamEvent({ type }, id);
		});
		expect(result.current.messages[1].content).toBe("new\n\nend");
		expect(vi.getTimerCount()).toBe(0);
	},
);

const beginInput = {
	content: "hi",
	displayImageUrls: undefined,
	forceNewChat: false,
	attachExecutionId: null,
	clientRequestKey: null,
	conversationId: null,
};
it("drops pending text before beginning a new turn", () => {
	vi.useFakeTimers();
	const { result } = renderHook(() => useOrchestratorTurnState({}));
	let first = "";
	act(() => {
		first = result.current.beginTurn(beginInput).assistantMessage.id;
	});
	act(() =>
		result.current.handleStreamEvent(
			{ type: "text_delta", content: "stale" },
			first,
		),
	);
	expect(vi.getTimerCount()).toBe(1);
	act(() => {
		result.current.beginTurn({ ...beginInput, forceNewChat: true });
	});
	expect(vi.getTimerCount()).toBe(0);
	act(() => vi.advanceTimersByTime(100));
	expect(result.current.messages[1].content).toBe("");
});
it.each(["append", "separator", "replace"])(
	"counts pending Stop text for %s",
	(mode) => {
		vi.useFakeTimers();
		vi.mocked(emitCancelEvent).mockClear();
		const { result } = renderHook(() => useOrchestratorTurnState({}));
		let id = "";
		act(() => {
			id = result.current.beginTurn(beginInput).assistantMessage.id;
		});
		act(() => {
			result.current.handleStreamEvent(
				{ type: "text_delta", content: "prior" },
				id,
			);
			vi.advanceTimersByTime(100);
		});
		if (mode === "separator") {
			act(() =>
				result.current.handleStreamEvent(
					{ type: "tool_start", toolName: "search", toolCallId: "t" },
					id,
				),
			);
		}
		if (mode === "replace") {
			act(() =>
				result.current.handleStreamEvent({ type: "text_start" }, id),
			);
		}
		act(() =>
			result.current.handleStreamEvent(
				{ type: "text_delta", content: "pending" },
				id,
			),
		);
		act(() => result.current.flipToStopped("button"));
		const body =
			mode === "replace"
				? "pending"
				: mode === "separator"
					? "prior\n\npending"
					: "priorpending";
		expect(result.current.messages[1].content).toBe(body);
		expect(emitCancelEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				partial_token_count: Math.ceil(body.length / 4),
			}),
		);
	},
);

it("ignores a late deferred clear from a stopped message", () => {
	vi.useFakeTimers();
	const { result } = renderHook(() => useOrchestratorTurnState({}));
	let stopped = "";
	act(() => {
		stopped = result.current.beginTurn(beginInput).assistantMessage.id;
	});
	act(() => result.current.flipToStopped("button"));
	// Message ids come from Date.now(); keep the two turns distinct.
	vi.advanceTimersByTime(1);
	let next = "";
	act(() => {
		next = result.current.beginTurn(beginInput).assistantMessage.id;
	});
	act(() => {
		result.current.handleStreamEvent(
			{ type: "text_delta", content: "Kept" },
			next,
		);
		result.current.flushStreamingText();
	});
	act(() => {
		result.current.deferClearOnNextDelta(stopped);
		result.current.handleStreamEvent(
			{ type: "text_delta", content: " tail" },
			next,
		);
		result.current.flushStreamingText();
	});
	expect(result.current.messages.at(-1)?.content).toBe("Kept tail");
});
