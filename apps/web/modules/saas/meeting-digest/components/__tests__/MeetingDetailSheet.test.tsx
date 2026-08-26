import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	getMeeting,
	getContent,
	extractInsights,
	generateProposals,
	setActionItemCompleted,
} = vi.hoisted(() => ({
	getMeeting: vi.fn(),
	getContent: vi.fn(),
	extractInsights: vi.fn(),
	generateProposals: vi.fn(),
	setActionItemCompleted: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: {
				getMeeting,
				extractInsights,
				generateProposals,
				setActionItemCompleted,
			},
			meetingTranscriptSync: { getContent },
		},
	},
}));
vi.mock("next/navigation", () => ({
	usePathname: () => "/app/acme/projects/p1",
}));

import { MeetingDetailSheet, TranscriptPane } from "../MeetingDetailSheet";

function renderWithQuery(ui: React.ReactElement) {
	const queryClient = new QueryClient();
	return render(
		<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
	);
}

describe("MeetingDetailSheet", () => {
	beforeEach(() => vi.clearAllMocks());

	it("loads and shows the meeting summary + created task identifier", async () => {
		getMeeting.mockResolvedValue({
			subject: "Sprint Review",
			meetingDate: new Date("2026-06-10"),
			organizer: "Ann",
			participants: ["Ann", "Bob"],
			summary: "We agreed to ship X.",
			analysisStatus: "SCANNED",
			analyzedAt: new Date("2026-06-10"),
			analysisError: null,
			hasTranscript: true,
			transcriptRef: "row1",
			insightsReady: true,
			createdTasks: [
				{ identifier: "F-12", title: "Ship X", storyId: "s1" },
			],
			decisions: null,
			actionItems: [],
			openQuestions: null,
			declinedTasks: null,
		});

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);

		await waitFor(() =>
			expect(
				screen.getByText("We agreed to ship X."),
			).toBeInTheDocument(),
		);
		expect(screen.getByText("Sprint Review")).toBeInTheDocument();
		expect(screen.getByText("F-12")).toBeInTheDocument();
	});
});

describe("MeetingDetailSheet — transcript availability", () => {
	beforeEach(() => vi.clearAllMocks());

	it("shows the availability chip and a Transcript tab", async () => {
		getMeeting.mockResolvedValue({
			subject: "Sprint Review",
			meetingDate: new Date("2026-06-10"),
			organizer: "Ann",
			participants: [],
			summary: null,
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
		});
		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);
		await waitFor(() =>
			expect(
				screen.getByText("Transcript available"),
			).toBeInTheDocument(),
		);
		expect(
			screen.getByRole("tab", { name: /transcript/i }),
		).toBeInTheDocument();
	});
});

function meetingFixture(overrides: Record<string, unknown>) {
	return {
		subject: "Sprint Review",
		meetingDate: new Date("2026-06-10"),
		organizer: "Ann",
		participants: [],
		summary: null,
		analysisStatus: "SCANNED",
		analyzedAt: null,
		analysisError: null,
		hasTranscript: true,
		transcriptRef: "row1",
		insightsReady: false,
		createdTasks: [],
		decisions: null,
		actionItems: [],
		openQuestions: null,
		declinedTasks: null,
		...overrides,
	};
}

