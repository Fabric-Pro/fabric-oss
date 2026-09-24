/**
 * useLatestCycle against a REAL QueryClient (Fizzy #2646, panel C #2).
 *
 * The scan follow-up is a claim about TanStack's own cancellation and
 * de-duplication — an in-flight first read must not be taken for the
 * scan's result — and a mocked `useQuery` cannot produce, or refute, that
 * interleaving. Only the procedure is faked: every fetch parks in `fetches`
 * until the test answers it, in any order.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Cycle = {
	id: string;
	status: string;
	startedAt: Date;
	completedAt: Date | null;
};
type Answer = { cycle: Cycle | null };

const { fetches } = vi.hoisted(() => ({
	fetches: [] as Array<{
		resolve: (a: Answer) => void;
		reject: (e: unknown) => void;
	}>,
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const key = (input: unknown) => [
		"projects.publishingSuite.latestCycle",
		input,
	];
	return {
		orpc: {
			projects: {
				publishingSuite: {
					latestCycle: {
						queryOptions: ({ input }: { input: unknown }) => ({
							queryKey: key(input),
							queryFn: () =>
								new Promise<Answer>((resolve, reject) => {
									fetches.push({ resolve, reject });
								}),
						}),
						queryKey: ({ input }: { input: unknown }) => key(input),
					},
				},
			},
		},
	};
});

import {
	CYCLE_POLL_INTERVAL_MS,
	CYCLE_POLL_WINDOW_MS,
	isLiveGenerating,
	RECENT_FINISH_MS,
	SCAN_WATCH_MS,
	useLatestCycle,
} from "@saas/projects/components/publishing-suite/use-latest-cycle";

const T0 = Date.parse("2026-09-24T12:00:00Z");
const QUERY_KEY = [
	"projects.publishingSuite.latestCycle",
	{ projectId: "proj-1", organizationId: null },
];

/**
 * A terminal cycle finished an hour ago by default — long enough that a first
 * answer after mount showing it is not "just finished" (RECENT_FINISH_MS).
 */
const cycle = (
	id: string,
	status: string,
	finishedAgoMs = 60 * 60 * 1000,
): Cycle => ({
	id,
	status,
	startedAt: new Date(Date.now() - 1000),
	completedAt:
		status === "GENERATING" ? null : new Date(Date.now() - finishedAgoMs),
});

let client: QueryClient;

function setup() {
	// The app's defaults (`shared/lib/query-client.ts`): no retries, 60 s fresh.
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
	});
	return mount();
}

/** Mount the hook (again) on the CURRENT client — its cache included. */
function mount() {
	const current = client;
	const onFinished = vi.fn();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={current}>{children}</QueryClientProvider>
	);
	const hook = renderHook(
		() =>
			useLatestCycle({
				projectId: "proj-1",
				organizationId: null,
				onFinished,
			}),
		{ wrapper },
	);
	return { ...hook, onFinished };
}

/** Advance only `Date` — timestamps must differ, TanStack's timers stay real. */
const tick = (ms = 1000) => vi.setSystemTime(Date.now() + ms);

async function answer(index: number, value: Answer) {
	tick();
	await act(async () => {
		fetches[index].resolve(value);
	});
}

/** The polling interval TanStack would use right now. */
function currentInterval() {
	const query = client.getQueryCache().find({ queryKey: QUERY_KEY });
	const interval = query?.observers[0]?.options.refetchInterval;
	return typeof interval === "function" ? interval(query as never) : interval;
}

beforeEach(() => {
	fetches.length = 0;
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
});

afterEach(() => {
	client?.clear();
	vi.useRealTimers();
});

describe("isLiveGenerating", () => {
	const now = T0;
	const ago = (ms: number) => new Date(now - ms);
	it("is live for a GENERATING cycle started a minute ago, in either wire form", () => {
		expect(
			isLiveGenerating(
				{ status: "GENERATING", startedAt: ago(60_000) },
				now,
			),
		).toBe(true);
		expect(
			isLiveGenerating(
				{ status: "GENERATING", startedAt: ago(60_000).toISOString() },
				now,
			),
		).toBe(true);
	});
	it("stops at the execution window — nothing works on a cycle that old", () => {
		expect(
			isLiveGenerating(
				{
					status: "GENERATING",
					startedAt: ago(CYCLE_POLL_WINDOW_MS + 1),
				},
				now,
			),
		).toBe(false);
	});
	it("is never live for a terminal cycle, no cycle, or an unreadable start", () => {
		expect(
			isLiveGenerating({ status: "READY", startedAt: ago(1) }, now),
		).toBe(false);
		expect(isLiveGenerating(null, now)).toBe(false);
		expect(
			isLiveGenerating({ status: "GENERATING", startedAt: "nope" }, now),
		).toBe(false);
	});
});

