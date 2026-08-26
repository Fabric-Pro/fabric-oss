import { CoalescingEventGate } from "@repo/agent-core/unified-server";
import { describe, expect, it, vi } from "vitest";

describe("CoalescingEventGate", () => {
	it("passes events straight through while the consumer is draining", () => {
		const gate = new CoalescingEventGate<string>();
		expect(gate.offer("a", 1)).toEqual(["a"]);
		expect(gate.offer("b", 1)).toEqual(["b"]);
	});

	it("treats a null desiredSize as draining (unknown backpressure state)", () => {
		const gate = new CoalescingEventGate<string>();
		expect(gate.offer("a", null)).toEqual(["a"]);
	});

	it("holds only the latest event while desiredSize <= 0", () => {
		const gate = new CoalescingEventGate<string>();
		expect(gate.offer("a", 0)).toEqual([]);
		// "a" is replaced by "b" — never enqueued.
		expect(gate.offer("b", 0)).toEqual([]);
		expect(gate.offer("c", -5)).toEqual([]);
		expect(gate.flush()).toBe("c");
	});

	it("emits the held event, in order, once the consumer drains again", () => {
		const gate = new CoalescingEventGate<string>();
		gate.offer("a", 0);
		gate.offer("b", 0);
		// Consumer drains: the pending event flushes first, then the new one.
		expect(gate.offer("c", 1)).toEqual(["b", "c"]);
	});

	it("flush at end of stream returns the last pending event", () => {
		const gate = new CoalescingEventGate<string>();
		gate.offer("a", 0);
		gate.offer("b", 0);
		expect(gate.flush()).toBe("b");
	});

	it("flush returns null when nothing is pending", () => {
		const gate = new CoalescingEventGate<string>();
		expect(gate.flush()).toBeNull();
		gate.offer("a", 1);
		expect(gate.flush()).toBeNull();
	});

	it("flush clears the pending slot — a second flush returns null", () => {
		const gate = new CoalescingEventGate<string>();
		gate.offer("a", 0);
		expect(gate.flush()).toBe("a");
		expect(gate.flush()).toBeNull();
	});

	it("offer with no prior pending event while draining returns just the current event", () => {
		const gate = new CoalescingEventGate<string>();
		expect(gate.offer("only", 5)).toEqual(["only"]);
	});

	describe("barrier pattern (non-gated events preceded by an explicit flush)", () => {
		// Mirrors how unified-server.ts's sendEventWithBarrier uses the gate:
		// a non-droppable event is never offered to the gate — the caller
		// flushes any pending droppable event first (preserving order), then
		// delivers the non-droppable event directly.
		function sendWithBarrier(
			gate: CoalescingEventGate<string>,
			emitted: string[],
			event: string,
		) {
			const pending = gate.flush();
			if (pending !== null) {
				emitted.push(pending);
			}
			emitted.push(event);
		}

		it("delivers a droppable event held under backpressure BEFORE a barrier-guarded event", () => {
			const gate = new CoalescingEventGate<string>();
			const emitted: string[] = [];

			// Two droppable previews arrive while the consumer isn't draining —
			// only the latest is held.
			gate.offer("preview-1", 0);
			gate.offer("preview-2", 0);

			// A non-droppable event (e.g. a TOOL_CALL_START derived from newer
			// state) must flush the held preview first, so the consumer never
			// sees the tool call before the state it was built from.
			sendWithBarrier(gate, emitted, "tool-call-start");

			expect(emitted).toEqual(["preview-2", "tool-call-start"]);
			// The gate is empty afterwards — a second barrier call sends
			// nothing extra.
			sendWithBarrier(gate, emitted, "tool-call-end");
			expect(emitted).toEqual([
				"preview-2",
				"tool-call-start",
				"tool-call-end",
			]);
		});

		it("a barrier call with nothing pending only delivers the guarded event", () => {
			const gate = new CoalescingEventGate<string>();
			const emitted: string[] = [];
			sendWithBarrier(gate, emitted, "run-finished");
			expect(emitted).toEqual(["run-finished"]);
		});

		it("a repeat barrier call after the episode already flushed logs nothing extra", () => {
			// Regression: flush() used to log "flushed after dropping events"
			// on every call as long as droppedCount stayed nonzero, even with
			// nothing pending — so a run of several barrier-guarded events in
			// a row (TOOL_CALL_START/ARGS/END) repeated the same stale summary.
			const warn = vi.fn();
			const gate = new CoalescingEventGate<string>({ warn });
			const emitted: string[] = [];

			gate.offer("preview-1", 0);
			gate.offer("preview-2", 0); // preview-1 dropped

			sendWithBarrier(gate, emitted, "tool-call-start");
			expect(warn).toHaveBeenCalledTimes(2); // begin-warning + summary
			warn.mockClear();

			sendWithBarrier(gate, emitted, "tool-call-args");
			sendWithBarrier(gate, emitted, "tool-call-end");
			expect(warn).not.toHaveBeenCalled();
		});
	});

	describe("episode logging (begin-warning + summary, reset between episodes)", () => {
		it("logs exactly one begin-warning and one summary per episode", () => {
			const warn = vi.fn();
			const gate = new CoalescingEventGate<string>({ warn });

			gate.offer("a", 0);
			gate.offer("b", 0); // "a" dropped
			gate.offer("c", 0); // "b" dropped
			expect(warn).toHaveBeenCalledTimes(1); // begin-warning only, so far

			expect(gate.flush()).toBe("c");
			expect(warn).toHaveBeenCalledTimes(2); // + summary
			expect(warn).toHaveBeenLastCalledWith(
				"CoalescingEventGate: flushed after dropping events",
				{ droppedCount: 2 },
			);
		});

		it("resets episode state on drain via offer(), so a later episode re-logs its own begin-warning", () => {
			const warn = vi.fn();
			const gate = new CoalescingEventGate<string>({ warn });

			// Episode 1: held then drained via offer() while desiredSize > 0
			// (not via flush()).
			gate.offer("a", 0);
			gate.offer("b", 0); // "a" dropped
			expect(gate.offer("c", 1)).toEqual(["b", "c"]);
			expect(warn).toHaveBeenCalledTimes(1); // episode 1's begin-warning

			// A flush() right after episode 1 drained via offer() must stay
			// silent — nothing pending, and the drop count was reset already.
			expect(gate.flush()).toBeNull();
			expect(warn).toHaveBeenCalledTimes(1);

			// Episode 2: a fresh round of backpressure must log its OWN
			// begin-warning — proof droppingLogged was actually reset, not
			// left permanently true after episode 1.
			gate.offer("d", 0);
			gate.offer("e", 0); // "d" dropped
			expect(warn).toHaveBeenCalledTimes(2);
			expect(gate.flush()).toBe("e");
			expect(warn).toHaveBeenCalledTimes(3);
		});

		it("flush() with nothing pending and nothing dropped never logs", () => {
			const warn = vi.fn();
			const gate = new CoalescingEventGate<string>({ warn });
			expect(gate.flush()).toBeNull();
			expect(warn).not.toHaveBeenCalled();

			// Draining normally (no backpressure episode ever occurred).
			gate.offer("a", 1);
			expect(gate.flush()).toBeNull();
			expect(warn).not.toHaveBeenCalled();
		});
	});
});