describe("MeetingDetailSheet — on-demand insights", () => {
	beforeEach(() => vi.clearAllMocks());

	it("auto-triggers extraction and shows generating states when insights are not ready", async () => {
		getMeeting.mockResolvedValue(meetingFixture({}));
		extractInsights.mockResolvedValue({ started: true, reason: "started" });

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);

		await waitFor(() =>
			expect(extractInsights).toHaveBeenCalledWith({
				projectId: "pr1",
				organizationId: null,
				transcriptId: "t1",
			}),
		);
		expect(extractInsights).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Generating summary…")).toBeInTheDocument();
		expect(screen.getByText("Generating insights…")).toBeInTheDocument();
	});

	it("does not trigger extraction when the insights cache is current", async () => {
		getMeeting.mockResolvedValue(
			meetingFixture({ insightsReady: true, summary: "All done." }),
		);

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);

		await waitFor(() =>
			expect(screen.getByText("All done.")).toBeInTheDocument(),
		);
		expect(extractInsights).not.toHaveBeenCalled();
	});

	it("falls back to terminal empty states when the extraction trigger fails", async () => {
		getMeeting.mockResolvedValue(meetingFixture({}));
		extractInsights.mockRejectedValue(new Error("boom"));

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);

		await waitFor(() =>
			expect(
				screen.getByText(
					/Summary generation didn't finish\. It may have failed or timed out\./,
				),
			).toBeInTheDocument(),
		);
		// The active (decisions) insight tab shows the terminal "None". The
		// created-tasks list now has its own dedicated empty-state copy instead
		// of contributing a second "None".
		expect(screen.getByText("None")).toBeInTheDocument();
		expect(
			screen.getByText("No tickets created from this meeting."),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Generating insights…"),
		).not.toBeInTheDocument();
	});

	it("does not trigger extraction when there is no transcript", async () => {
		getMeeting.mockResolvedValue(
			meetingFixture({ hasTranscript: false, insightsReady: false }),
		);

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);

		await waitFor(() =>
			expect(
				screen.getByText("No summary available."),
			).toBeInTheDocument(),
		);
		expect(extractInsights).not.toHaveBeenCalled();
	});

	it("renders the summary as markdown, not raw text", async () => {
		getMeeting.mockResolvedValue(
			meetingFixture({
				insightsReady: true,
				summary: "## Key outcomes\n\n- Shipped the digest",
			}),
		);

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);

		await waitFor(() =>
			expect(
				screen.getByRole("heading", { name: "Key outcomes" }),
			).toBeInTheDocument(),
		);
		expect(screen.getByText("Shipped the digest")).toBeInTheDocument();
	});
});

describe("MeetingDetailSheet — regenerate", () => {
	beforeEach(() => vi.clearAllMocks());

	it("force-regenerates when the cache is already filled and keeps the previous summary visible", async () => {
		getMeeting.mockResolvedValue(
			meetingFixture({
				insightsReady: true,
				summary: "All done.",
				// Wire format: orpc serializes DateTime columns to ISO strings.
				insightsExtractedAt: "2026-06-10T00:00:00.000Z",
			}),
		);
		extractInsights.mockResolvedValue({ started: true, reason: "started" });

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);

		await waitFor(() =>
			expect(screen.getByText("All done.")).toBeInTheDocument(),
		);
		expect(extractInsights).not.toHaveBeenCalled();

		fireEvent.click(
			screen.getByRole("button", { name: "Regenerate summary" }),
		);

		await waitFor(() =>
			expect(extractInsights).toHaveBeenCalledWith({
				projectId: "pr1",
				organizationId: null,
				transcriptId: "t1",
				force: true,
			}),
		);
		// The stale summary keeps rendering while the forced re-run is in flight —
		// there is no separate "regenerating" placeholder for the manual path.
		expect(screen.getByText("All done.")).toBeInTheDocument();
	});

	it("does not re-fire the auto-trigger effect during a manual regenerate", async () => {
		getMeeting.mockResolvedValue(
			meetingFixture({
				insightsReady: true,
				summary: "All done.",
				// Wire format: orpc serializes DateTime columns to ISO strings.
				insightsExtractedAt: "2026-06-10T00:00:00.000Z",
			}),
		);
		extractInsights.mockResolvedValue({ started: true, reason: "started" });

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByText("All done.")).toBeInTheDocument(),
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Regenerate summary" }),
		);
		await waitFor(() => expect(extractInsights).toHaveBeenCalledTimes(1));

		// insightsPending is false throughout (insightsReady never flips), so the
		// auto-trigger effect's own guard already keeps it from firing; this
		// asserts only one call ever went out for the click.
		expect(extractInsights).toHaveBeenCalledTimes(1);
	});

	it("clears the regenerating state immediately when the run reports not-needed (nothing to extract)", async () => {
		getMeeting.mockResolvedValue(
			meetingFixture({
				insightsReady: true,
				summary: "All done.",
				insightsExtractedAt: "2026-06-10T00:00:00.000Z",
			}),
		);
		// force never overrides the text-source guard — a meeting with no
		// context body and no stored summary comes back not-needed even on a
		// forced regenerate.
		extractInsights.mockResolvedValue({
			started: false,
			reason: "not-needed",
		});

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByText("All done.")).toBeInTheDocument(),
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Regenerate summary" }),
		);
		await waitFor(() => expect(extractInsights).toHaveBeenCalledTimes(1));

		// No stalled-refresh error, and the button returns to its idle label
		// right away instead of polling for ~90s before giving up.
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Regenerate summary" }),
			).not.toBeDisabled(),
		);
		expect(screen.queryByText(/didn.t finish/i)).not.toBeInTheDocument();
	});
});