describe("useLatestCycle — following a scan (real QueryClient)", () => {
	it("never takes an answer fetched before the scan for the scan's result", async () => {
		const { result, onFinished } = setup();
		await waitFor(() => expect(fetches).toHaveLength(1)); // first read in flight

		tick();
		act(() => result.current.scanAccepted());
		// Cancel FIRST, then refetch — so a NEW fetch starts. (Invalidating
		// first would de-duplicate onto the in-flight first read, and the
		// cancel would then kill it: no fetch 2, ever.)
		await waitFor(() => expect(fetches).toHaveLength(2));

		// The first read's answer arrives late: the OLD cycle.
		await answer(0, { cycle: cycle("c1", "READY") });
		expect(result.current.cycleQuery.data).toBeUndefined();
		expect(onFinished).not.toHaveBeenCalled();

		// The post-scan answer: the run the scan started.
		await answer(1, { cycle: cycle("c2", "GENERATING") });
		await waitFor(() =>
			expect(result.current.cycleQuery.data?.cycle?.id).toBe("c2"),
		);
		expect(onFinished).not.toHaveBeenCalled();
		expect(currentInterval()).toBe(CYCLE_POLL_INTERVAL_MS);

		// It finishes.
		act(() => {
			void result.current.cycleQuery.refetch();
		});
		await waitFor(() => expect(fetches).toHaveLength(3));
		await answer(2, { cycle: cycle("c2", "READY") });
		await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(currentInterval()).toBe(false));
	});

	it("does not count a failed read as the scan's answer — the scan stays watched", async () => {
		const { result, onFinished } = setup();
		await waitFor(() => expect(fetches).toHaveLength(1));
		await answer(0, { cycle: cycle("c1", "READY") });
		await waitFor(() =>
			expect(result.current.cycleQuery.data?.cycle?.id).toBe("c1"),
		);
		expect(onFinished).not.toHaveBeenCalled(); // first answer, no scan
		expect(currentInterval()).toBe(false);

		tick();
		act(() => result.current.scanAccepted());
		await waitFor(() => expect(fetches).toHaveLength(2));
		tick();
		await act(async () => {
			fetches[1].reject(new Error("502"));
		});
		// Read the CACHE: `useQuery` tracks which result fields a component
		// reads, and the hook never reads `isError`, so `result.current` is not
		// re-rendered for it (panel C, executed).
		await waitFor(() =>
			expect(client.getQueryState(QUERY_KEY)?.status).toBe("error"),
		);
		expect(onFinished).not.toHaveBeenCalled();
		// Still following the scan, whatever the cached (terminal) status says.
		await waitFor(() =>
			expect(currentInterval()).toBe(CYCLE_POLL_INTERVAL_MS),
		);

		// The next SUCCESSFUL read after the scan ends it — even one that
		// shows the same cycle (the dispatch declined to start a run).
		act(() => {
			void result.current.cycleQuery.refetch();
		});
		await waitFor(() => expect(fetches).toHaveLength(3));
		await answer(2, { cycle: cycle("c1", "READY") });
		await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(currentInterval()).toBe(false));
	});

	it("stops following an unanswered scan after SCAN_WATCH_MS", async () => {
		const { result } = setup();
		await waitFor(() => expect(fetches).toHaveLength(1));
		await answer(0, { cycle: cycle("c1", "READY") });
		await waitFor(() =>
			expect(result.current.cycleQuery.data).toBeDefined(),
		);

		tick();
		act(() => result.current.scanAccepted());
		await waitFor(() =>
			expect(currentInterval()).toBe(CYCLE_POLL_INTERVAL_MS),
		);
		tick(SCAN_WATCH_MS + 1);
		expect(currentInterval()).toBe(false);
	});
});

