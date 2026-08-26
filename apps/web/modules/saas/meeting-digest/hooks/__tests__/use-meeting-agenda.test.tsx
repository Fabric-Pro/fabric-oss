import {
	focusManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAgenda, generateAgenda, saveAgenda, listUpcoming } = vi.hoisted(
	() => ({
		getAgenda: vi.fn(),
		generateAgenda: vi.fn(),
		saveAgenda: vi.fn(),
		listUpcoming: vi.fn(),
	}),
);

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			// `orpc` in orpc-query-utils is built FROM orpcClient, so a
			// procedure absent here is also absent from every query key the
			// hook builds — listUpcoming is mocked for its key, not its call
			// (#2106).
			meetingDigest: {
				getAgenda,
				generateAgenda,
				saveAgenda,
				listUpcoming,
			},
		},
	},
}));

const toastWarning = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		warning: (...a: unknown[]) => toastWarning(...a),
		error: (...a: unknown[]) => toastError(...a),
		info: (...a: unknown[]) => toastInfo(...a),
	},
}));

import { MAX_AGENDA_POLLS, useMeetingAgenda } from "../use-meeting-agenda";

const GENERATING_AGENDA = {
	id: "ag_1",
	status: "GENERATING",
	content: null,
	contextStats: null,
	occurrenceStart: "2026-07-25T09:00:00.000Z",
	generatedAt: null,
	generationError: null,
	editedAt: null,
	editedById: null,
	version: 1,
};

const READY_AGENDA = {
	...GENERATING_AGENDA,
	status: "READY",
	content: "## Agenda",
	contextStats: { hadPriorTranscripts: true, truncated: {} },
};

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function baseInput() {
	return {
		projectId: "p1",
		organizationId: null,
		linkedMeetingId: "lm_1",
		occurrenceStart: "2026-07-25T09:00:00.000Z",
	};
}

describe("useMeetingAgenda — poll budget", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("polls every 4s while GENERATING and marks stalled after MAX_AGENDA_POLLS ticks — never polling forever", async () => {
		getAgenda.mockResolvedValue({ agenda: GENERATING_AGENDA });

		const { result } = renderHook(() => useMeetingAgenda(baseInput()), {
			wrapper,
		});

		await waitFor(() => expect(getAgenda).toHaveBeenCalledTimes(1));

		// Advance well past the poll budget worth of ticks.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000 * (MAX_AGENDA_POLLS + 5));
		});

		await waitFor(() => expect(result.current.stalled).toBe(true));

		// Budget is exactly MAX_AGENDA_POLLS refetches beyond the initial fetch.
		const callsAtStall = getAgenda.mock.calls.length;
		expect(callsAtStall).toBeLessThanOrEqual(MAX_AGENDA_POLLS + 2);

		// Advancing further must not resume polling — a stalled generation must
		// never be polled forever.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000 * 10);
		});
		expect(getAgenda.mock.calls.length).toBe(callsAtStall);
	});

	it("keeps polling while the tab is hidden and picks up completion (#2136)", async () => {
		// TanStack pauses interval refetches for hidden tabs by default
		// (refetchIntervalInBackground: false). A generation takes ~90s and
		// users tab away while they wait — with the default, nobody polls,
		// the GENERATING→READY transition is never observed, and both the
		// sheet and the upcoming-row indicator freeze until a reload
		// (staging repro, 2026-08-03). The poll budget already bounds the
		// cost of polling regardless of visibility.
		focusManager.setFocused(false);
		try {
			getAgenda.mockResolvedValue({ agenda: GENERATING_AGENDA });

			const { result } = renderHook(() => useMeetingAgenda(baseInput()), {
				wrapper,
			});

			await waitFor(() => expect(getAgenda).toHaveBeenCalledTimes(1));

			// The workflow completes server-side while the tab stays hidden.
			getAgenda.mockResolvedValue({ agenda: READY_AGENDA });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(4000 * 3);
			});

			await waitFor(() =>
				expect(result.current.agenda?.status).toBe("READY"),
			);
			expect(result.current.stalled).toBe(false);
		} finally {
			// Back to auto-detection so other tests see the real visibility.
			focusManager.setFocused(undefined);
		}
	});

	it("stops polling as soon as the agenda leaves GENERATING", async () => {
		getAgenda.mockResolvedValue({ agenda: READY_AGENDA });

		const { result } = renderHook(() => useMeetingAgenda(baseInput()), {
			wrapper,
		});

		await waitFor(() =>
			expect(result.current.agenda?.status).toBe("READY"),
		);
		expect(result.current.stalled).toBe(false);

		const calls = getAgenda.mock.calls.length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000 * 5);
		});
		// No GENERATING row: refetchInterval must return false, not keep ticking.
		expect(getAgenda.mock.calls.length).toBe(calls);
	});
});