describe("MeetingDetailSheet — regenerate polling termination", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	// Fake-timer variant of waitFor: advance the clock and flush the React
	// Query notify/refetch timers plus React renders scheduled inside them.
	async function advance(ms: number) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});
	}

	async function openWithOldSummary() {
		getMeeting.mockResolvedValue(
			meetingFixture({
				insightsReady: true,
				summary: "Old summary.",
				// Wire format: orpc serializes DateTime columns to ISO strings.
				insightsExtractedAt: "2026-06-10T00:00:00.000Z",
			}),
		);
		extractInsights.mockResolvedValue({ started: true, reason: "started" });

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);
		await advance(0);
		expect(screen.getByText("Old summary.")).toBeInTheDocument();

		fireEvent.click(
			screen.getByRole("button", { name: "Regenerate summary" }),
		);
		await advance(0); // flush the force trigger's resolution
		expect(extractInsights).toHaveBeenCalledTimes(1);
	}

	it("stops polling and shows the fresh summary once a new insightsExtractedAt lands", async () => {
		await openWithOldSummary();

		// While the manual run is in flight the button is disabled.
		expect(
			screen.getByRole("button", { name: "Regenerating summary…" }),
		).toBeDisabled();

		// The next poll observes the fresh extraction (new timestamp).
		getMeeting.mockResolvedValue(
			meetingFixture({
				insightsReady: true,
				summary: "Fresh summary.",
				insightsExtractedAt: "2026-06-11T00:00:00.000Z",
			}),
		);
		await advance(4000);

		expect(screen.getByText("Fresh summary.")).toBeInTheDocument();
		expect(screen.queryByText(/didn't finish/)).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Regenerate summary" }),
		).toBeEnabled();

		// Polling terminated: no further getMeeting calls on later ticks.
		const settledCalls = getMeeting.mock.calls.length;
		await advance(20000);
		expect(getMeeting.mock.calls.length).toBe(settledCalls);
	});

	it("keeps the old summary and shows the stalled note when a manual run exhausts its polls", async () => {
		await openWithOldSummary();

		// getMeeting keeps returning the baseline timestamp — the forced run
		// never lands, so the poll budget (22) runs out.
		for (let i = 0; i < 25; i++) {
			await advance(4000);
		}

		expect(screen.getByText("Old summary.")).toBeInTheDocument();
		expect(
			screen.getByText(
				/Summary refresh didn't finish\. It may have failed or timed out\./,
			),
		).toBeInTheDocument();

		// Polling terminated: no further getMeeting calls on later ticks.
		const settledCalls = getMeeting.mock.calls.length;
		await advance(20000);
		expect(getMeeting.mock.calls.length).toBe(settledCalls);
	});
});

