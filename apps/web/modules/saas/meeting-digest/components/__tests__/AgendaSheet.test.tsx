import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgendaBody } from "../AgendaSheet";

const base = {
	id: "ag_1",
	occurrenceStart: "2026-07-25T09:00:00.000Z",
	generatedAt: "2026-07-24T12:00:00.000Z",
	generationError: null,
	editedAt: null,
	editedById: null,
	version: 1,
};

describe("AgendaBody", () => {
	it("shows the no-transcripts notice from contextStats, not from the text (FR5/AC2)", () => {
		render(
			<AgendaBody
				agenda={{
					...base,
					status: "READY",
					content: "## Agenda\n\n1. **Carry-over actions**",
					contextStats: { hadPriorTranscripts: false, truncated: {} },
				}}
				canEdit
				stalled={false}
				onSave={vi.fn()}
			/>,
		);

		// #2105 reworded this: the collector now bounds history to a lookback
		// window, so "none were found" also covers "all of it is older than the
		// window". The notice names the window rather than claiming none exist.
		expect(
			screen.getByText(/no prior meetings from this series/i),
		).toBeInTheDocument();
	});

	it("hides the notice when prior transcripts fed the agenda", () => {
		render(
			<AgendaBody
				agenda={{
					...base,
					status: "READY",
					content: "## Agenda",
					contextStats: { hadPriorTranscripts: true, truncated: {} },
				}}
				canEdit
				stalled={false}
				onSave={vi.fn()}
			/>,
		);

		expect(
			screen.queryByText(/no prior meeting transcripts were found/i),
		).not.toBeInTheDocument();
	});

	it("says so when a cap truncated the context", () => {
		render(
			<AgendaBody
				agenda={{
					...base,
					status: "READY",
					content: "## Agenda",
					contextStats: {
						hadPriorTranscripts: true,
						truncated: { actionItems: true },
					},
				}}
				canEdit
				stalled={false}
				onSave={vi.fn()}
			/>,
		);

		expect(screen.getByText(/only the most recent/i)).toBeInTheDocument();
	});

	it("surfaces the failure reason rather than an empty state", () => {
		render(
			<AgendaBody
				agenda={{
					...base,
					status: "FAILED",
					content: null,
					contextStats: null,
					generationError: "model timeout",
				}}
				canEdit
				stalled={false}
				onSave={vi.fn()}
			/>,
		);

		expect(screen.getByText(/model timeout/i)).toBeInTheDocument();
	});

	it("reaches a terminal state when the poll budget is exhausted", () => {
		render(
			<AgendaBody
				agenda={{
					...base,
					status: "GENERATING",
					content: null,
					contextStats: null,
				}}
				canEdit
				stalled
				onSave={vi.fn()}
			/>,
		);

		expect(
			screen.getByText(/taking longer than expected/i),
		).toBeInTheDocument();
	});

	it("renders read-only for non-admins (D4)", () => {
		render(
			<AgendaBody
				agenda={{
					...base,
					status: "READY",
					content: "## Agenda",
					contextStats: { hadPriorTranscripts: true, truncated: {} },
				}}
				canEdit={false}
				stalled={false}
				onSave={vi.fn()}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: /save/i }),
		).not.toBeInTheDocument();
	});

	// #1901 final review, FIX 4: markAgendaFailedActivity writes only
	// status/generationError — the prior content (including hand edits) is
	// still in the row. Returning early on just the error made a good agenda
	// plus one failed regenerate into content nobody could reach anymore.
	describe("FAILED status retains the last successful content", () => {
		it("renders the retained content below the error, noted as the last successful version", () => {
			render(
				<AgendaBody
					agenda={{
						...base,
						status: "FAILED",
						content: "## Original agenda\n\n1. Item one",
						contextStats: null,
						generationError: "model timeout",
					}}
					canEdit
					stalled={false}
					onSave={vi.fn()}
				/>,
			);

			expect(screen.getByText(/model timeout/i)).toBeInTheDocument();
			expect(
				screen.getByText(/last successful version/i),
			).toBeInTheDocument();
			expect(screen.getByText(/original agenda/i)).toBeInTheDocument();
			expect(screen.getByText(/item one/i)).toBeInTheDocument();
		});

		it("does not claim a retained version exists when there is no prior content", () => {
			render(
				<AgendaBody
					agenda={{
						...base,
						status: "FAILED",
						content: null,
						contextStats: null,
						generationError: "model timeout",
					}}
					canEdit
					stalled={false}
					onSave={vi.fn()}
				/>,
			);

			expect(screen.getByText(/model timeout/i)).toBeInTheDocument();
			expect(
				screen.queryByText(/last successful version/i),
			).not.toBeInTheDocument();
		});
	});

	// #1901 final review — dirty guard (reviewer's ask alongside FIX 3): once
	// generation bumps `version` on every READY write, a background refetch
	// mid-typing will legitimately deliver new content, so this guard becomes
	// the PRIMARY protection against clobbering an in-progress draft, not just
	// defence-in-depth. Pin it directly rather than only through the save-
	// conflict path.
	describe("dirty guard blocks an incoming refetch from clobbering an in-progress draft", () => {
		it("keeps the user's typed draft when new content arrives while dirty", () => {
			const { rerender } = render(
				<AgendaBody
					agenda={{
						...base,
						status: "READY",
						content: "## Original agenda",
						contextStats: {
							hadPriorTranscripts: true,
							truncated: {},
						},
					}}
					canEdit
					stalled={false}
					onSave={vi.fn()}
				/>,
			);

			const textarea = screen.getByLabelText(
				"Agenda content",
			) as HTMLTextAreaElement;
			fireEvent.change(textarea, {
				target: { value: "## Original agenda\nmy in-progress note" },
			});
			expect(textarea.value).toBe(
				"## Original agenda\nmy in-progress note",
			);

			// A background refetch (e.g. someone else's regeneration landing)
			// delivers new content underneath the user while they are still
			// typing.
			rerender(
				<AgendaBody
					agenda={{
						...base,
						status: "READY",
						content: "## Regenerated agenda from someone else",
						contextStats: {
							hadPriorTranscripts: true,
							truncated: {},
						},
					}}
					canEdit
					stalled={false}
					onSave={vi.fn()}
				/>,
			);

			expect(textarea.value).toBe(
				"## Original agenda\nmy in-progress note",
			);
		});

		it("still syncs incoming content when the draft is clean (not dirty)", () => {
			const { rerender } = render(
				<AgendaBody
					agenda={{
						...base,
						status: "READY",
						content: "## Original agenda",
						contextStats: {
							hadPriorTranscripts: true,
							truncated: {},
						},
					}}
					canEdit
					stalled={false}
					onSave={vi.fn()}
				/>,
			);

			const textarea = screen.getByLabelText(
				"Agenda content",
			) as HTMLTextAreaElement;
			expect(textarea.value).toBe("## Original agenda");

			rerender(
				<AgendaBody
					agenda={{
						...base,
						status: "READY",
						content: "## Regenerated agenda",
						contextStats: {
							hadPriorTranscripts: true,
							truncated: {},
						},
					}}
					canEdit
					stalled={false}
					onSave={vi.fn()}
				/>,
			);

			expect(textarea.value).toBe("## Regenerated agenda");
		});
	});
});

