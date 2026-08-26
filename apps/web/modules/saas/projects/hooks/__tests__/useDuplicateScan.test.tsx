/**
 * Behavior tests for the scan half of `useDuplicateScan`.
 *
 * A successful scan must open the hook-owned completion dialog (with the
 * scan's own counts) instead of toasting, and only AFTER the duplicate-link
 * invalidation settles — so the "Possible duplicate" chips are already
 * rendered behind the dialog. A failed scan keeps the `scanFailed` toast
 * and never opens the dialog.
 *
 * The dialog variant and headline count are driven by the response's
 * `flaggedItems` (distinct items currently flagged — the same set the
 * roadmap "Possible duplicates" filter shows), NOT by `confirmed` (this
 * run's new pair count). Deliberate contract change: the modal headline
 * must equal what "View Duplicates" reveals, even on a re-scan that
 * confirms nothing new.
 *
 * next-intl is mocked locally (overriding the global key mock) to also
 * serialize interpolation values, so the dialog's count lines are
 * assertable, e.g. `scanCompleteItems {"count":3}`.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ScanResult = {
	scanned: number;
	candidates: number;
	confirmed: number;
	truncated: number;
	verifierFailures: number;
	flaggedItems: number;
};

const { mockScanDuplicates, mockListDuplicatesQueryFn } = vi.hoisted(() => ({
	mockScanDuplicates: vi.fn<(input: unknown) => Promise<ScanResult>>(),
	mockListDuplicatesQueryFn: vi.fn<() => Promise<{ links: unknown[] }>>(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			stories: {
				listDuplicates: {
					queryOptions: (options: {
						input: Record<string, unknown>;
					}) => ({
						queryKey: ["stories", "listDuplicates", options.input],
						queryFn: () => mockListDuplicatesQueryFn(),
					}),
					queryKey: (options: { input: Record<string, unknown> }) => [
						"stories",
						"listDuplicates",
						options.input,
					],
				},
				list: {
					queryKey: (options: { input: Record<string, unknown> }) => [
						"stories",
						"list",
						options.input,
					],
				},
				scanDuplicates: {
					mutationOptions: (overrides: Record<string, unknown>) => ({
						...overrides,
						mutationFn: (input: unknown) =>
							mockScanDuplicates(input),
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
	}),
}));

// Serialize interpolation values so fresh counts are observable as text.
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) =>
		values ? `${key} ${JSON.stringify(values)}` : key,
}));

// The resolve dialog pulls a large module graph (orpc client, attachment
// resolution) that is irrelevant to the scan flow under test.
vi.mock("../../components/stories/DuplicateResolveDialog", () => ({
	DuplicateResolveDialog: () => null,
}));

import { useDuplicateScan } from "../useDuplicateScan";

function ScanHarness({ onViewDuplicates }: { onViewDuplicates?: () => void }) {
	const { runScan, scanCompletionDialog } = useDuplicateScan(
		"project-1",
		null,
		onViewDuplicates ? { onViewDuplicates } : undefined,
	);
	return (
		<div>
			<button type="button" onClick={() => runScan()}>
				start scan
			</button>
			{scanCompletionDialog}
		</div>
	);
}

function renderHarness(options?: { onViewDuplicates?: () => void }) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	render(
		<QueryClientProvider client={queryClient}>
			<ScanHarness onViewDuplicates={options?.onViewDuplicates} />
		</QueryClientProvider>,
	);
	return { queryClient };
}

beforeEach(() => {
	vi.clearAllMocks();
	mockScanDuplicates.mockReset();
	mockListDuplicatesQueryFn.mockReset();
	mockListDuplicatesQueryFn.mockResolvedValue({ links: [] });
});

describe("useDuplicateScan — scan completion", () => {
	it("opens the completion dialog instead of toasting on success", async () => {
		const user = userEvent.setup();
		mockScanDuplicates.mockResolvedValue({
			scanned: 12,
			candidates: 4,
			confirmed: 3,
			truncated: 0,
			verifierFailures: 0,
			flaggedItems: 3,
		});
		renderHarness();

		await user.click(screen.getByRole("button", { name: "start scan" }));

		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByText('scanCompleteItems {"count":3}'),
		).toBeInTheDocument();
		expect(
			within(dialog).getByText("scanCompleteTagged"),
		).toBeInTheDocument();
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.info).not.toHaveBeenCalled();
	});

	it("opens the zero-variant dialog instead of toasting when nothing is flagged", async () => {
		const user = userEvent.setup();
		mockScanDuplicates.mockResolvedValue({
			scanned: 7,
			candidates: 0,
			confirmed: 0,
			truncated: 0,
			verifierFailures: 0,
			flaggedItems: 0,
		});
		renderHarness();

		await user.click(screen.getByRole("button", { name: "start scan" }));

		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByText('scanNoneDescription {"count":7}'),
		).toBeInTheDocument();
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.info).not.toHaveBeenCalled();
	});

	it("opens the incomplete-variant dialog (not a toast) when every candidate pair failed to verify", async () => {
		const user = userEvent.setup();
		// Wholesale verifier outage: the request SUCCEEDS (the manual path does
		// not throw), returning 60 candidates / 0 confirmed / 60 failures. This
		// must not read as a clean scan.
		mockScanDuplicates.mockResolvedValue({
			scanned: 80,
			candidates: 60,
			confirmed: 0,
			truncated: 0,
			verifierFailures: 60,
			flaggedItems: 0,
		});
		renderHarness();

		await user.click(screen.getByRole("button", { name: "start scan" }));

		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByText("scanIncompleteTitle"),
		).toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", { name: "scanAgainAria" }),
		).toBeInTheDocument();
		// It is a completed request, so the failure toast must NOT fire.
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("shows the found variant with the flagged-item count when a re-scan confirms nothing new", async () => {
		const user = userEvent.setup();
		// Re-scan over an unchanged backlog: no new pairs confirmed this run,
		// but 26 items are still flagged — the dialog must mirror the filter
		// (26), not this run's confirmed count (0).
		mockScanDuplicates.mockResolvedValue({
			scanned: 40,
			candidates: 0,
			confirmed: 0,
			truncated: 0,
			verifierFailures: 0,
			flaggedItems: 26,
		});
		renderHarness();

		await user.click(screen.getByRole("button", { name: "start scan" }));

		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByText('scanCompleteItems {"count":26}'),
		).toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", { name: "viewDuplicatesAria" }),
		).toBeInTheDocument();
	});

	it("shows the zero variant when nothing is flagged even if `confirmed` is non-zero", async () => {
		const user = userEvent.setup();
		// Synthetic contract pin: `confirmed` must NOT drive the variant —
		// only `flaggedItems` does.
		mockScanDuplicates.mockResolvedValue({
			scanned: 7,
			candidates: 2,
			confirmed: 2,
			truncated: 0,
			verifierFailures: 0,
			flaggedItems: 0,
		});
		renderHarness();

		await user.click(screen.getByRole("button", { name: "start scan" }));

		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByText('scanNoneDescription {"count":7}'),
		).toBeInTheDocument();
		expect(
			within(dialog).queryByRole("button", {
				name: "viewDuplicatesAria",
			}),
		).not.toBeInTheDocument();
	});

	it("settles the duplicate-links invalidation before opening the dialog", async () => {
		const user = userEvent.setup();
		mockScanDuplicates.mockResolvedValue({
			scanned: 5,
			candidates: 1,
			confirmed: 1,
			truncated: 0,
			verifierFailures: 0,
			flaggedItems: 2,
		});
		const { queryClient } = renderHarness();

		let releaseInvalidation!: () => void;
		const invalidationGate = new Promise<void>((resolve) => {
			releaseInvalidation = resolve;
		});
		const invalidateSpy = vi
			.spyOn(queryClient, "invalidateQueries")
			.mockReturnValue(invalidationGate);

		await user.click(screen.getByRole("button", { name: "start scan" }));

		// Both invalidations are issued, but while they are still in flight
		// the dialog must stay closed.
		await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(2));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		const invalidatedKeys = invalidateSpy.mock.calls.map(
			([filters]) => (filters as { queryKey: unknown[] }).queryKey,
		);
		expect(invalidatedKeys).toEqual(
			expect.arrayContaining([
				expect.arrayContaining(["listDuplicates"]),
				expect.arrayContaining(["list"]),
			]),
		);

		await act(async () => {
			releaseInvalidation();
		});
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
	});

	it("keeps the failure toast and never opens the dialog on error", async () => {
		const user = userEvent.setup();
		mockScanDuplicates.mockRejectedValue(
			new Error("embedding provider unavailable"),
		);
		renderHarness();

		await user.click(screen.getByRole("button", { name: "start scan" }));

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("scanFailed", {
				description: "embedding provider unavailable",
			});
		});
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("re-opens with fresh counts after dismissing a previous result", async () => {
		const user = userEvent.setup();
		mockScanDuplicates.mockResolvedValueOnce({
			scanned: 12,
			candidates: 4,
			confirmed: 3,
			truncated: 0,
			verifierFailures: 0,
			flaggedItems: 3,
		});
		renderHarness();

		await user.click(screen.getByRole("button", { name: "start scan" }));
		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByText('scanCompleteItems {"count":3}'),
		).toBeInTheDocument();

		await user.click(
			within(dialog).getByRole("button", { name: "doneAria" }),
		);
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		});

		mockScanDuplicates.mockResolvedValueOnce({
			scanned: 12,
			candidates: 6,
			confirmed: 5,
			truncated: 0,
			verifierFailures: 0,
			flaggedItems: 5,
		});
		await user.click(screen.getByRole("button", { name: "start scan" }));

		const reopened = await screen.findByRole("dialog");
		expect(
			within(reopened).getByText('scanCompleteItems {"count":5}'),
		).toBeInTheDocument();
	});

	it("marks a story overlapOnly only when EVERY link is an OVERLAP", async () => {
		const linkWith = (
			id: string,
			linkType: string,
			aId: string,
			bId: string,
		) => ({
			id,
			similarity: 0.8,
			confidence: 0.85,
			reasoning: null,
			linkType,
			storyA: { id: aId, title: `title-${aId}` },
			storyB: { id: bId, title: `title-${bId}` },
		});
		// s1↔s2 OVERLAP; s1↔s3 DUPLICATE ⇒ s1 mixed (not overlapOnly),
		// s2 overlap-only, s3 duplicate.
		mockListDuplicatesQueryFn.mockResolvedValue({
			links: [
				linkWith("l1", "OVERLAP", "s1", "s2"),
				linkWith("l2", "DUPLICATE", "s1", "s3"),
			],
		});

		const infos: Record<
			string,
			{ overlapOnly: boolean; count: number } | undefined
		> = {};
		function InfoHarness() {
			const { getDuplicateInfo } = useDuplicateScan("project-1", null);
			for (const id of ["s1", "s2", "s3"]) {
				infos[id] = getDuplicateInfo(id);
			}
			return null;
		}
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={queryClient}>
				<InfoHarness />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(infos.s1).toBeDefined());
		expect(infos.s1).toMatchObject({ count: 2, overlapOnly: false });
		expect(infos.s2).toMatchObject({ count: 1, overlapOnly: true });
		expect(infos.s3).toMatchObject({ count: 1, overlapOnly: false });
	});

	it("applies the duplicates-only filter only through the View Duplicates action", async () => {
		const user = userEvent.setup();
		const onViewDuplicates = vi.fn();
		mockScanDuplicates.mockResolvedValue({
			scanned: 12,
			candidates: 4,
			confirmed: 3,
			truncated: 0,
			verifierFailures: 0,
			flaggedItems: 3,
		});
		renderHarness({ onViewDuplicates });

		await user.click(screen.getByRole("button", { name: "start scan" }));
		const dialog = await screen.findByRole("dialog");

		// Opening the dialog alone never applies the filter.
		expect(onViewDuplicates).not.toHaveBeenCalled();

		await user.click(
			within(dialog).getByRole("button", { name: "viewDuplicatesAria" }),
		);
		expect(onViewDuplicates).toHaveBeenCalledTimes(1);
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		});
	});
});
