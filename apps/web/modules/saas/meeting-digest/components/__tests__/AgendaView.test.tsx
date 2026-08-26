import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { meetingDigest: { setActionItemCompleted: vi.fn() } },
	},
}));

import { AgendaView } from "../AgendaView";

const base = {
	linkedMeetingId: "lm1",
	transcriptId: "graph-1",
	transcriptRef: "cuid1",
	hasTranscript: true,
	analysisStatus: "SCANNED" as const,
	createdTaskCount: 0,
	participantCount: 3,
	includedInDigest: true,
	insightsReady: true,
	decisions: [{ text: "Ship digest v2" }],
	actionItems: [
		{
			id: "a1",
			text: "Fix chart",
			tentativeOwnerName: "Bob",
			dueHint: null,
			completedAt: null,
		},
	],
	openQuestions: [{ text: "Backfill?" }],
};

describe("AgendaView", () => {
	it("groups meetings under day headings with nested insight sections", () => {
		render(
			<AgendaView
				monthDate={new Date("2026-07-15")}
				meetings={[
					{
						...base,
						subject: "Fabric Daily Sync",
						meetingDate: new Date("2026-07-06T09:00:00"),
					},
				]}
				projectId="p1"
				organizationId={null}
				onSelect={() => {}}
				onToggled={() => {}}
			/>,
		);
		expect(screen.getByText(/Mon(day)?, Jul(y)? 6/)).toBeInTheDocument();
		expect(screen.getByText("Fabric Daily Sync")).toBeInTheDocument();
		expect(screen.getByText("Decisions")).toBeInTheDocument();
		expect(screen.getByText("Ship digest v2")).toBeInTheDocument();
		expect(screen.getByText("Questions")).toBeInTheDocument();
		expect(screen.getByRole("checkbox")).toBeInTheDocument();
	});

	it("shows a no-summary state for meetings without insights", () => {
		render(
			<AgendaView
				monthDate={new Date("2026-07-15")}
				meetings={[
					{
						...base,
						subject: "Ad-hoc",
						meetingDate: new Date("2026-07-03T09:00:00"),
						hasTranscript: false,
						insightsReady: false,
						decisions: [],
						actionItems: [],
						openQuestions: [],
					},
				]}
				projectId="p1"
				organizationId={null}
				onSelect={() => {}}
				onToggled={() => {}}
			/>,
		);
		expect(screen.getByText("No summary available")).toBeInTheDocument();
	});

	it("pending entries show a Generate summary button that fires onGenerate", () => {
		const onGenerate = vi.fn();
		render(
			<AgendaView
				monthDate={new Date("2026-07-15")}
				meetings={[
					{
						...base,
						subject: "Pending mtg",
						meetingDate: new Date("2026-07-06T09:00:00"),
						hasTranscript: true,
						insightsReady: false,
						decisions: [],
						actionItems: [],
						openQuestions: [],
					},
				]}
				projectId="p1"
				organizationId={null}
				onSelect={() => {}}
				onToggled={() => {}}
				onGenerate={onGenerate}
				generatingRefs={new Set()}
				summaryErrors={new Map()}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /generate summary/i }),
		);
		expect(onGenerate).toHaveBeenCalledWith("graph-1", "cuid1");
	});

	it("shows the failure message alongside the retry button when generation failed (FR6)", () => {
		render(
			<AgendaView
				monthDate={new Date("2026-07-15")}
				meetings={[
					{
						...base,
						subject: "Failed mtg",
						meetingDate: new Date("2026-07-06T09:00:00"),
						hasTranscript: true,
						insightsReady: false,
						decisions: [],
						actionItems: [],
						openQuestions: [],
					},
				]}
				projectId="p1"
				organizationId={null}
				onSelect={() => {}}
				onToggled={() => {}}
				onGenerate={() => {}}
				generatingRefs={new Set()}
				summaryErrors={
					new Map([
						["cuid1", "Summary generation failed — try again."],
					])
				}
			/>,
		);
		const message = screen.getByText(
			"Summary generation failed — try again.",
		);
		expect(message).toBeInTheDocument();
		// Error styling, not the muted success look.
		expect(message.className).toContain("text-destructive");
		// The button stays available as the retry affordance.
		expect(
			screen.getByRole("button", { name: /generate summary/i }),
		).toBeInTheDocument();
	});

	it("entries in generatingRefs show Generating…", () => {
		render(
			<AgendaView
				monthDate={new Date("2026-07-15")}
				meetings={[
					{
						...base,
						subject: "Gen mtg",
						meetingDate: new Date("2026-07-06T09:00:00"),
						hasTranscript: true,
						insightsReady: false,
						decisions: [],
						actionItems: [],
						openQuestions: [],
					},
				]}
				projectId="p1"
				organizationId={null}
				onSelect={() => {}}
				onToggled={() => {}}
				onGenerate={() => {}}
				generatingRefs={new Set(["cuid1"])}
				summaryErrors={new Map()}
			/>,
		);
		expect(screen.getByText("Generating…")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /generate summary/i }),
		).toBeNull();
	});
});

describe("AgendaView — awaiting-transcript rows", () => {
	const awaiting = {
		linkedMeetingId: "lm9",
		subject: "Fabric DSU",
		occurrenceStart: new Date("2026-06-10T09:00:00Z"),
	};

	const baseProps = {
		monthDate: new Date("2026-06-15"),
		meetings: [],
		projectId: "p1",
		organizationId: null,
		onSelect: vi.fn(),
		onToggled: vi.fn(),
		onGenerate: vi.fn(),
		generatingRefs: new Set<string>(),
		summaryErrors: new Map<string, string>(),
	};

	it("renders an awaiting row under its own day heading", () => {
		render(<AgendaView {...baseProps} awaitingMeetings={[awaiting]} />);
		expect(screen.getByText("Fabric DSU")).toBeInTheDocument();
		expect(screen.getByText("Not synced yet")).toBeInTheDocument();
	});

	it("no longer shows the empty-month copy when only awaiting rows exist", () => {
		render(<AgendaView {...baseProps} awaitingMeetings={[awaiting]} />);
		expect(
			screen.queryByText("No meetings this month."),
		).not.toBeInTheDocument();
	});

	it("keeps the empty-month copy when there is nothing at all", () => {
		render(<AgendaView {...baseProps} awaitingMeetings={[]} />);
		expect(screen.getByText("No meetings this month.")).toBeInTheDocument();
	});
});
