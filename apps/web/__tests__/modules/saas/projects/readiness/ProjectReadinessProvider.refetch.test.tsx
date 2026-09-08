/**
 * The readiness refetch loop (prod incident: ~7,000 `projects.readiness.get`
 * calls in 6 hours, ~20 DB queries each).
 *
 * `ProjectReadinessProvider` subscribes to the TanStack Query mutation cache
 * and debounces a `refetch()` of the readiness query whenever it sees a
 * mutation that succeeded. The original filter looked at the mutation's
 * *current state* (`event.mutation?.state.status === "success"`), not the
 * event type. `MutationObserver.setOptions` — called from `useMutation`'s own
 * `useEffect(() => observer.setOptions(options), [observer, options])` on
 * every render — fires an `observerOptionsUpdated` cache event whenever the
 * options object is not shallow-equal to the previous one, which is every
 * render of any `useMutation` with an inline `mutationFn`/`onSuccess`
 * closure. Once such a mutation has succeeded once, every later re-render of
 * its component re-announces those (referentially new, behaviourally
 * unchanged) options, and the old filter treated every one of those
 * announcements as a fresh success.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/projects/readiness/
 */

import { useState } from "react";

const { readinessGet, readinessMarkSeen } = vi.hoisted(() => ({
	readinessGet: vi.fn(),
	readinessMarkSeen: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			readiness: {
				get: readinessGet,
				markSeen: readinessMarkSeen,
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-a",
		basePath: "/app/acme",
		isOrgContext: true,
	}),
}));

import { ProjectReadinessProvider } from "@saas/projects/components/readiness/ProjectReadinessProvider";
import {
	QueryClient,
	QueryClientProvider,
	useMutation,
} from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_ID = "proj-1";

/**
 * `enabled: false` keeps the fixture out of the auto-expand / "mark seen"
 * effects (both gated on it) so the only network calls in play are the ones
 * these tests are about: the initial mount fetch and whatever the mutation
 * cache subscription schedules. Nothing here exercises polling either —
 * `items` is empty, so `refetchInterval` always resolves to `false`.
 */
const READINESS_DATA = {
	enabled: false,
	attention: {
		changes: [],
		levelDropped: false,
		seenAt: null,
		autoExpandedAt: null,
	},
	level: "READY",
	phase: "DEVELOPMENT_EXECUTION",
	phaseSource: "set",
	completedCount: 0,
	totalCount: 0,
	suggestPhaseTransition: false,
	canAct: true,
	items: [],
	activeGaps: [],
	recentlyCompleted: [],
};

/**
 * A mutation with inline `mutationFn`/`onSuccess` — the exact shape that
 * makes `useMutation`'s options object a fresh reference on every render.
 * `bump` re-renders this component without touching the mutation at all, the
 * way an unrelated state change elsewhere on the page would.
 */
function MutatingChild() {
	const [bumps, setBumps] = useState(0);
	const mutation = useMutation({
		mutationFn: async () => ({ ok: true }),
		onSuccess: () => {},
	});
	return (
		<div>
			<button type="button" onClick={() => mutation.mutate()}>
				mutate
			</button>
			<button type="button" onClick={() => setBumps((n) => n + 1)}>
				bump
			</button>
			<span>{bumps}</span>
		</div>
	);
}

function renderProvider() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<ProjectReadinessProvider projectId={PROJECT_ID}>
				<MutatingChild />
			</ProjectReadinessProvider>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	readinessGet.mockResolvedValue(READINESS_DATA);
	readinessMarkSeen.mockResolvedValue({});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ProjectReadinessProvider — mutation cache refetch", () => {
	it("does not refetch on every re-render after a mutation has already succeeded (regression)", async () => {
		vi.useFakeTimers();
		renderProvider();

		// Initial mount fetch.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(readinessGet).toHaveBeenCalledTimes(1);

		// One genuine mutation success, and its debounced refetch.
		fireEvent.click(screen.getByRole("button", { name: "mutate" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(400);
		});
		expect(readinessGet).toHaveBeenCalledTimes(2);

		// Several later re-renders of the component holding the (now
		// succeeded) mutation — nothing here is a new mutation, just state
		// changing elsewhere on the page.
		for (let i = 0; i < 3; i++) {
			fireEvent.click(screen.getByRole("button", { name: "bump" }));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(400);
			});
		}

		// On the unfixed provider each re-render's `observerOptionsUpdated`
		// event passes the `state.status === "success"` filter and queues
		// another refetch, so this fails there (5, not 2).
		expect(readinessGet).toHaveBeenCalledTimes(2);
	});

	it("still refetches exactly once, after the debounce, when a mutation genuinely succeeds", async () => {
		vi.useFakeTimers();
		renderProvider();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(readinessGet).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: "mutate" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		// Still inside the debounce window.
		expect(readinessGet).toHaveBeenCalledTimes(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(400);
		});
		expect(readinessGet).toHaveBeenCalledTimes(2);
	});

	it("coalesces two mutation successes inside the debounce window into one refetch", async () => {
		vi.useFakeTimers();
		renderProvider();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(readinessGet).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: "mutate" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		// A second success arrives well inside the first one's debounce
		// window and re-arms it.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});
		fireEvent.click(screen.getByRole("button", { name: "mutate" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		// The original window (400ms from the first success) has now
		// elapsed, but the re-armed one has not.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});
		expect(readinessGet).toHaveBeenCalledTimes(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});
		expect(readinessGet).toHaveBeenCalledTimes(2);
	});

	it("waits for an in-flight readiness fetch instead of cancelling it, then reads once more", async () => {
		vi.useFakeTimers();
		renderProvider();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(readinessGet).toHaveBeenCalledTimes(1);

		// The next readiness read hangs until we release it — a slow
		// response that is still in flight when a mutation completes.
		let release: (() => void) | null = null;
		readinessGet.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve(READINESS_DATA);
				}),
		);

		// First success → debounced refetch → the slow request starts.
		fireEvent.click(screen.getByRole("button", { name: "mutate" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(400);
		});
		expect(readinessGet).toHaveBeenCalledTimes(2);

		// A second success lands while that request is still pending. Its
		// debounce must neither cancel the request nor be dropped: it re-arms.
		fireEvent.click(screen.getByRole("button", { name: "mutate" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(400);
		});
		expect(readinessGet).toHaveBeenCalledTimes(2);

		// Once the slow request resolves, the deferred read happens exactly once.
		await act(async () => {
			release?.();
			await vi.advanceTimersByTimeAsync(400);
		});
		expect(readinessGet).toHaveBeenCalledTimes(3);

		// And it does not keep going.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		expect(readinessGet).toHaveBeenCalledTimes(3);
	});
});
