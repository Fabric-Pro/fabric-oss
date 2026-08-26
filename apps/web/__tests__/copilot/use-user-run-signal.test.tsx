/**
 * Unit tests for `useUserRunSignal` — the shared hook that distinguishes a
 * real, user-initiated agent generation from the AG-UI connect handshake
 * that fires `isLoading=true` on mount for any thread with persisted
 * history (see the hook's doc-comment). The "AI is generating…" pill in
 * StoryWorkspace/DocumentEditor gates on `isUserGenerationActive` instead
 * of raw `isLoading` to avoid flashing during that handshake.
 */

import { useUserRunSignal } from "@saas/shared/components/copilot/use-user-run-signal";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("useUserRunSignal", () => {
	// Regression pin: the bug this hook fixes. The AG-UI connect handshake
	// sets `isLoading` true and hydrates message history on mount with no
	// mark ever fired — the pill must stay hidden.
	it("stays inactive when isLoading is true but no run was marked (handshake)", () => {
		const { result } = renderHook(() => useUserRunSignal(true));

		expect(result.current.isUserGenerationActive).toBe(false);
	});

	// The mark can land before `isLoading` flips true (send → run-start gap:
	// the chat input's `onUserSend` fires synchronously before CopilotKit's
	// `onSend` kicks off the run). The mark must survive into the next
	// render where `isLoading` goes true.
	it("becomes active once isLoading flips true after an idle-time mark", () => {
		const { result, rerender } = renderHook(
			({ isLoading }) => useUserRunSignal(isLoading),
			{ initialProps: { isLoading: false } },
		);

		expect(result.current.isUserGenerationActive).toBe(false);

		result.current.markUserRunInitiated();
		rerender({ isLoading: false });
		expect(result.current.isUserGenerationActive).toBe(false);

		rerender({ isLoading: true });
		expect(result.current.isUserGenerationActive).toBe(true);
	});

	// Marking while a run is already in flight (e.g. a mark fired on the
	// same render `isLoading` goes true) must reflect immediately.
	it("becomes active immediately when marked while isLoading is already true", () => {
		const { result, rerender } = renderHook(
			({ isLoading }) => useUserRunSignal(isLoading),
			{ initialProps: { isLoading: true } },
		);

		expect(result.current.isUserGenerationActive).toBe(false);

		result.current.markUserRunInitiated();
		rerender({ isLoading: true });
		expect(result.current.isUserGenerationActive).toBe(true);
	});

	// The mark clears ONLY on the true→false completion transition. A
	// subsequent `isLoading=true` render with no fresh mark (e.g. the next
	// handshake on remount) must not resurrect the pill.
	it("clears the mark on run completion and stays inactive on the next unmarked run", () => {
		const { result, rerender } = renderHook(
			({ isLoading }) => useUserRunSignal(isLoading),
			{ initialProps: { isLoading: true } },
		);

		result.current.markUserRunInitiated();
		rerender({ isLoading: true });
		expect(result.current.isUserGenerationActive).toBe(true);

		// Run completes.
		rerender({ isLoading: false });
		expect(result.current.isUserGenerationActive).toBe(false);

		// A new isLoading=true render with no new mark (e.g. a later
		// handshake) must not reactivate the pill.
		rerender({ isLoading: true });
		expect(result.current.isUserGenerationActive).toBe(false);
	});

	// Pending-mark expiry: a mark that never turns into a run (a send that
	// fails somewhere CopilotKit-internal, before our deterministic
	// `clearUserRunMark()` call sites can run) must not stay stuck "on"
	// forever — it self-expires after PENDING_RUN_START_TIMEOUT_MS (15s).
	describe("pending-mark expiry", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("expires a mark that never starts a run after 15s idle", () => {
			const { result, rerender } = renderHook(
				({ isLoading }) => useUserRunSignal(isLoading),
				{ initialProps: { isLoading: false } },
			);

			act(() => {
				result.current.markUserRunInitiated();
			});
			rerender({ isLoading: false });
			expect(result.current.isUserGenerationActive).toBe(false);

			act(() => {
				vi.advanceTimersByTime(15_000);
			});
			rerender({ isLoading: false });

			// The mark expired — a later isLoading=true handshake with no
			// fresh mark must not show the pill.
			rerender({ isLoading: true });
			expect(result.current.isUserGenerationActive).toBe(false);
		});

		it("does not expire a mark that starts a run before the timeout, and stays active past the 15s point while still loading", () => {
			const { result, rerender } = renderHook(
				({ isLoading }) => useUserRunSignal(isLoading),
				{ initialProps: { isLoading: false } },
			);

			act(() => {
				result.current.markUserRunInitiated();
			});
			rerender({ isLoading: false });

			// The run starts well within the timeout window.
			act(() => {
				vi.advanceTimersByTime(5_000);
			});
			rerender({ isLoading: true });
			expect(result.current.isUserGenerationActive).toBe(true);

			// Advance past the 15s pending-mark window while still loading —
			// the expiry timer must not fire once the run has started (it is
			// only armed while `!isLoading`).
			act(() => {
				vi.advanceTimersByTime(20_000);
			});
			rerender({ isLoading: true });
			expect(result.current.isUserGenerationActive).toBe(true);
		});

		it("clearUserRunMark deactivates immediately even mid-run", () => {
			const { result, rerender } = renderHook(
				({ isLoading }) => useUserRunSignal(isLoading),
				{ initialProps: { isLoading: true } },
			);

			act(() => {
				result.current.markUserRunInitiated();
			});
			rerender({ isLoading: true });
			expect(result.current.isUserGenerationActive).toBe(true);

			act(() => {
				result.current.clearUserRunMark();
			});
			rerender({ isLoading: true });
			expect(result.current.isUserGenerationActive).toBe(false);
		});
	});
});
