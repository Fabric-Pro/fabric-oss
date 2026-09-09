/**
 * The two muted provenance lines under a topic: "Based on …" and
 * "Meeting participants — …".
 *
 * Both were reported as ambiguous in a UI review of the Publishing Suite.
 *
 *  - "Based on …" can name the SAME meeting twice, correctly: a recurring
 *    series produces one transcript per occurrence and they share a
 *    `meetingSubject`. Provenance dedupes by transcript id, which is right, so
 *    the fix belongs to the label — each cited meeting now carries a short
 *    date, and the year appears only when it is not the current one.
 *
 *  - "Meeting participants — A, B, C +2 more" was a dead end: the names past
 *    the third were capped out SERVER-side, so nothing on the page could show
 *    them. The single-topic read now carries more of them
 *    (`MEETING_PARTICIPANTS_DETAIL_CAP`) and the line unfolds.
 *
 * `TopicDetails` is the one definition behind both mounts — the Inbox row and
 * the Topic Item Page — so it is what these render, directly. Which mount gets
 * the disclosure is decided by the PAYLOAD (an Inbox row is capped at three, so
 * it has nothing withheld), and the last group below pins exactly that.
 */

import { TopicDetails } from "@saas/projects/components/publishing-suite/TopicDetails";
import {
	formatWhySuggested,
	type PublishingTopic,
	type WhySuggested,
} from "@saas/projects/components/publishing-suite/topic-shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

function makeTopic(overrides: Record<string, unknown> = {}) {
	return {
		id: "t1",
		title: "Alpha topic",
		pitch: "Alpha pitch",
		angle: null,
		status: "SUGGESTION",
		origin: "AI",
		declineReason: null,
		publishedUrl: null,
		createdById: null,
		createdAt: new Date("2026-08-01T00:00:00Z"),
		updatedAt: new Date("2026-08-01T00:00:00Z"),
		snoozedUntil: null,
		snoozeReason: null,
		isSnoozed: false,
		isRead: false,
		contributors: [],
		suggestedPostTypes: [],
		postTypeRecommendations: [],
		rankReason: null,
		authorRecommendation: null,
		subject: null,
		userPostTypes: null,
		userContributorUserIds: null,
		assigneeUserIds: [] as string[],
		assignees: [] as Array<{
			id: string;
			name: string;
			image: string | null;
			username: string | null;
		}>,
		whySuggested: null,
		meetingSpeakers: null,
		...overrides,
	};
}

function renderDetails(overrides: Record<string, unknown> = {}) {
	return render(
		<TopicDetails
			topic={makeTopic(overrides) as unknown as PublishingTopic}
			canEdit={false}
			isPending={false}
			onEditUrl={() => {}}
			onEditPostTypes={() => {}}
			onEditContributors={() => {}}
			onEditAssignees={() => {}}
		/>,
	);
}

/** Build one `whySuggested` payload without repeating the counters. */
function why(named: WhySuggested["named"]): WhySuggested {
	return { named, prCount: 0, overflowCount: 0 };
}

/** Build one `meetingSpeakers` payload from usernames. */
function speakers(usernames: string[], overflowCount = 0) {
	return {
		members: usernames.map((u) => ({
			id: u,
			name: `${u} person`,
			username: u,
		})),
		overflowCount,
	};
}

/**
 * The participants `<p>`, whatever it is built from.
 *
 * The expanded line is several text nodes — the names sit in their own `<span>`
 * so `aria-controls` can point at exactly what unfolds, and the server's
 * `overflowCount` sits outside it because no click reveals those names. A
 * `getByText` regex matches ONE node, so it would pass on the collapsed form
 * and fail on the expanded one for a reason that is not about the text.
 */
function participantsLine(): HTMLElement {
	return screen.getByText(
		(_content, el) =>
			el?.tagName === "P" &&
			(el.textContent ?? "").startsWith("Meeting participants —"),
	);
}