describe("useMeetingAgenda — generate / save", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("asks first via would-discard-edits and only forces on confirmation (D7)", async () => {
		getAgenda.mockResolvedValue({ agenda: READY_AGENDA });
		generateAgenda.mockResolvedValueOnce({
			started: false,
			reason: "would-discard-edits",
		});

		const { result } = renderHook(() => useMeetingAgenda(baseInput()), {
			wrapper,
		});
		await waitFor(() => expect(result.current.agenda).not.toBeNull());

		const reason = await act(async () => result.current.generate(false));
		expect(reason).toBe("would-discard-edits");
		expect(generateAgenda).toHaveBeenCalledWith(
			expect.objectContaining({ force: false }),
		);
	});

	it("does not throw on a save conflict — surfaces it via the returned shape", async () => {
		getAgenda.mockResolvedValue({ agenda: READY_AGENDA });
		saveAgenda.mockResolvedValueOnce({
			saved: false,
			reason: "conflict",
			current: READY_AGENDA,
		});

		const { result } = renderHook(() => useMeetingAgenda(baseInput()), {
			wrapper,
		});
		await waitFor(() => expect(result.current.agenda).not.toBeNull());

		await expect(
			act(async () => result.current.save("edited content")),
		).resolves.not.toThrow();
		expect(toastWarning).toHaveBeenCalled();
	});

	// #1901 final review, FIX 2: generate() had no try/catch and was awaited
	// from an onClick, so every failure (flag off, unlinked meeting, past
	// meeting, workflow-start rollback, pre-migration P2021) produced an
	// unhandled rejection and zero user feedback — the shared oRPC error
	// interceptor suppresses BAD_REQUEST/FORBIDDEN/NOT_FOUND entirely.
	it("catches a generateAgenda rejection, toasts an error, and does not throw", async () => {
		getAgenda.mockResolvedValue({ agenda: null });
		generateAgenda.mockRejectedValueOnce(
			new Error("Link this meeting to the project before generating."),
		);

		const { result } = renderHook(() => useMeetingAgenda(baseInput()), {
			wrapper,
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		const reason = await act(async () => result.current.generate(false));

		expect(reason).toBe("error");
		expect(toastError).toHaveBeenCalledWith(
			"Couldn't generate the agenda",
			expect.objectContaining({
				description: expect.stringContaining("Link this meeting"),
			}),
		);
	});

	it("surfaces reason 'in-progress' as an informational toast rather than dropping it", async () => {
		getAgenda.mockResolvedValue({ agenda: READY_AGENDA });
		generateAgenda.mockResolvedValueOnce({
			started: false,
			reason: "in-progress",
		});

		const { result } = renderHook(() => useMeetingAgenda(baseInput()), {
			wrapper,
		});
		await waitFor(() => expect(result.current.agenda).not.toBeNull());

		const reason = await act(async () => result.current.generate(false));

		expect(reason).toBe("in-progress");
		expect(toastInfo).toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	// #1901 final review, FIX 5: a double-click before the row itself flips to
	// GENERATING must still be blocked.
	it("exposes isGeneratePending for the duration of the generateAgenda round trip", async () => {
		getAgenda.mockResolvedValue({ agenda: null });
		let resolveGenerate!: (value: {
			started: boolean;
			reason: "started";
		}) => void;
		generateAgenda.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveGenerate = resolve;
			}),
		);

		const { result } = renderHook(() => useMeetingAgenda(baseInput()), {
			wrapper,
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.isGeneratePending).toBe(false);

		let generatePromise!: Promise<unknown>;
		act(() => {
			generatePromise = result.current.generate(false);
		});
		await waitFor(() =>
			expect(result.current.isGeneratePending).toBe(true),
		);

		await act(async () => {
			resolveGenerate({ started: true, reason: "started" });
			await generatePromise;
		});

		expect(result.current.isGeneratePending).toBe(false);
	});
	it("refreshes the upcoming list so its agenda indicator stops saying 'no agenda yet' (#2106)", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		generateAgenda.mockResolvedValue({ started: true, reason: "started" });
		getAgenda.mockResolvedValue({ agenda: null });

		const { result } = renderHook(
			() =>
				useMeetingAgenda({
					projectId: "p1",
					organizationId: null,
					linkedMeetingId: "lm_1",
					occurrenceStart: "2026-07-25T09:00:00.000Z",
				}),
			{
				wrapper: ({ children }: { children: ReactNode }) => (
					<QueryClientProvider client={client}>
						{children}
					</QueryClientProvider>
				),
			},
		);

		await act(async () => {
			await result.current.generate();
		});

		// The upcoming list is fetched as two chunks with different inputs, so
		// this has to match on the PARTIAL key — an exact queryKey() would miss
		// whichever chunk the meeting is not in.
		const invalidatedKeys = invalidateQueries.mock.calls.map((call) =>
			JSON.stringify(call[0]?.queryKey),
		);
		expect(
			invalidatedKeys.some((key) => key?.includes("listUpcoming")),
		).toBe(true);
	});
	// The digest row keeps reading "Agenda generating" after the workflow
	// finishes, because only this hook polls. Rather than polling the
	// Graph-backed listUpcoming (600-2600ms a call), invalidate it once, at the
	// moment the poll observes the transition out of GENERATING.
	it("refreshes the upcoming list once generation completes (#2106)", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		generateAgenda.mockResolvedValue({ started: true, reason: "started" });
		getAgenda.mockResolvedValue({ agenda: GENERATING_AGENDA });

		const wrap = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				{children}
			</QueryClientProvider>
		);

		const { result } = renderHook(() => useMeetingAgenda(baseInput()), {
			wrapper: wrap,
		});

		await waitFor(() => expect(result.current.isGenerating).toBe(true));

		// Spy only now, so the generation-start invalidation is not counted.
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		getAgenda.mockResolvedValue({ agenda: READY_AGENDA });

		await waitFor(
			() => {
				const keys = invalidateQueries.mock.calls.map((c) =>
					JSON.stringify(c[0]?.queryKey),
				);
				expect(keys.some((k) => k?.includes("listUpcoming"))).toBe(
					true,
				);
			},
			{ timeout: 15000 },
		);
	});

	it("does not refresh the upcoming list when the agenda was never generating", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		getAgenda.mockResolvedValue({ agenda: READY_AGENDA });
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");

		const { result } = renderHook(() => useMeetingAgenda(baseInput()), {
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={client}>
					{children}
				</QueryClientProvider>
			),
		});

		await waitFor(() =>
			expect(result.current.agenda?.status).toBe("READY"),
		);

		const keys = invalidateQueries.mock.calls.map((c) =>
			JSON.stringify(c[0]?.queryKey),
		);
		expect(keys.some((k) => k?.includes("listUpcoming"))).toBe(false);
	});
});
