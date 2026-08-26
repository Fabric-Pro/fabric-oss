import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMeeting, getContent, extractInsights } = vi.hoisted(() => ({
	getMeeting: vi.fn(),
	getContent: vi.fn(),
	extractInsights: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: { getMeeting, extractInsights },
			meetingTranscriptSync: { getContent },
		},
	},
}));
vi.mock("next/navigation", () => ({
	usePathname: () => "/app/acme/projects/p1",
}));

import { MeetingDetailSheet } from "../MeetingDetailSheet";

function meetingFixture(overrides: Record<string, unknown> = {}) {
	return {
		subject: "Sprint Review",
		meetingDate: new Date("2026-06-10"),
		organizer: "Ann",
		participants: [],
		summary: "- Shipped the digest",
		analysisStatus: "SCANNED",
		analyzedAt: null,
		analysisError: null,
		hasTranscript: true,
		transcriptRef: "row1",
		insightsReady: true,
		createdTasks: [],
		decisions: null,
		actionItems: [],
		openQuestions: null,
		declinedTasks: null,
		...overrides,
	};
}

/**
 * Stands in for MeetingDigestTab: owns the expanded flag above the sheet, so
 * a meeting switch (a new transcriptId) cannot reset it. Meeting switches are
 * driven by `rerender`, not by a clickable control — Radix aria-hides
 * everything outside an open modal, which would make such a control
 * unreachable via getByRole.
 */
function Harness({ transcriptId }: { transcriptId: string }) {
	const [panelExpanded, setPanelExpanded] = useState(false);
	return (
		<MeetingDetailSheet
			projectId="pr1"
			organizationId={null}
			transcriptId={transcriptId}
			onClose={() => {}}
			panelExpanded={panelExpanded}
			onPanelExpandedChange={setPanelExpanded}
		/>
	);
}

function renderHarness(transcriptId = "t1") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const view = render(
		<QueryClientProvider client={client}>
			<Harness transcriptId={transcriptId} />
		</QueryClientProvider>,
	);
	return {
		...view,
		switchMeeting: (next: string) =>
			view.rerender(
				<QueryClientProvider client={client}>
					<Harness transcriptId={next} />
				</QueryClientProvider>,
			),
	};
}

const panel = () => screen.getByRole("dialog", { name: "Sprint Review" });

describe("MeetingDetailSheet — panel expand (#2108 follow-up)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getMeeting.mockResolvedValue(meetingFixture());
	});

	it("renders a collapsed panel toggle by default", async () => {
		renderHarness();
		const toggle = await screen.findByRole("button", {
			name: "Expand panel",
		});
		expect(toggle).toHaveAttribute("aria-expanded", "false");
	});

	// Regression guard: SheetContent renders its own Close button after
	// {children}, so the panel toggle is the first tabbable and Radix would
	// hand it initial focus — landing a keyboard user on a width preference.
	// Reordering the toggle within {children} cannot fix that, which is why
	// the sheet overrides onOpenAutoFocus. Without the override this fails.
	it("does not put initial focus on the panel toggle", async () => {
		renderHarness();
		await screen.findByRole("button", { name: "Expand panel" });
		await waitFor(() =>
			expect(document.activeElement).not.toBe(document.body),
		);
		expect(document.activeElement).toBe(panel());
		expect(document.activeElement).not.toBe(
			screen.getByRole("button", { name: "Expand panel" }),
		);
	});

	// Regression guard for the 384px bug. `w-[480px]` alone never displaced the
	// sheet variant's `sm:max-w-sm`, so the panel shipped 20% narrower than
	// intended. Nothing else in the suite can see this.
	it("gives the collapsed panel a sm:max-w override of 480px", async () => {
		renderHarness();
		await screen.findByRole("button", { name: "Expand panel" });
		// PanelExpandButton's label depends only on the panelExpanded prop,
		// never on query data, so it resolves before getMeeting's mocked
		// promise has flushed through react-query into the title — which is
		// where the dialog's accessible name comes from. Every other test in
		// this file happens to clear that race incidentally (a click, or a
		// rerender for a meeting switch); this one has no such step, so it
		// needs its own explicit wait on the dialog name before asserting.
		await screen.findByRole("dialog", { name: "Sprint Review" });
		expect(panel().className).toContain("sm:max-w-[480px]");
		expect(panel().className).not.toContain("sm:max-w-sm");
	});

	it("widens the panel and flips the control when toggled", async () => {
		renderHarness();
		fireEvent.click(
			await screen.findByRole("button", { name: "Expand panel" }),
		);
		expect(panel().className).toContain(
			"sm:max-w-[clamp(480px,65vw,1000px)]",
		);
		expect(
			screen.getByRole("button", { name: "Collapse panel" }),
		).toHaveAttribute("aria-expanded", "true");
	});

	it("returns to the narrow width when toggled back", async () => {
		renderHarness();
		fireEvent.click(
			await screen.findByRole("button", { name: "Expand panel" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Collapse panel" }));
		expect(panel().className).toContain("sm:max-w-[480px]");
		expect(
			screen.getByRole("button", { name: "Expand panel" }),
		).toBeInTheDocument();
	});

	// Deliberately NOT the per-meeting reset the per-section modals use: panel
	// width is a viewing preference about no particular meeting.
	it("stays expanded across a meeting switch", async () => {
		const { switchMeeting } = renderHarness("t1");
		fireEvent.click(
			await screen.findByRole("button", { name: "Expand panel" }),
		);
		switchMeeting("t2");
		expect(
			await screen.findByRole("button", { name: "Collapse panel" }),
		).toBeInTheDocument();
		expect(panel().className).toContain(
			"sm:max-w-[clamp(480px,65vw,1000px)]",
		);
	});

	it("leaves the per-section summary expand from #2108 working", async () => {
		renderHarness();
		fireEvent.click(
			await screen.findByRole("button", { name: "Expand panel" }),
		);
		const callsBefore = getMeeting.mock.calls.length;
		fireEvent.click(screen.getByRole("button", { name: "Expand summary" }));
		expect(
			await screen.findByRole("dialog", {
				name: "Summary — Sprint Review",
			}),
		).toBeInTheDocument();
		// AC5 still holds: neither expansion performs I/O.
		expect(getMeeting.mock.calls.length).toBe(callsBefore);
		expect(getContent).not.toHaveBeenCalled();
	});
});