describe("MeetingDetailSheet — create feature proposals (#1814 FR7)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("is disabled when the meeting has no transcript", async () => {
		getMeeting.mockResolvedValue(
			meetingFixture({ hasTranscript: false, insightsReady: false }),
		);
		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);
		await waitFor(() =>
			expect(
				screen.getByRole("button", {
					name: "Create proposals",
				}),
			).toBeDisabled(),
		);
		expect(generateProposals).not.toHaveBeenCalled();
	});

	it("calls generateProposals with projectId/organizationId/transcriptId and shows the started message", async () => {
		getMeeting.mockResolvedValue(meetingFixture({ insightsReady: true }));
		generateProposals.mockResolvedValue({
			status: "started",
			proposalId: null,
		});

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId="org1"
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);

		const button = await screen.findByRole("button", {
			name: "Create proposals",
		});
		expect(button).toBeEnabled();
		fireEvent.click(button);

		expect(
			await screen.findByText(
				/proposals will appear in the Proposal Inbox/,
			),
		).toBeInTheDocument();
		expect(generateProposals).toHaveBeenCalledWith({
			projectId: "pr1",
			organizationId: "org1",
			transcriptId: "t1",
		});
	});

	it.each([
		["in-progress", "Analysis is already running for this meeting."],
		[
			"already-analyzed",
			"Proposals for this meeting already exist — review them in the Proposal Inbox.",
		],
		[
			"no-actionable-content",
			"No actionable content was detected in this meeting, so no proposals were generated.",
		],
		["no-transcript", "This meeting has no transcript to analyze."],
	])("shows the mapped message for status %s", async (status, message) => {
		getMeeting.mockResolvedValue(meetingFixture({ insightsReady: true }));
		generateProposals.mockResolvedValue({ status, proposalId: null });

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Create proposals",
			}),
		);
		expect(await screen.findByText(message)).toBeInTheDocument();
	});

	it("shows a fallback message when the request fails", async () => {
		getMeeting.mockResolvedValue(meetingFixture({ insightsReady: true }));
		generateProposals.mockRejectedValue(new Error("boom"));

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Create proposals",
			}),
		);
		expect(
			await screen.findByText(
				"Could not start the analysis. Please try again.",
			),
		).toBeInTheDocument();
	});

	it("disables the button and shows Starting… while the request is in flight", async () => {
		getMeeting.mockResolvedValue(meetingFixture({ insightsReady: true }));
		let resolvePromise: (value: {
			status: string;
			proposalId: string | null;
		}) => void = () => {};
		generateProposals.mockReturnValue(
			new Promise((resolve) => {
				resolvePromise = resolve;
			}),
		);

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Create proposals",
			}),
		);

		expect(
			await screen.findByRole("button", { name: "Starting…" }),
		).toBeDisabled();

		resolvePromise({ status: "started", proposalId: null });

		await waitFor(() =>
			expect(
				screen.getByRole("button", {
					name: "Create proposals",
				}),
			).toBeEnabled(),
		);
	});

	it("resets the proposal message when the transcript changes", async () => {
		getMeeting.mockResolvedValue(meetingFixture({ insightsReady: true }));
		generateProposals.mockResolvedValue({
			status: "started",
			proposalId: null,
		});

		const { rerender } = renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Create proposals",
			}),
		);
		expect(
			await screen.findByText(
				/proposals will appear in the Proposal Inbox/,
			),
		).toBeInTheDocument();

		const queryClient = new QueryClient();
		rerender(
			<QueryClientProvider client={queryClient}>
				<MeetingDetailSheet
					projectId="pr1"
					organizationId={null}
					transcriptId="t2"
					onClose={() => {}}
				/>
			</QueryClientProvider>,
		);

		await waitFor(() =>
			expect(
				screen.queryByText(
					/proposals will appear in the Proposal Inbox/,
				),
			).not.toBeInTheDocument(),
		);
	});
});

