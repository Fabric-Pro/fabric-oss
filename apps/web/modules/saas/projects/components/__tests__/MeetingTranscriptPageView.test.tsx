/**
 * Component tests for `MeetingTranscriptPageView`.
 *
 * The reader is a server component (no `"use client"`, no hooks) fed a
 * pre-fetched plain-JSON view model. It renders fine in jsdom because it only
 * pulls in `next/link`, lucide icons, `ReactMarkdown` + `remark-gfm`, and the
 * Shadcn `Alert`.
 *
 * Covered surfaces:
 *   - Renders the full markdown body (long content) inside the scrollable prose
 *     column; read-only — no edit / annotate / comment / re-sync controls.
 *   - Renders the summarized banner ONLY when `wasSummarized` is true, and the
 *     summary body still renders in that case (AC3).
 *   - Renders metadata (subject, date, participants) and falls back gracefully
 *     when absent.
 *   - Empty `content` → inline "unavailable" notice (not blank).
 *   - Accessibility: serif page `h1` present; banner conveys meaning in TEXT
 *     (not icon-only); back link is keyboard-activatable.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
	type MeetingTranscriptViewData,
	MeetingTranscriptPageView,
} from "../MeetingTranscriptPageView";

// `next/link` works in jsdom, but mock it to a plain anchor so href assertions
// are stable regardless of Next's runtime wrapping. (`vi.mock` is hoisted by
// Vitest above the imports above.)
vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		...rest
	}: {
		children: React.ReactNode;
		href: string;
	} & Record<string, unknown>) => (
		<a href={href} {...rest}>
			{children}
		</a>
	),
}));

function makeTranscript(
	overrides: Partial<MeetingTranscriptViewData> = {},
): MeetingTranscriptViewData {
	return {
		id: "transcript-1",
		projectId: "project-1",
		projectName: "Apollo",
		meetingSubject: "Sprint planning",
		meetingDate: "2026-06-10T15:00:00.000Z",
		speakerNames: ["Alice", "Bob"],
		wasSummarized: false,
		content: "# Sprint planning\n\nAlice: Hello everyone\nBob: Hi Alice",
		syncedAt: "2026-06-10T16:30:00.000Z",
		...overrides,
	};
}

const backHref = "/app/projects/project-1?tab=context";

describe("MeetingTranscriptPageView — heading + metadata", () => {
	it("renders a serif page h1 showing the meeting subject", () => {
		render(
			<MeetingTranscriptPageView
				transcript={makeTranscript()}
				backHref={backHref}
			/>,
		);

		// The default fixture's markdown body also starts with a `# Sprint
		// planning` heading, so ReactMarkdown renders a SECOND level-1 heading
		// inside the prose article. The hero h1 is the one the route renders
		// from the metadata — it carries the editorial serif treatment and the
		// `aria-describedby` link to the eyebrow label (the markdown h1 has
		// neither). Select the hero h1 specifically.
		const heroHeading = screen
			.getAllByRole("heading", { level: 1, name: "Sprint planning" })
			.find(
				(h) =>
					h.getAttribute("aria-describedby") ===
					"meeting-transcript-eyebrow",
			);
		expect(heroHeading).toBeDefined();
		// Hero title uses the editorial serif treatment (CLAUDE.md / D7).
		expect(heroHeading?.className).toMatch(/font-serif/);
	});

	it("falls back to 'Meeting transcript' when the subject is null", () => {
		render(
			<MeetingTranscriptPageView
				transcript={makeTranscript({ meetingSubject: null })}
				backHref={backHref}
			/>,
		);

		expect(
			screen.getByRole("heading", {
				level: 1,
				name: "Meeting transcript",
			}),
		).toBeInTheDocument();
	});

	it("renders the metadata line with the meeting date and participant count + names", () => {
		render(
			<MeetingTranscriptPageView
				transcript={makeTranscript()}
				backHref={backHref}
			/>,
		);

		const metadata = screen.getByTestId("meeting-transcript-metadata");
		expect(metadata).toHaveTextContent("2 participants");
		// Participant names render below the metadata line.
		expect(screen.getByText("Alice, Bob")).toBeInTheDocument();
	});

	it("gracefully shows 'Date unavailable' when there is no meeting date", () => {
		render(
			<MeetingTranscriptPageView
				transcript={makeTranscript({ meetingDate: null })}
				backHref={backHref}
			/>,
		);

		expect(
			within(screen.getByTestId("meeting-transcript-metadata")).getByText(
				"Date unavailable",
			),
		).toBeInTheDocument();
	});

	it("singularizes the participant label for a single speaker and omits it for none", () => {
		const { rerender } = render(
			<MeetingTranscriptPageView
				transcript={makeTranscript({ speakerNames: ["Solo"] })}
				backHref={backHref}
			/>,
		);
		expect(
			screen.getByTestId("meeting-transcript-metadata"),
		).toHaveTextContent("1 participant");

		rerender(
			<MeetingTranscriptPageView
				transcript={makeTranscript({ speakerNames: [] })}
				backHref={backHref}
			/>,
		);
		expect(
			screen.getByTestId("meeting-transcript-metadata"),
		).not.toHaveTextContent("participant");
	});
});

describe("MeetingTranscriptPageView — body", () => {
	it("renders the markdown body (long content) in the prose column", () => {
		const longContent = `# Long meeting\n\n${"Alice: ".concat(
			"word ".repeat(5000),
		)}`;

		render(
			<MeetingTranscriptPageView
				transcript={makeTranscript({ content: longContent })}
				backHref={backHref}
			/>,
		);

		const markdown = screen.getByTestId("meeting-transcript-markdown");
		// ReactMarkdown rendered the heading and the long body text.
		expect(
			within(markdown).getByRole("heading", { name: "Long meeting" }),
		).toBeInTheDocument();
		expect(markdown.textContent?.length ?? 0).toBeGreaterThan(3000);
		// The empty-body notice must NOT be shown when there is content.
		expect(
			screen.queryByTestId("meeting-transcript-empty"),
		).not.toBeInTheDocument();
	});

	it("shows the inline 'unavailable' notice (not a blank page) when content is empty", () => {
		render(
			<MeetingTranscriptPageView
				transcript={makeTranscript({ content: "" })}
				backHref={backHref}
			/>,
		);

		const empty = screen.getByTestId("meeting-transcript-empty");
		expect(empty).toHaveTextContent("Transcript content is unavailable.");
		expect(
			screen.queryByTestId("meeting-transcript-markdown"),
		).not.toBeInTheDocument();
	});

	it("treats whitespace-only content as empty", () => {
		render(
			<MeetingTranscriptPageView
				transcript={makeTranscript({ content: "   \n  \t" })}
				backHref={backHref}
			/>,
		);

		expect(
			screen.getByTestId("meeting-transcript-empty"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("meeting-transcript-markdown"),
		).not.toBeInTheDocument();
	});
});

describe("MeetingTranscriptPageView — summarized banner (AC3)", () => {
	it("renders the summarized banner with text-conveyed meaning when wasSummarized is true", () => {
		render(
			<MeetingTranscriptPageView
				transcript={makeTranscript({
					wasSummarized: true,
					content: "An AI summary of the meeting.",
				})}
				backHref={backHref}
			/>,
		);

		const banner = screen.getByTestId(
			"meeting-transcript-summarized-banner",
		);
		// Meaning is in TEXT, not icon-only.
		expect(banner).toHaveTextContent(
			"Summarized — not the full transcript",
		);
		expect(banner).toHaveTextContent(/AI summary/i);
		// The summary body still renders below the banner.
		expect(
			screen.getByTestId("meeting-transcript-markdown"),
		).toHaveTextContent("An AI summary of the meeting.");
	});

	it("does NOT render the summarized banner when wasSummarized is false", () => {
		render(
			<MeetingTranscriptPageView
				transcript={makeTranscript({ wasSummarized: false })}
				backHref={backHref}
			/>,
		);

		expect(
			screen.queryByTestId("meeting-transcript-summarized-banner"),
		).not.toBeInTheDocument();
	});
});

describe("MeetingTranscriptPageView — read-only + accessibility", () => {
	it("renders no edit / annotate / comment / re-sync controls (read-only)", () => {
		render(
			<MeetingTranscriptPageView
				transcript={makeTranscript()}
				backHref={backHref}
			/>,
		);

		// The reader is purely presentational. The only interactive elements are
		// navigation links (back arrow, breadcrumb, skip link) — there are no
		// buttons and no editing affordances.
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		for (const label of [
			/edit/i,
			/annotate/i,
			/comment/i,
			/re-?sync/i,
			/delete/i,
		]) {
			expect(screen.queryByRole("button", { name: label })).toBeNull();
		}
		// Read-only confirmation: no textbox / form fields either.
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("exposes a keyboard-activatable back link to backHref", () => {
		render(
			<MeetingTranscriptPageView
				transcript={makeTranscript()}
				backHref={backHref}
			/>,
		);

		const back = screen.getByRole("link", {
			name: "Back to project contexts",
		});
		expect(back).toHaveAttribute("href", backHref);
	});

	it("renders the editorial uppercase 'Meeting Transcript' eyebrow label", () => {
		render(
			<MeetingTranscriptPageView
				transcript={makeTranscript()}
				backHref={backHref}
			/>,
		);

		const eyebrow = document.getElementById("meeting-transcript-eyebrow");
		expect(eyebrow).not.toBeNull();
		expect(eyebrow).toHaveTextContent("Meeting Transcript");
		expect(eyebrow?.className).toMatch(/uppercase/);
		expect(eyebrow?.className).toMatch(/tracking-\[0\.2em\]/);
	});
});
