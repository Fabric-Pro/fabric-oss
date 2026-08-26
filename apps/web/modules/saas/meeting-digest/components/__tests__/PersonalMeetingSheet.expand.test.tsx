import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPersonalTranscript, getPersonalInsights } = vi.hoisted(() => ({
	getPersonalTranscript: vi.fn(),
	getPersonalInsights: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: { getPersonalTranscript, getPersonalInsights },
		},
	},
}));

import { PersonalMeetingSheet } from "../PersonalMeetingSheet";

const MEETING = {
	id: "evt1",
	subject: "1:1 with Sam",
	startTime: "2026-07-14T09:00:00Z",
	organizer: "Sam Rivers",
	joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
	linkedWithoutTranscript: false,
};

function renderSheet(meeting = MEETING) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(
		<PersonalMeetingSheet
			projectId="p1"
			organizationId={null}
			meeting={meeting}
			onClose={vi.fn()}
		/>,
		{ wrapper },
	);
}

describe("PersonalMeetingSheet — expanded summary view (#2108)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("expands the personal summary into a modal with the same text and no extra fetch", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: "Personal meeting recap text.",
			actionItems: [],
		});
		renderSheet();
		fireEvent.click(
			screen.getByRole("button", { name: "Summarise meeting" }),
		);
		const expand = await screen.findByRole("button", {
			name: "Expand summary",
		});
		expect(getPersonalInsights).toHaveBeenCalledTimes(1);
		fireEvent.click(expand);
		const dialog = await screen.findByRole("dialog", {
			name: "Summary — 1:1 with Sam",
		});
		expect(
			within(dialog).getByText("Personal meeting recap text."),
		).toBeInTheDocument();
		// AC5 + personal-lane discipline: expanding fetched nothing.
		expect(getPersonalInsights).toHaveBeenCalledTimes(1);
		expect(getPersonalTranscript).not.toHaveBeenCalled();
	});

	it("offers no expand when summarising yields no summary", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: null,
			actionItems: [],
			reason: "no-transcript",
		});
		renderSheet();
		fireEvent.click(
			screen.getByRole("button", { name: "Summarise meeting" }),
		);
		await screen.findByText(/nothing\s+to summarise/);
		expect(
			screen.queryByRole("button", { name: "Expand summary" }),
		).not.toBeInTheDocument();
	});

	it("switching meetings drops the expanded state with the summarised view (unmount reset)", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: "Personal meeting recap text.",
			actionItems: [],
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const { rerender } = render(
			<QueryClientProvider client={client}>
				<PersonalMeetingSheet
					projectId="p1"
					organizationId={null}
					meeting={MEETING}
					onClose={vi.fn()}
				/>
			</QueryClientProvider>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Summarise meeting" }),
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Expand summary" }),
		);
		await screen.findByRole("dialog", { name: "Summary — 1:1 with Sam" });

		rerender(
			<QueryClientProvider client={client}>
				<PersonalMeetingSheet
					projectId="p1"
					organizationId={null}
					meeting={{
						...MEETING,
						id: "evt2",
						joinUrl:
							"https://teams.microsoft.com/l/meetup-join/BBB",
						subject: "Other meeting",
					}}
					onClose={vi.fn()}
				/>
			</QueryClientProvider>,
		);
		await waitFor(() =>
			expect(
				screen.queryByRole("dialog", { name: /Summary — / }),
			).not.toBeInTheDocument(),
		);
		// Meeting B is back to the un-summarised state.
		expect(
			screen.getByRole("button", { name: "Summarise meeting" }),
		).toBeInTheDocument();
	});
});

/** Parent stand-in, same shape as MeetingDigestTab's ownership of the flag. */
function PanelHarness({ meeting = MEETING }: { meeting?: typeof MEETING }) {
	const [panelExpanded, setPanelExpanded] = useState(false);
	// Lazy-initialized so the same QueryClient instance survives a rerender
	// (a meeting switch), rather than being recreated on every render.
	const [client] = useState(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false } },
			}),
	);
	return (
		<QueryClientProvider client={client}>
			<PersonalMeetingSheet
				projectId="p1"
				organizationId={null}
				meeting={meeting}
				onClose={vi.fn()}
				panelExpanded={panelExpanded}
				onPanelExpandedChange={setPanelExpanded}
			/>
		</QueryClientProvider>
	);
}

// A different joinUrl is what makes this a genuinely different meeting to the
// component: its per-meeting reset block keys on `joinUrl:startTime`, so
// changing the subject alone would not fire the reset this test must survive.
const MEETING_2 = {
	...MEETING,
	id: "evt2",
	subject: "Weekly Sync",
	joinUrl: "https://teams.microsoft.com/l/meetup-join/CCC",
};

const personalPanel = () =>
	screen.getByRole("dialog", { name: /1:1 with Sam/ });

describe("PersonalMeetingSheet — panel expand (#2108 follow-up)", () => {
	beforeEach(() => vi.clearAllMocks());

	// Same guard as the team sheet: without the onOpenAutoFocus override,
	// Radix hands initial focus to the panel toggle, because SheetContent
	// renders its own Close button after {children}.
	it("does not put initial focus on the panel toggle", async () => {
		render(<PanelHarness />);
		await waitFor(() =>
			expect(document.activeElement).not.toBe(document.body),
		);
		expect(document.activeElement).toBe(personalPanel());
		expect(document.activeElement).not.toBe(
			screen.getByRole("button", { name: "Expand panel" }),
		);
	});

	it("renders a collapsed panel toggle with the 480px width", () => {
		render(<PanelHarness />);
		expect(
			screen.getByRole("button", { name: "Expand panel" }),
		).toHaveAttribute("aria-expanded", "false");
		expect(personalPanel().className).toContain("sm:max-w-[480px]");
	});

	it("widens the panel and flips the control when toggled", () => {
		render(<PanelHarness />);
		fireEvent.click(screen.getByRole("button", { name: "Expand panel" }));
		expect(personalPanel().className).toContain(
			"sm:max-w-[clamp(480px,65vw,1000px)]",
		);
		expect(
			screen.getByRole("button", { name: "Collapse panel" }),
		).toHaveAttribute("aria-expanded", "true");
	});

	it("returns to the narrow width when toggled back", () => {
		render(<PanelHarness />);
		fireEvent.click(screen.getByRole("button", { name: "Expand panel" }));
		fireEvent.click(screen.getByRole("button", { name: "Collapse panel" }));
		expect(personalPanel().className).toContain("sm:max-w-[480px]");
	});

	// The riskier regression guard: PersonalMeetingSheet has its own
	// adjust-state-during-render reset block keyed on meeting identity (it
	// resets `requested` and `summariseRequested` on a meeting switch). This
	// asserts panelExpanded is NOT — and must never become — part of that
	// reset, the way it already is covered for the team sheet in
	// MeetingDetailSheet.panelExpand.test.tsx.
	it("stays expanded across a meeting switch", () => {
		const { rerender } = render(<PanelHarness meeting={MEETING} />);
		fireEvent.click(screen.getByRole("button", { name: "Expand panel" }));
		rerender(<PanelHarness meeting={MEETING_2} />);
		expect(
			screen.getByRole("button", { name: "Collapse panel" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("dialog", { name: /Weekly Sync/ }).className,
		).toContain("sm:max-w-[clamp(480px,65vw,1000px)]");
	});
});