describe("MeetingDetailSheet — action item toggle invalidation (#1814 final-review minor #8)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("calls onActionItemToggled after a checkbox toggle completes", async () => {
		getMeeting.mockResolvedValue(
			meetingFixture({
				insightsReady: true,
				actionItems: [
					{
						id: "a1",
						text: "Fix chart",
						tentativeOwnerName: null,
						dueHint: null,
						completedAt: null,
					},
				],
			}),
		);
		setActionItemCompleted.mockResolvedValue({});
		const onActionItemToggled = vi.fn();
		const user = userEvent.setup();

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
				onActionItemToggled={onActionItemToggled}
			/>,
		);

		await user.click(await screen.findByRole("tab", { name: "Actions" }));
		await user.click(await screen.findByRole("checkbox"));

		await waitFor(() =>
			expect(setActionItemCompleted).toHaveBeenCalledWith({
				projectId: "pr1",
				organizationId: null,
				actionItemId: "a1",
				completed: true,
			}),
		);
		await waitFor(() =>
			expect(onActionItemToggled).toHaveBeenCalledTimes(1),
		);
	});

	it("defaults to a no-op when onActionItemToggled is not passed, so the toggle still succeeds", async () => {
		getMeeting.mockResolvedValue(
			meetingFixture({
				insightsReady: true,
				actionItems: [
					{
						id: "a1",
						text: "Fix chart",
						tentativeOwnerName: null,
						dueHint: null,
						completedAt: null,
					},
				],
			}),
		);
		setActionItemCompleted.mockResolvedValue({});
		const user = userEvent.setup();

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);

		await user.click(await screen.findByRole("tab", { name: "Actions" }));
		await user.click(await screen.findByRole("checkbox"));

		await waitFor(() =>
			expect(setActionItemCompleted).toHaveBeenCalledTimes(1),
		);
	});
});

describe("MeetingDetailSheet — jump to transcript (#1896)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("clicking a decision's Jump-to-transcript switches to the Transcript tab", async () => {
		getMeeting.mockResolvedValue(
			meetingFixture({
				insightsReady: true,
				decisions: [
					{ text: "Ship it", anchorLine: 4, sourceQuote: "we ship" },
				],
			}),
		);
		getContent.mockResolvedValue({
			transcript: { content: "l1\nl2\nl3\nwe ship it" },
		});

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);

		const jump = await screen.findByRole("button", {
			name: "Jump to transcript for: Ship it",
		});
		fireEvent.click(jump);

		expect(screen.getByRole("tab", { name: /Transcript/ })).toHaveAttribute(
			"data-state",
			"active",
		);
	});

	it("renders no jump button for an item without anchorLine", async () => {
		getMeeting.mockResolvedValue(
			meetingFixture({
				insightsReady: true,
				decisions: [{ text: "No anchor" }],
			}),
		);

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);

		expect(await screen.findByText("No anchor")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Jump to transcript/ }),
		).not.toBeInTheDocument();
	});

	it("manual tab switch clears the jump: re-opening Transcript does not re-scroll", async () => {
		Element.prototype.scrollIntoView = vi.fn();
		getMeeting.mockResolvedValue(
			meetingFixture({
				insightsReady: true,
				decisions: [
					{ text: "Ship it", anchorLine: 3, sourceQuote: "we ship" },
				],
			}),
		);
		getContent.mockResolvedValue({
			transcript: { content: "l1\nl2\nwe ship it\nl4" },
		});

		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);

		// Jump → switches to Transcript and scrolls once.
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Jump to transcript for: Ship it",
			}),
		);
		await waitFor(() =>
			expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1),
		);

		// Manually leave and re-open the Transcript tab (remounts the pane).
		fireEvent.click(screen.getByRole("tab", { name: /Decisions/ }));
		fireEvent.click(screen.getByRole("tab", { name: /Transcript/ }));

		// The pending jump was cleared on the manual switch, so the remount
		// must NOT re-scroll to the stale line.
		await new Promise((r) => setTimeout(r, 50));
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
	});
});