/**
 * The whole line, whitespace-normalized, for an EXACT comparison.
 *
 * `toHaveTextContent` with a string is a substring match, which would let every
 * collapsed assertion below pass against the expanded line — the one thing
 * these cases exist to tell apart. The trigger's own label is part of the
 * string on purpose: whether it reads "Show 2 more" or "Show fewer" is the
 * other half of the state being asserted.
 */
function participantsText(): string {
	return (participantsLine().textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("formatWhySuggested — meeting dates", () => {
	it("appends the date in parentheses, bound to the meeting it qualifies", () => {
		// NOT after another " · ": that separator already means "a different
		// source", so a date behind one reads as a second citation.
		expect(
			formatWhySuggested(
				why([
					{ type: "meeting", label: "Weekly sync", date: "Sept 9" },
				]),
			),
		).toBe('Based on "Weekly sync" meeting (Sept 9)');
	});

	it("separates two occurrences of ONE recurring series", () => {
		// The reported bug. Both entries are real and distinct — two transcripts
		// under one subject — and before the date they rendered identically.
		expect(
			formatWhySuggested(
				why([
					{ type: "meeting", label: "Weekly sync", date: "Sept 9" },
					{ type: "meeting", label: "Weekly sync", date: "Sept 2" },
				]),
			),
		).toBe(
			'Based on "Weekly sync" meeting (Sept 9) · "Weekly sync" meeting (Sept 2)',
		);
	});

	it("leaves a dateless meeting as a bare citation, not an empty paren", () => {
		// `ProjectMeetingTranscript.meetingDate` is nullable.
		expect(
			formatWhySuggested(
				why([{ type: "meeting", label: "Weekly sync" }]),
			),
		).toBe('Based on "Weekly sync" meeting');
	});

	it("keeps the subject-less meeting reading as bare 'Meeting' plus its date", () => {
		expect(
			formatWhySuggested(
				why([{ type: "meeting", label: "", date: "Sept 9" }]),
			),
		).toBe("Based on Meeting (Sept 9)");
	});

	it("leaves stories and documents untouched", () => {
		expect(
			formatWhySuggested(
				why([
					{ type: "story", label: "Checkout rewrite" },
					{ type: "document", label: "Launch plan" },
				]),
			),
		).toBe('Based on "Checkout rewrite" · "Launch plan"');
	});

	it("keeps the 3-source cap and the '+N more' overflow the server applies", () => {
		// Both counters are computed server-side against the UNCAPPED list, so
		// the date must not disturb either.
		expect(
			formatWhySuggested({
				named: [
					{ type: "meeting", label: "Weekly sync", date: "Sept 9" },
					{ type: "meeting", label: "Weekly sync", date: "Sept 2" },
					{ type: "story", label: "Checkout rewrite" },
				],
				prCount: 2,
				overflowCount: 4,
			}),
		).toBe(
			'Based on "Weekly sync" meeting (Sept 9) · "Weekly sync" meeting (Sept 2) · "Checkout rewrite" · 2 PRs · +4 more',
		);
	});

	it("renders the dated line on the topic's details", () => {
		renderDetails({
			whySuggested: why([
				{ type: "meeting", label: "Weekly sync", date: "Sept 9" },
			]),
		});

		expect(
			screen.getByText('Based on "Weekly sync" meeting (Sept 9)'),
		).toBeInTheDocument();
	});
});

describe("Meeting participants — expanding the overflow", () => {
	it("shows three names and offers the rest when the payload carries them", async () => {
		const user = userEvent.setup();
		renderDetails({
			meetingSpeakers: speakers(["ada", "bob", "cy", "dee", "eve"]),
		});

		expect(participantsText()).toBe(
			"Meeting participants — @ada, @bob, @cy Show 2 more",
		);

		const toggle = screen.getByRole("button", { name: "Show 2 more" });
		expect(toggle).toHaveAttribute("aria-expanded", "false");

		await user.click(toggle);

		expect(participantsText()).toBe(
			"Meeting participants — @ada, @bob, @cy, @dee, @eve Show fewer",
		);
		expect(
			screen.getByRole("button", { name: "Show fewer" }),
		).toHaveAttribute("aria-expanded", "true");
	});

	it("collapses again, so the disclosure is a toggle rather than a one-way door", async () => {
		const user = userEvent.setup();
		renderDetails({
			meetingSpeakers: speakers(["ada", "bob", "cy", "dee"]),
		});

		await user.click(screen.getByRole("button", { name: "Show 1 more" }));
		await user.click(screen.getByRole("button", { name: "Show fewer" }));

		expect(participantsText()).toBe(
			"Meeting participants — @ada, @bob, @cy Show 1 more",
		);
	});

	it("names the region it controls, so the disclosure is reachable by keyboard and by name", () => {
		renderDetails({
			meetingSpeakers: speakers(["ada", "bob", "cy", "dee"]),
		});

		const toggle = screen.getByRole("button", { name: "Show 1 more" });
		// The accessible name IS the visible text — WCAG 2.5.3 (Label in Name)
		// is why there is no fuller `aria-label` that would fail to contain it.
		expect(toggle).toHaveTextContent("Show 1 more");
		expect(toggle.getAttribute("aria-controls")).toBeTruthy();
		expect(
			document.getElementById(
				toggle.getAttribute("aria-controls") as string,
			),
		).toHaveTextContent("@ada, @bob, @cy");
	});

	it("keeps the server's own overflow as a plain count in BOTH states", async () => {
		// Two different "more"s. `overflowCount` is names the server capped out
		// of the payload entirely — no click can reveal them — so it must not
		// be folded into the expandable count or silently dropped on expand.
		const user = userEvent.setup();
		renderDetails({
			meetingSpeakers: speakers(["ada", "bob", "cy", "dee"], 7),
		});

		expect(participantsText()).toBe(
			"Meeting participants — @ada, @bob, @cy +7 more Show 1 more",
		);

		await user.click(screen.getByRole("button", { name: "Show 1 more" }));

		expect(participantsText()).toBe(
			"Meeting participants — @ada, @bob, @cy, @dee +7 more Show fewer",
		);
	});

	it("falls back to the display name for a member with no username", async () => {
		const user = userEvent.setup();
		renderDetails({
			meetingSpeakers: {
				members: [
					{ id: "u1", name: "Ada Example", username: null },
					{ id: "u2", name: "Bob Example", username: "bob" },
					{ id: "u3", name: "Cy Example", username: "cy" },
					{ id: "u4", name: "Dee Example", username: null },
				],
				overflowCount: 0,
			},
		});

		await user.click(screen.getByRole("button", { name: "Show 1 more" }));

		expect(participantsText()).toBe(
			"Meeting participants — Ada Example, @bob, @cy, Dee Example Show fewer",
		);
	});
});

describe("Meeting participants — the Inbox line is unchanged", () => {
	/**
	 * The list read still caps at three server-side, so an Inbox row's payload
	 * has nothing withheld and must render exactly the static line it always
	 * has. This is the half that the `publishing-suite-row-parity` snapshot
	 * also covers; asserted here too, because that snapshot would report the
	 * regression as "a snapshot moved" rather than as what it is.
	 */
	it("renders no disclosure when the payload holds nothing back", () => {
		renderDetails({
			meetingSpeakers: speakers(["ada", "bob", "cy"], 2),
		});

		expect(
			screen.getByText("Meeting participants — @ada, @bob, @cy +2 more"),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
	});

	it("keeps the aria-label naming every member the collapsed line stands for", () => {
		renderDetails({
			meetingSpeakers: speakers(["ada", "bob"], 3),
		});

		expect(
			screen.getByLabelText(
				"Meeting participants: ada person, bob person, and 3 more",
			),
		).toBeInTheDocument();
	});

	it("renders nothing at all when no member matched", () => {
		renderDetails({ meetingSpeakers: null });

		expect(screen.queryByText(/Meeting participants/)).toBeNull();
	});
});