describe("useLatestCycle — noticing a run finish (real QueryClient)", () => {
	it("fires once when the watched cycle goes GENERATING → terminal", async () => {
		const { result, onFinished } = setup();
		await waitFor(() => expect(fetches).toHaveLength(1));
		await answer(0, { cycle: cycle("c1", "GENERATING") });
		await waitFor(() =>
			expect(currentInterval()).toBe(CYCLE_POLL_INTERVAL_MS),
		);

		act(() => {
			void result.current.cycleQuery.refetch();
		});
		await waitFor(() => expect(fetches).toHaveLength(2));
		await answer(1, { cycle: cycle("c1", "READY") });
		await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));

		// A later identical answer is not a second finish.
		act(() => {
			void result.current.cycleQuery.refetch();
		});
		await waitFor(() => expect(fetches).toHaveLength(3));
		await answer(2, { cycle: cycle("c1", "READY") });
		// TanStack notifies observers on a setTimeout(0) that `act` does not
		// wait for: wait for the render that carries this answer before
		// claiming nothing happened (panel A — without this line a hook with
		// no dedupe passes).
		await waitFor(() =>
			expect(result.current.cycleQuery.dataUpdatedAt).toBe(Date.now()),
		);
		expect(onFinished).toHaveBeenCalledTimes(1);
	});

	it("fires when a NEW cycle is first seen already finished", async () => {
		const { result, onFinished } = setup();
		await waitFor(() => expect(fetches).toHaveLength(1));
		await answer(0, { cycle: cycle("c1", "READY") });
		await waitFor(() =>
			expect(result.current.cycleQuery.data).toBeDefined(),
		);

		act(() => {
			void result.current.cycleQuery.refetch();
		});
		await waitFor(() => expect(fetches).toHaveLength(2));
		await answer(1, { cycle: cycle("c2", "NO_TOPICS") });
		await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
	});

	it("never fires on the first answer after mount for a run that finished long ago", async () => {
		const { result, onFinished } = setup();
		await waitFor(() => expect(fetches).toHaveLength(1));
		await answer(0, { cycle: cycle("c1", "READY") });
		await waitFor(() =>
			expect(result.current.cycleQuery.data).toBeDefined(),
		);
		expect(onFinished).not.toHaveBeenCalled();
	});

	it("fires once when the first answer after mount shows a run that finished moments ago", async () => {
		// The topics may have been read just BEFORE that run finished, and a
		// terminal cycle starts no polling: nothing else would ever re-read
		// what it produced.
		const { result, onFinished } = setup();
		await waitFor(() => expect(fetches).toHaveLength(1));
		await answer(0, { cycle: cycle("c1", "READY", 30_000) });
		await waitFor(() =>
			expect(result.current.cycleQuery.data).toBeDefined(),
		);
		await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));

		// The same run seen again is not a second finish.
		act(() => {
			void result.current.cycleQuery.refetch();
		});
		await waitFor(() => expect(fetches).toHaveLength(2));
		await answer(1, { cycle: cycle("c1", "READY", 30_000) });
		await waitFor(() =>
			expect(result.current.cycleQuery.dataUpdatedAt).toBe(Date.now()),
		);
		expect(onFinished).toHaveBeenCalledTimes(1);
	});

	it("fires once when the first answer after mount shows a run that finished 'in the future' (this browser's clock is behind the server's)", async () => {
		// `completedAt` is the SERVER's clock, `now` this browser's: a run
		// that just finished can look like it finished ahead of now. A rule
		// that only looks backwards would never re-read what it produced.
		const { result, onFinished } = setup();
		await waitFor(() => expect(fetches).toHaveLength(1));
		const ahead = cycle("c1", "READY", -30_000);
		await answer(0, { cycle: ahead });
		await waitFor(() =>
			expect(result.current.cycleQuery.dataUpdatedAt).toBe(Date.now()),
		);
		// The precondition: still ahead of this browser's clock on arrival.
		expect(ahead.completedAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
		await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
	});

	it("re-reads the cycle on a remount while the cached answer is still fresh, and fires for a run that finished while away", async () => {
		// With the app's 60 s staleTime, a remount within a minute would show
		// the cached cycle without asking: a run that finished while the list
		// was away would never be observed, and its topics would stay stale.
		const first = setup();
		await waitFor(() => expect(fetches).toHaveLength(1));
		await answer(0, { cycle: cycle("c1", "READY") });
		await waitFor(() =>
			expect(first.result.current.cycleQuery.data?.cycle?.id).toBe("c1"),
		);
		expect(first.onFinished).not.toHaveBeenCalled();
		first.unmount();

		const second = mount();
		// The precondition: the new mount starts from the cache, still fresh.
		expect(second.result.current.cycleQuery.data?.cycle?.id).toBe("c1");
		expect(
			Date.now() - second.result.current.cycleQuery.dataUpdatedAt,
		).toBeLessThan(60_000);
		await waitFor(() => expect(fetches).toHaveLength(2));

		// A different run, also finished long ago: the recent-finish rule is
		// not what fires — the (id, status) change is.
		await answer(1, { cycle: cycle("c2", "READY") });
		await waitFor(() => expect(second.onFinished).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(second.result.current.cycleQuery.dataUpdatedAt).toBe(
				Date.now(),
			),
		);
		expect(second.onFinished).toHaveBeenCalledTimes(1);
		expect(first.onFinished).not.toHaveBeenCalled();
	});

	it("does not fire on the first answer after mount for a run that finished just over RECENT_FINISH_MS ago", async () => {
		const { result, onFinished } = setup();
		await waitFor(() => expect(fetches).toHaveLength(1));
		await answer(0, {
			cycle: cycle("c1", "READY", RECENT_FINISH_MS + 1000),
		});
		await waitFor(() =>
			expect(result.current.cycleQuery.data).toBeDefined(),
		);
		expect(onFinished).not.toHaveBeenCalled();
	});
});
