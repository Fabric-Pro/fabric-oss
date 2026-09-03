/**
 * Request-volume guard for `useProjectPresence`.
 *
 * The hook used to list `activeTab` / `editingDocId` in its join effect's
 * dependencies, so every tab change re-ran the effect: cleanup sent `leave`,
 * the body sent `join`, and the update effect sent a `heartbeat` — three
 * POSTs per switch, and around twenty on a cold project load while the
 * active tab was still settling through the tab-config queries. These tests
 * pin the intended shape: one join per mount, a single debounced heartbeat
 * per burst of changes, nothing extra on mount, one leave on unmount.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every call is recorded as [projectId, action, activeTab, editingDocId] so
// the project-switch test can tell which project a request belonged to —
// the real `sendPresence` is keyed on the project it was created for.
const { presenceCalls, senders } = vi.hoisted(() => ({
	presenceCalls: [] as unknown[][],
	senders: new Map<string, (...args: unknown[]) => void>(),
}));

// `sendPresence` is stable per project, like the real hook's useCallback
// keyed on `projectId`; a fresh function per render would itself re-run the
// join effect and hide the regression these tests exist to catch.
vi.mock("../useProjectRealtime", () => ({
	useProjectRealtime: ({ projectId }: { projectId: string }) => {
		let sendPresence = senders.get(projectId);
		if (!sendPresence) {
			sendPresence = (...args: unknown[]) => {
				presenceCalls.push([projectId, ...args]);
			};
			senders.set(projectId, sendPresence);
		}
		return {
			activeUsers: [],
			recentActivity: [],
			status: "connected",
			sendPresence,
		};
	},
}));

import { useProjectPresence } from "../useProjectPresence";

const DEBOUNCE_MS = 300;
const HEARTBEAT_INTERVAL_MS = 120_000;

function callsFor(action: string, projectId = "p1") {
	return presenceCalls
		.filter(([p, a]) => p === projectId && a === action)
		.map(([, ...rest]) => rest);
}

describe("useProjectPresence request volume", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		presenceCalls.length = 0;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("joins once and never leaves/rejoins when the active tab changes", () => {
		const { rerender } = renderHook(
			({ activeTab }) =>
				useProjectPresence({ projectId: "p1", activeTab }),
			{ initialProps: { activeTab: "overview" } },
		);

		expect(callsFor("join")).toEqual([["join", "overview", undefined]]);

		rerender({ activeTab: "stories" });
		rerender({ activeTab: "kanban" });

		expect(callsFor("join")).toHaveLength(1);
		expect(callsFor("leave")).toHaveLength(0);
	});

	it("coalesces a burst of tab changes into one heartbeat carrying the last value", () => {
		const { rerender } = renderHook(
			({ activeTab }) =>
				useProjectPresence({ projectId: "p1", activeTab }),
			{ initialProps: { activeTab: "overview" } },
		);

		rerender({ activeTab: "stories" });
		act(() => {
			vi.advanceTimersByTime(DEBOUNCE_MS / 2);
		});
		rerender({ activeTab: "kanban" });

		// Nothing has been sent yet: the first timer was cancelled by the
		// second change, and the second has not elapsed.
		expect(callsFor("heartbeat")).toHaveLength(0);

		act(() => {
			vi.advanceTimersByTime(DEBOUNCE_MS);
		});

		expect(callsFor("heartbeat")).toEqual([
			["heartbeat", "kanban", undefined],
		]);
	});

	it("does not send an update heartbeat on mount", () => {
		renderHook(() =>
			useProjectPresence({ projectId: "p1", activeTab: "overview" }),
		);

		act(() => {
			vi.advanceTimersByTime(DEBOUNCE_MS * 2);
		});

		expect(callsFor("heartbeat")).toHaveLength(0);
	});

	it("does not report a change that reverts before the debounce elapses", () => {
		const { rerender } = renderHook(
			({ activeTab }) =>
				useProjectPresence({ projectId: "p1", activeTab }),
			{ initialProps: { activeTab: "overview" } },
		);

		rerender({ activeTab: "stories" });
		rerender({ activeTab: "overview" });
		act(() => {
			vi.advanceTimersByTime(DEBOUNCE_MS * 2);
		});

		// The server already knows "overview" from the join.
		expect(callsFor("heartbeat")).toHaveLength(0);
	});

	it("a tab change does not re-arm the periodic heartbeat interval", () => {
		const { rerender } = renderHook(
			({ activeTab }) =>
				useProjectPresence({ projectId: "p1", activeTab }),
			{ initialProps: { activeTab: "overview" } },
		);

		// Change the tab just before the original interval is due. If the
		// change re-armed the interval (the old dependency-array behaviour),
		// the periodic heartbeat would move out to 119s + 120s and nothing
		// but the debounced update would arrive before the 120s mark.
		act(() => {
			vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1_000);
		});
		rerender({ activeTab: "documents" });
		act(() => {
			vi.advanceTimersByTime(DEBOUNCE_MS);
		});
		expect(callsFor("heartbeat")).toEqual([
			["heartbeat", "documents", undefined],
		]);

		act(() => {
			vi.advanceTimersByTime(1_000);
		});

		// The original interval fired on schedule, carrying the current tab.
		expect(callsFor("heartbeat")).toEqual([
			["heartbeat", "documents", undefined],
			["heartbeat", "documents", undefined],
		]);
	});

	it("a periodic heartbeat that already carried the new tab suppresses the pending update", () => {
		const { rerender } = renderHook(
			({ activeTab }) =>
				useProjectPresence({ projectId: "p1", activeTab }),
			{ initialProps: { activeTab: "overview" } },
		);

		// Change the tab so close to the interval that the interval fires
		// (with the new tab) before the debounce elapses.
		act(() => {
			vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 100);
		});
		rerender({ activeTab: "stories" });
		act(() => {
			vi.advanceTimersByTime(DEBOUNCE_MS * 2);
		});

		expect(callsFor("heartbeat")).toEqual([
			["heartbeat", "stories", undefined],
		]);
	});

	it("a heartbeat sent outside the debounce still lets a later revert be reported", () => {
		const { rerender } = renderHook(
			({ activeTab }) =>
				useProjectPresence({ projectId: "p1", activeTab }),
			{ initialProps: { activeTab: "overview" } },
		);

		// Interval heartbeat carries "stories" while its update is pending,
		// then the tab reverts to "overview" before the debounce elapses. The
		// server now holds "stories", so the revert must be sent.
		act(() => {
			vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 100);
		});
		rerender({ activeTab: "stories" });
		act(() => {
			vi.advanceTimersByTime(150);
		});
		rerender({ activeTab: "overview" });
		act(() => {
			vi.advanceTimersByTime(DEBOUNCE_MS * 2);
		});

		expect(callsFor("heartbeat")).toEqual([
			["heartbeat", "stories", undefined],
			["heartbeat", "overview", undefined],
		]);
	});

	it("sends a single leave on unmount", () => {
		const { unmount } = renderHook(() =>
			useProjectPresence({ projectId: "p1", activeTab: "overview" }),
		);

		unmount();

		expect(callsFor("leave")).toEqual([["leave"]]);
	});

	it("drops a pending update when unmounted before the debounce elapses", () => {
		const { rerender, unmount } = renderHook(
			({ activeTab }) =>
				useProjectPresence({ projectId: "p1", activeTab }),
			{ initialProps: { activeTab: "overview" } },
		);

		rerender({ activeTab: "stories" });
		unmount();
		act(() => {
			vi.advanceTimersByTime(DEBOUNCE_MS * 2);
		});

		expect(callsFor("heartbeat")).toHaveLength(0);
		expect(callsFor("leave")).toEqual([["leave"]]);
	});

	it("drops a pending update when disabled before the debounce elapses", () => {
		const { rerender } = renderHook(
			({ activeTab, enabled }) =>
				useProjectPresence({ projectId: "p1", activeTab, enabled }),
			{ initialProps: { activeTab: "overview", enabled: true } },
		);

		rerender({ activeTab: "stories", enabled: true });
		rerender({ activeTab: "stories", enabled: false });
		act(() => {
			vi.advanceTimersByTime(DEBOUNCE_MS * 2);
		});

		expect(callsFor("heartbeat")).toHaveLength(0);
	});

	it("switching project leaves the old one and joins the new one exactly once", () => {
		const { rerender } = renderHook(
			({ projectId, activeTab }) =>
				useProjectPresence({ projectId, activeTab }),
			{ initialProps: { projectId: "p1", activeTab: "overview" } },
		);

		// A tab change is still pending when the project switches.
		rerender({ projectId: "p1", activeTab: "stories" });
		rerender({ projectId: "p2", activeTab: "stories" });
		act(() => {
			vi.advanceTimersByTime(DEBOUNCE_MS * 2);
		});

		expect(callsFor("leave", "p1")).toEqual([["leave"]]);
		expect(callsFor("heartbeat", "p1")).toHaveLength(0);
		expect(callsFor("join", "p2")).toEqual([
			["join", "stories", undefined],
		]);
		// The join already carried "stories"; no follow-up heartbeat either.
		expect(callsFor("heartbeat", "p2")).toHaveLength(0);
		expect(callsFor("join", "p1")).toHaveLength(1);
	});
});