/**
 * Cross-meeting context aggregation (#2105) — UC1 step 4, "optionally expanding
 * to see generation methodology".
 */
describe("AgendaBody — how this agenda was built (#2105)", () => {
	const withStats = (contextStats: Record<string, unknown>) => (
		<AgendaBody
			agenda={{
				...base,
				status: "READY",
				content: "## Agenda",
				contextStats,
			}}
			canEdit={false}
			stalled={false}
			onSave={vi.fn()}
		/>
	);

	it("summarises the sources and the lookback window it used", () => {
		render(
			withStats({
				hadPriorTranscripts: true,
				priorTranscriptCount: 4,
				carriedActionItemCount: 3,
				priorMeetingWindowDays: 90,
				openActionItemCount: 7,
				openDecisionCount: 2,
				blockedStoryCount: 1,
				truncated: {},
			}),
		);

		expect(
			screen.getByText(/how this agenda was built/i),
		).toBeInTheDocument();
		expect(screen.getByText(/4 prior meetings/i)).toBeInTheDocument();
		expect(screen.getByText(/last 90 days/i)).toBeInTheDocument();
		expect(screen.getByText(/3 carried-forward/i)).toBeInTheDocument();
	});

	it("distinguishes 'nothing carried over' from 'we did not look' (FR3)", () => {
		render(
			withStats({
				hadPriorTranscripts: true,
				priorTranscriptCount: 2,
				carriedActionItemCount: 0,
				priorMeetingWindowDays: 90,
				truncated: {},
			}),
		);

		expect(screen.getByText(/2 prior meetings/i)).toBeInTheDocument();
		expect(screen.getByText(/0 carried-forward/i)).toBeInTheDocument();
	});

	it("renders nothing for agendas generated before these stats existed", () => {
		render(withStats({ hadPriorTranscripts: true, truncated: {} }));

		expect(
			screen.queryByText(/how this agenda was built/i),
		).not.toBeInTheDocument();
	});
});
