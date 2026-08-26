/**
 * Regression coverage for the month-window fix (#1814 final review): before
 * this fix, useMeetingDigest never passed `from`/`to` to listDigest, so every
 * load — and every toggle-invalidation — fetched ALL-TIME insights. It now
 * derives the window from the `monthDate` it's given and keys its cache (and
 * onActionItemToggled's invalidation) by month so switching months re-fetches
 * instead of reusing a stale cached page.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { endOfMonth, startOfMonth } from "date-fns";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listDigest, listConfigurable, extractInsights, unlinkMeeting } =
	vi.hoisted(() => ({
		listDigest: vi.fn(),
		listConfigurable: vi.fn(),
		extractInsights: vi.fn(),
		unlinkMeeting: vi.fn(),
	}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: { listDigest, listConfigurable, extractInsights },
			meetingTranscriptSync: { unlinkMeeting },
		},
	},
}));

import { useMeetingDigest } from "../use-meeting-digest";

function wrapper({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient();
	return (
		<QueryClientProvider client={queryClient}>
			{children}
		</QueryClientProvider>
	);
}

describe("useMeetingDigest — month window", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listDigest.mockResolvedValue({
			meetings: [],
			seriesWithoutTranscripts: [],
		});
		listConfigurable.mockResolvedValue({ meetings: [] });
		extractInsights.mockResolvedValue({});
	});

	it("passes the month's from/to bounds to listDigest instead of fetching all-time", async () => {
		const monthDate = new Date("2026-03-15T12:00:00Z");
		renderHook(
			() =>
				useMeetingDigest({
					projectId: "p1",
					organizationId: null,
					monthDate,
				}),
			{ wrapper },
		);

		await waitFor(() => expect(listDigest).toHaveBeenCalledTimes(1));
		expect(listDigest).toHaveBeenCalledWith({
			projectId: "p1",
			organizationId: null,
			from: startOfMonth(monthDate),
			to: endOfMonth(monthDate),
		});
	});

	it("re-fetches when monthDate changes (distinct cache entry per month)", async () => {
		const queryClient = new QueryClient();
		const localWrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				{children}
			</QueryClientProvider>
		);

		const { rerender } = renderHook(
			({ monthDate }: { monthDate: Date }) =>
				useMeetingDigest({
					projectId: "p1",
					organizationId: null,
					monthDate,
				}),
			{
				wrapper: localWrapper,
				initialProps: { monthDate: new Date("2026-03-15T12:00:00Z") },
			},
		);

		await waitFor(() => expect(listDigest).toHaveBeenCalledTimes(1));

		rerender({ monthDate: new Date("2026-04-15T12:00:00Z") });

		await waitFor(() => expect(listDigest).toHaveBeenCalledTimes(2));
	});
});

describe("useMeetingDigest — generateSummary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listConfigurable.mockResolvedValue({ meetings: [] });
		extractInsights.mockResolvedValue({});
	});

	const pendingMeeting = {
		linkedMeetingId: "lm1",
		transcriptId: "graph-1",
		transcriptRef: "cuid1",
		subject: "Pending mtg",
		meetingDate: new Date("2026-07-06T09:00:00"),
		hasTranscript: true,
		analysisStatus: "SCANNED" as const,
		createdTaskCount: 0,
		participantCount: 1,
		includedInDigest: true,
		insightsReady: false,
		decisions: [],
		actionItems: [],
		openQuestions: [],
	};

	it("calls extractInsights with the graph id, tracks the row cuid as generating, and clears it once insightsReady flips", async () => {
		const queryClient = new QueryClient();
		const localWrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				{children}
			</QueryClientProvider>
		);
		const monthDate = new Date("2026-07-15T12:00:00Z");
		listDigest.mockResolvedValue({
			meetings: [pendingMeeting],
			seriesWithoutTranscripts: [],
		});

		const { result } = renderHook(
			() =>
				useMeetingDigest({
					projectId: "p1",
					organizationId: null,
					monthDate,
				}),
			{ wrapper: localWrapper },
		);

		await waitFor(() => expect(listDigest).toHaveBeenCalledTimes(1));

		act(() => {
			result.current.generateSummary("graph-1", "cuid1");
		});

		expect(extractInsights).toHaveBeenCalledWith({
			projectId: "p1",
			organizationId: null,
			transcriptId: "graph-1",
		});
		await waitFor(() =>
			expect(result.current.generatingRefs.has("cuid1")).toBe(true),
		);

		act(() => {
			queryClient.setQueryData(
				["projects.meetingDigest.listDigest", "p1", null, "2026-07"],
				{
					meetings: [{ ...pendingMeeting, insightsReady: true }],
					seriesWithoutTranscripts: [],
				},
			);
		});

		await waitFor(() =>
			expect(result.current.generatingRefs.has("cuid1")).toBe(false),
		);
	});

	it("clears generatingRefs on month navigation (polling a different month can't observe the origin row)", async () => {
		const queryClient = new QueryClient();
		const localWrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				{children}
			</QueryClientProvider>
		);
		listDigest.mockResolvedValue({
			meetings: [pendingMeeting],
			seriesWithoutTranscripts: [],
		});

		const { result, rerender } = renderHook(
			({ monthDate }: { monthDate: Date }) =>
				useMeetingDigest({
					projectId: "p1",
					organizationId: null,
					monthDate,
				}),
			{
				wrapper: localWrapper,
				initialProps: { monthDate: new Date("2026-07-15T12:00:00Z") },
			},
		);

		await waitFor(() => expect(listDigest).toHaveBeenCalledTimes(1));

		act(() => {
			result.current.generateSummary("graph-1", "cuid1");
		});
		await waitFor(() =>
			expect(result.current.generatingRefs.has("cuid1")).toBe(true),
		);

		rerender({ monthDate: new Date("2026-08-15T12:00:00Z") });

		await waitFor(() => expect(result.current.generatingRefs.size).toBe(0));
	});
});

describe("useMeetingDigest — generateSummary failure surfaces (FR6 #1823)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "error").mockImplementation(() => {});
		listConfigurable.mockResolvedValue({ meetings: [] });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const pendingMeeting = {
		linkedMeetingId: "lm1",
		transcriptId: "graph-1",
		transcriptRef: "cuid1",
		subject: "Pending mtg",
		meetingDate: new Date("2026-07-06T09:00:00"),
		hasTranscript: true,
		analysisStatus: "SCANNED" as const,
		createdTaskCount: 0,
		participantCount: 1,
		includedInDigest: true,
		insightsReady: false,
		decisions: [],
		actionItems: [],
		openQuestions: [],
	};

	function renderDigestHook() {
		const queryClient = new QueryClient();
		const localWrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				{children}
			</QueryClientProvider>
		);
		return renderHook(
			() =>
				useMeetingDigest({
					projectId: "p1",
					organizationId: null,
					monthDate: new Date("2026-07-15T12:00:00Z"),
				}),
			{ wrapper: localWrapper },
		);
	}

	it("a rejected extractInsights sets a per-meeting error instead of silently reverting; retrying clears it", async () => {
		listDigest.mockResolvedValue({
			meetings: [pendingMeeting],
			seriesWithoutTranscripts: [],
		});
		extractInsights.mockRejectedValueOnce(new Error("boom"));

		const { result } = renderDigestHook();
		await waitFor(() => expect(listDigest).toHaveBeenCalled());

		act(() => {
			result.current.generateSummary("graph-1", "cuid1");
		});

		await waitFor(() =>
			expect(result.current.summaryErrors.get("cuid1")).toBe(
				"Summary generation failed — try again.",
			),
		);
		expect(result.current.generatingRefs.has("cuid1")).toBe(false);

		// Retry: error clears, generation is tracked again.
		extractInsights.mockResolvedValue({ started: true });
		act(() => {
			result.current.generateSummary("graph-1", "cuid1");
		});
		await waitFor(() =>
			expect(result.current.summaryErrors.has("cuid1")).toBe(false),
		);
		expect(result.current.generatingRefs.has("cuid1")).toBe(true);
	});

	it("a not-needed result stops immediately with a message instead of spinning through the poll budget", async () => {
		listDigest.mockResolvedValue({
			meetings: [pendingMeeting],
			seriesWithoutTranscripts: [],
		});
		extractInsights.mockResolvedValue({
			started: false,
			reason: "not-needed",
		});

		const { result } = renderDigestHook();
		await waitFor(() => expect(listDigest).toHaveBeenCalled());

		act(() => {
			result.current.generateSummary("graph-1", "cuid1");
		});

		await waitFor(() =>
			expect(result.current.summaryErrors.get("cuid1")).toBe(
				"Nothing to summarize — this meeting has no transcript content.",
			),
		);
		expect(result.current.generatingRefs.has("cuid1")).toBe(false);
	});

	it("poll-budget exhaustion marks the ref stalled instead of silently reverting the button", async () => {
		vi.useFakeTimers();
		try {
			listDigest.mockResolvedValue({
				meetings: [pendingMeeting],
				seriesWithoutTranscripts: [],
			});
			extractInsights.mockResolvedValue({ started: true });

			const { result } = renderDigestHook();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(listDigest).toHaveBeenCalled();

			act(() => {
				result.current.generateSummary("graph-1", "cuid1");
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(result.current.generatingRefs.has("cuid1")).toBe(true);

			// 23 ticks × 4s exhausts the 22-tick budget.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(23 * 4000);
			});

			expect(result.current.generatingRefs.size).toBe(0);
			expect(result.current.summaryErrors.get("cuid1")).toBe(
				"Summary generation didn't finish. It may have failed or timed out.",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("an error is cleared when the insights eventually land after a timeout", async () => {
		const queryClient = new QueryClient();
		const localWrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				{children}
			</QueryClientProvider>
		);
		listDigest.mockResolvedValue({
			meetings: [pendingMeeting],
			seriesWithoutTranscripts: [],
		});
		extractInsights.mockRejectedValue(new Error("boom"));

		const { result } = renderHook(
			() =>
				useMeetingDigest({
					projectId: "p1",
					organizationId: null,
					monthDate: new Date("2026-07-15T12:00:00Z"),
				}),
			{ wrapper: localWrapper },
		);
		await waitFor(() => expect(listDigest).toHaveBeenCalled());

		act(() => {
			result.current.generateSummary("graph-1", "cuid1");
		});
		await waitFor(() =>
			expect(result.current.summaryErrors.has("cuid1")).toBe(true),
		);

		// Insights land anyway (e.g. another surface triggered extraction).
		act(() => {
			queryClient.setQueryData(
				["projects.meetingDigest.listDigest", "p1", null, "2026-07"],
				{
					meetings: [{ ...pendingMeeting, insightsReady: true }],
					seriesWithoutTranscripts: [],
				},
			);
		});

		await waitFor(() =>
			expect(result.current.summaryErrors.has("cuid1")).toBe(false),
		);
	});
});

describe("useMeetingDigest — unlinkMeeting (#1898)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listDigest.mockResolvedValue({
			meetings: [],
			seriesWithoutTranscripts: [],
		});
		listConfigurable.mockResolvedValue({ meetings: [] });
	});

	it("unlinkMeeting calls the procedure and invalidates digest, configurable, and linked caches", async () => {
		unlinkMeeting.mockResolvedValue({ success: true });
		const queryClient = new QueryClient();
		const localWrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				{children}
			</QueryClientProvider>
		);
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(
			() =>
				useMeetingDigest({
					projectId: "p1",
					organizationId: "o1",
					monthDate: new Date("2026-07-15T00:00:00Z"),
				}),
			{ wrapper: localWrapper },
		);

		await act(async () => {
			await result.current.unlinkMeeting("lm1");
		});

		expect(unlinkMeeting).toHaveBeenCalledWith({
			projectId: "p1",
			organizationId: "o1",
			linkedMeetingId: "lm1",
		});

		const invalidatedKeys = invalidateSpy.mock.calls.map(
			(call) => (call[0] as { queryKey: unknown[] }).queryKey,
		);
		// Includes meeting-transcript-sync-transcripts alongside
		// meeting-transcript-sync-linked (FIX 5, #1898 final review):
		// unlink cascades away ProjectMeetingTranscript rows, so the
		// Settings transcript list must be invalidated too or it can keep
		// showing rows for a meeting that no longer exists.
		expect(invalidatedKeys).toEqual([
			["projects.meetingDigest.listDigest", "p1", "o1"],
			["projects.meetingDigest.listConfigurable", "p1", "o1"],
			["meeting-transcript-sync-linked", "p1", "o1"],
			["meeting-transcript-sync-transcripts", "p1", "o1"],
		]);
	});
});