describe("TranscriptPane", () => {
	beforeEach(() => vi.clearAllMocks());

	it("loads and renders the full transcript content", async () => {
		getContent.mockResolvedValue({
			transcript: { content: "Ann: hello\nBob: hi" },
		});
		renderWithQuery(
			<TranscriptPane
				projectId="pr1"
				organizationId={null}
				transcriptRef="row1"
				hasTranscript={true}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByText(/Ann: hello/)).toBeInTheDocument(),
		);
		expect(getContent).toHaveBeenCalledWith({
			projectId: "pr1",
			organizationId: null,
			transcriptRef: "row1",
		});
		expect(
			screen.getByRole("button", { name: "Download transcript" }),
		).toBeInTheDocument();
	});

	it("shows a calm empty state when no transcript exists", () => {
		renderWithQuery(
			<TranscriptPane
				projectId="pr1"
				organizationId={null}
				transcriptRef="row1"
				hasTranscript={false}
			/>,
		);
		expect(
			screen.getByText(/no transcript is available for this meeting/i),
		).toBeInTheDocument();
		expect(getContent).not.toHaveBeenCalled();
	});
});

describe("TranscriptPane scroll-to-line", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getContent.mockResolvedValue({
			transcript: {
				content: "line one\nline two\nline three\nline four",
			},
		});
		// jsdom stub
		Element.prototype.scrollIntoView = vi.fn();
	});

	function renderPane(jumpTarget: { line: number; nonce: number } | null) {
		return renderWithQuery(
			<TranscriptPane
				projectId="pr1"
				organizationId={null}
				transcriptRef="row1"
				hasTranscript={true}
				jumpTarget={jumpTarget}
			/>,
		);
	}

	it("scrolls to and flashes the anchored line", async () => {
		renderPane({ line: 3, nonce: 1 });
		// wait for content to load
		expect(await screen.findByText("line three")).toBeInTheDocument();
		await waitFor(() =>
			expect(Element.prototype.scrollIntoView).toHaveBeenCalled(),
		);
		expect(screen.getByText("line three")).toHaveClass(
			"transcript-line-flash",
		);
	});

	it("renders an 'Open full transcript' deep link carrying the jumped line", async () => {
		render(
			<QueryClientProvider client={new QueryClient()}>
				<TranscriptPane
					projectId="pr1"
					organizationId={null}
					transcriptRef="row1"
					hasTranscript={true}
					jumpTarget={{ line: 3, nonce: 1 }}
					transcriptContextId="ctx1"
				/>
			</QueryClientProvider>,
		);
		const link = await screen.findByRole("link", {
			name: /Open full transcript/,
		});
		expect(link).toHaveAttribute(
			"href",
			"/app/acme/projects/p1/contexts/ctx1?back=meeting-digest#t-3",
		);
	});

	it("omits the deep line fragment when no jump is active, and no link without a context id", async () => {
		const { rerender } = render(
			<QueryClientProvider client={new QueryClient()}>
				<TranscriptPane
					projectId="pr1"
					organizationId={null}
					transcriptRef="row1"
					hasTranscript={true}
					jumpTarget={null}
					transcriptContextId="ctx1"
				/>
			</QueryClientProvider>,
		);
		expect(
			(
				await screen.findByRole("link", {
					name: /Open full transcript/,
				})
			).getAttribute("href"),
		).toBe("/app/acme/projects/p1/contexts/ctx1?back=meeting-digest");

		rerender(
			<QueryClientProvider client={new QueryClient()}>
				<TranscriptPane
					projectId="pr1"
					organizationId={null}
					transcriptRef="row1"
					hasTranscript={true}
					jumpTarget={null}
					transcriptContextId={null}
				/>
			</QueryClientProvider>,
		);
		await waitFor(() =>
			expect(
				screen.queryByRole("link", { name: /Open full transcript/ }),
			).not.toBeInTheDocument(),
		);
	});

	it("announces the landing passage to screen readers on jump", async () => {
		renderPane({ line: 3, nonce: 1 });
		await waitFor(() =>
			expect(Element.prototype.scrollIntoView).toHaveBeenCalled(),
		);
		const live = document.querySelector('[aria-live="polite"]');
		expect(live).not.toBeNull();
		expect(live).toHaveTextContent("Jumped to transcript: line three");
	});

	it("is a no-op for an out-of-range line (no crash, no scroll)", async () => {
		renderPane({ line: 999, nonce: 1 });
		expect(await screen.findByText("line one")).toBeInTheDocument();
		// give the effect a tick
		await new Promise((r) => setTimeout(r, 20));
		expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
	});

	it("renders no flash when jumpTarget is null", async () => {
		renderPane(null);
		expect(await screen.findByText("line one")).toBeInTheDocument();
		expect(document.querySelector(".transcript-line-flash")).toBeNull();
	});

	it("renders blank lines as empty divs (no injected space) for copy fidelity", async () => {
		getContent.mockReset().mockResolvedValue({
			transcript: { content: "alpha\n\nbeta" },
		});
		renderPane(null);
		const alphaLine = await screen.findByText("alpha");
		const scrollContainer = alphaLine.parentElement as HTMLElement;
		// One div per line; the blank middle line must be an EMPTY div, not a
		// space, so select-all-copy reproduces the stored body byte-for-byte.
		expect(scrollContainer.children).toHaveLength(3);
		expect(scrollContainer.children[1].textContent).toBe("");
	});

	it("clears the flash highlight after its timeout (independent of the jump effect)", async () => {
		renderPane({ line: 3, nonce: 1 });
		await waitFor(() =>
			expect(screen.getByText("line three")).toHaveClass(
				"transcript-line-flash",
			),
		);
		// The flash clears on its own effect, so it drops even though the jump
		// effect early-returns on the already-consumed nonce.
		await waitFor(
			() =>
				expect(screen.getByText("line three")).not.toHaveClass(
					"transcript-line-flash",
				),
			{ timeout: 2500 },
		);
	});

	it("does not re-scroll on a background content refetch (nonce already consumed)", async () => {
		// First load, then a background refetch that returns DIFFERENT content
		// (a new `lines` identity) with the same query key.
		getContent
			.mockReset()
			.mockResolvedValueOnce({
				transcript: {
					content: "line one\nline two\nline three\nline four",
				},
			})
			.mockResolvedValueOnce({
				transcript: {
					content: "line one\nline two\nline three\nline four v2",
				},
			});
		const queryClient = new QueryClient();
		render(
			<QueryClientProvider client={queryClient}>
				<TranscriptPane
					projectId="pr1"
					organizationId={null}
					transcriptRef="row1"
					hasTranscript={true}
					jumpTarget={{ line: 3, nonce: 1 }}
				/>
			</QueryClientProvider>,
		);
		expect(await screen.findByText("line three")).toBeInTheDocument();
		await waitFor(() =>
			expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1),
		);

		// Force a background refetch → new content lands, `lines` changes, the
		// effect re-runs with an already-consumed nonce → must NOT re-scroll.
		await act(async () => {
			await queryClient.invalidateQueries();
		});
		expect(await screen.findByText("line four v2")).toBeInTheDocument();
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
	});

	it("fires again for a new jumpTarget nonce (a fresh click)", async () => {
		const queryClient = new QueryClient();
		const { rerender } = render(
			<QueryClientProvider client={queryClient}>
				<TranscriptPane
					projectId="pr1"
					organizationId={null}
					transcriptRef="row1"
					hasTranscript={true}
					jumpTarget={{ line: 3, nonce: 1 }}
				/>
			</QueryClientProvider>,
		);
		expect(await screen.findByText("line three")).toBeInTheDocument();
		await waitFor(() =>
			expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1),
		);

		// A new jump (incremented nonce, same mounted component, same query
		// client so no refetch) must fire the scroll + flash again.
		rerender(
			<QueryClientProvider client={queryClient}>
				<TranscriptPane
					projectId="pr1"
					organizationId={null}
					transcriptRef="row1"
					hasTranscript={true}
					jumpTarget={{ line: 2, nonce: 2 }}
				/>
			</QueryClientProvider>,
		);
		await waitFor(() =>
			expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(2),
		);
		expect(screen.getByText("line two")).toHaveClass(
			"transcript-line-flash",
		);
	});
});
