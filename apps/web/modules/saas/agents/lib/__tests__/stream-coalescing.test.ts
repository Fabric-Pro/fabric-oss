import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectStreamMessage } from "../../hooks/useDirectStream";
import {
	applyDirectStreamEvent,
	applyReasoningDuration,
	type DirectStreamEventContext,
} from "../direct-stream-events";
import { OrchestratorTextBuffer } from "../orchestrator-text-buffer";
import { ProgressPhaseTracker } from "../progress-phase-tracker";

afterEach(() => vi.useRealTimers());
describe("stream coalescing", () => {
	it("does not alternate steady progress sources across polls", () => {
		const phases = new ProgressPhaseTracker();
		const emitted = [];
		for (let poll = 0; poll < 5; poll++) {
			phases.beginPoll();
			if (phases.changed("heartbeat", "streaming")) {
				emitted.push("streaming");
			}
			if (phases.changed("workflow", "executing_ai")) {
				emitted.push("executing_ai");
			}
		}
		expect(emitted).toEqual(["streaming"]);
		expect(phases.changed("workflow", "completed")).toBe(true);
	});
	it("commits deltas together at 100ms and flushes before other events", () => {
		vi.useFakeTimers();
		const apply = vi.fn();
		const buffer = new OrchestratorTextBuffer(apply);
		for (const content of ["a", "b", "c"]) {
			buffer.push({ type: "text_delta", content }, "m");
		}
		expect(apply).not.toHaveBeenCalled();
		vi.advanceTimersByTime(100);
		expect(apply.mock.calls).toEqual([
			[{ type: "text_delta", content: "abc" }, "m"],
		]);
		buffer.push({ type: "text_delta", content: "d" }, "m");
		buffer.push({ type: "text_start" }, "m");
		expect(apply.mock.calls.slice(1)).toEqual([
			[{ type: "text_delta", content: "d" }, "m"],
			[{ type: "text_start" }, "m", false],
		]);
	});
	it("forwards the resume flag with a non-text event", () => {
		const apply = vi.fn();
		const buffer = new OrchestratorTextBuffer(apply);
		const started = {
			type: "started",
			executionId: "orch-example",
			resumed: true,
		} as const;
		buffer.push(started, "m", true);
		expect(apply.mock.calls).toEqual([[started, "m", true]]);
	});
	it("drops queued text and clears the timer on teardown", () => {
		vi.useFakeTimers();
		const apply = vi.fn();
		const buffer = new OrchestratorTextBuffer(apply);
		buffer.push({ type: "text_delta", content: "old" }, "m");
		buffer.drop();
		expect(vi.getTimerCount()).toBe(0);
		vi.runAllTimers();
		expect(apply).not.toHaveBeenCalled();
	});
});

it("preserves messages identity for an unchanged Direct caption", () => {
	const messages = [
		{ id: "m", role: "assistant", content: "", statusLabel: "Working" },
	] as DirectStreamMessage[];
	const setMessages = vi.fn((update) =>
		expect(update(messages)).toBe(messages),
	);
	applyDirectStreamEvent({ type: "progress", message: "Working" }, "m", {
		setMessages,
		cancelledMessageIdsRef: { current: new Set() },
	} as unknown as DirectStreamEventContext);
	expect(setMessages).toHaveBeenCalledOnce();
});

it("emits a heartbeat moving away and back with same-poll precedence", () => {
	const tracker = new ProgressPhaseTracker();
	for (const [heartbeat, workflow] of [
		["streaming", "executing_ai"],
		["tool_input", "collecting_tools"],
		["streaming", "executing_ai"],
	]) {
		tracker.beginPoll();
		expect(tracker.changed("heartbeat", heartbeat)).toBe(true);
		expect(tracker.changed("workflow", workflow)).toBe(false);
	}
	tracker.beginPoll();
	expect(tracker.changed("heartbeat", "streaming")).toBe(false);
	expect(tracker.changed("workflow", "completed")).toBe(true);
});
it("preserves reasoning duration identity only for equal values", () => {
	const messages = [
		{ id: "m", role: "assistant", content: "", reasoningDurationMs: 100 },
	] as DirectStreamMessage[];
	expect(applyReasoningDuration(messages, "m", 100)).toBe(messages);
	const changed = applyReasoningDuration(messages, "m", 200);
	expect(changed).not.toBe(messages);
	expect(changed[0].reasoningDurationMs).toBe(200);
});
