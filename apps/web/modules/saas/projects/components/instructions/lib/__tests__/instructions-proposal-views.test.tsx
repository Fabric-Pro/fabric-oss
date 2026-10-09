import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				proposals: {
					myBranch: {
						key: (o?: { input: unknown }) => ["myBranch", o ?? {}],
					},
					list: { key: () => ["list"] },
					get: { key: () => ["get"] },
				},
			},
		},
	},
}));

import { QueryClient } from "@tanstack/react-query";
import {
	liveChangesOnMyBranch,
	PROPOSAL_REFRESH_SETTLE_POLL_MS,
	PROPOSAL_REFRESH_SETTLE_WINDOW_MS,
	useInvalidateListOnBranchStateChange,
	useRefreshSettleWindow,
} from "../instructions-proposal-views";

describe("useRefreshSettleWindow", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("does not poll until a refresh opens the window, and keeps the caller's own interval", () => {
		const { result } = renderHook(() => {
			const settle = useRefreshSettleWindow();
			settle.observe("a");
			return settle;
		});
		expect(result.current.pollInterval(false)).toBe(false);
		expect(result.current.pollInterval(10_000)).toBe(10_000);
		act(() => result.current.startSettling());
		expect(result.current.pollInterval(10_000)).toBe(
			PROPOSAL_REFRESH_SETTLE_POLL_MS,
		);
	});

	it("polls while the state is unchanged and stops after the window", () => {
		const { result } = renderHook(() => {
			const settle = useRefreshSettleWindow();
			settle.observe("a");
			return settle;
		});
		act(() => result.current.startSettling());
		expect(result.current.pollInterval(false)).toBe(
			PROPOSAL_REFRESH_SETTLE_POLL_MS,
		);
		act(() => {
			vi.advanceTimersByTime(PROPOSAL_REFRESH_SETTLE_WINDOW_MS + 1);
		});
		expect(result.current.pollInterval(false)).toBe(false);
	});

	it("stops as soon as the state it shows changes", () => {
		const { result, rerender } = renderHook(
			({ signature }) => {
				const settle = useRefreshSettleWindow();
				settle.observe(signature);
				return settle;
			},
			{ initialProps: { signature: "queued" } },
		);
		act(() => result.current.startSettling());
		rerender({ signature: "open" });
		expect(result.current.pollInterval(false)).toBe(false);
	});

	it("restarts one window on a repeated refresh instead of stacking timers", () => {
		const { result } = renderHook(() => {
			const settle = useRefreshSettleWindow();
			settle.observe("a");
			return settle;
		});
		act(() => result.current.startSettling());
		act(() => {
			vi.advanceTimersByTime(PROPOSAL_REFRESH_SETTLE_WINDOW_MS - 1_000);
		});
		act(() => result.current.startSettling());
		expect(vi.getTimerCount()).toBe(1);
		act(() => {
			vi.advanceTimersByTime(PROPOSAL_REFRESH_SETTLE_WINDOW_MS - 1_000);
		});
		expect(result.current.settling).toBe(true);
	});

	it("leaves no timer behind after unmount", () => {
		const { result, unmount } = renderHook(() =>
			useRefreshSettleWindow("a"),
		);
		act(() => result.current.startSettling());
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("liveChangesOnMyBranch", () => {
	it("counts the live changes of this project only", () => {
		const client = new QueryClient();
		expect(liveChangesOnMyBranch(client, "a")).toBe(0);
		client.setQueryData(["myBranch", { input: { projectId: "a" } }], {
			liveChanges: 2,
		});
		expect(liveChangesOnMyBranch(client, "a")).toBe(2);
		expect(liveChangesOnMyBranch(client, "b")).toBe(0);
	});
});

describe("useInvalidateListOnBranchStateChange", () => {
	function setup(initial: Array<{ id: string; state: string }> | undefined) {
		const client = new QueryClient();
		const spy = vi.spyOn(client, "invalidateQueries");
		const hook = renderHook(
			({ branches }) =>
				useInvalidateListOnBranchStateChange(client, branches),
			{ initialProps: { branches: initial } },
		);
		return { spy, ...hook };
	}

	it("does not invalidate on the first read", () => {
		const { spy } = setup([{ id: "b", state: "OPENING" }]);
		expect(spy).not.toHaveBeenCalled();
	});

	it("invalidates the list and the detail once when the state changes", () => {
		const { spy, rerender } = setup([{ id: "b", state: "OPENING" }]);
		rerender({ branches: [{ id: "b", state: "OPEN" }] });
		expect(spy).toHaveBeenCalledTimes(2);
		expect(spy).toHaveBeenCalledWith({ queryKey: ["list"] });
		expect(spy).toHaveBeenCalledWith({ queryKey: ["get"] });
		rerender({ branches: [{ id: "b", state: "OPEN" }] });
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("invalidates when the branch goes away, and not while nothing has loaded", () => {
		const { spy, rerender } = setup(undefined);
		rerender({ branches: [{ id: "b", state: "CLOSE_REQUESTED" }] });
		expect(spy).not.toHaveBeenCalled();
		rerender({ branches: [] });
		expect(spy).toHaveBeenCalledTimes(2);
	});
});
