import type { ApiRouterClient } from "@repo/api/orpc/router";

/** Only http(s) URLs are safe to render as a navigable href — a stored
 * `javascript:`/`data:` URL would otherwise be a stored-XSS vector when
 * another project member clicks the link. Saving stays lenient (DV6);
 * this only gates NAVIGATION. */
export function isSafeHttpUrl(value: string): boolean {
	try {
		const u = new URL(value);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

/** The five `PublishingTopicStatus` values, in triage order, with UI labels.
 *  Snooze is deliberately absent: it is an overlay (`isSnoozed`), not a status,
 *  so it filters separately below. */
export type TopicStatus =
	| "SUGGESTION"
	| "SELECTED"
	| "IN_PROGRESS"
	| "PUBLISHED"
	| "DECLINED";

export const TOPIC_STATUSES: ReadonlyArray<{
	value: TopicStatus;
	label: string;
}> = [
	{ value: "SUGGESTION", label: "Suggestion" },
	{ value: "SELECTED", label: "Selected" },
	{ value: "IN_PROGRESS", label: "In progress" },
	{ value: "PUBLISHED", label: "Published" },
	{ value: "DECLINED", label: "Declined" },
];

// Inferred from the oRPC list-topics output (Task 2) — never `any`. Type-only,
// so it is erased at build time and adds no runtime coupling to the API package.
export type PublishingTopic = Awaited<
	ReturnType<ApiRouterClient["projects"]["publishingSuite"]["listTopics"]>
>["items"][number];

// The `PublishingTopicPostType` union, sourced from the API type so a schema
// change surfaces here at compile time (and keeps the chip filter below
// cast-free).
export type PostType = PublishingTopic["suggestedPostTypes"][number];

// Inferred from the oRPC list-members output (`projects.members.list`) —
// never `any`. Type-only, so it is erased at build time and adds no runtime
// coupling to the API package. Shared by `ContributorsDialog` and `TopicRow`
// so the contributor picker's row shape has one source of truth rather than
// a hand-typed copy in each.
export type ProjectMember = Awaited<
	ReturnType<ApiRouterClient["projects"]["members"]["list"]>
>["members"][number];

// A topic's resolved contributor handle — one entry of `PublishingTopic`'s own
// `contributors` field, which is already the topic's CURRENT EFFECTIVE set
// (`effectiveContributorUserIds`), not the raw AI-resolved list. Reused by
// `ContributorsDialog` to render a contributor who is not (or no longer) a
// project member as its own labelled row, since that picker's `members` list
// alone has no name/avatar for them.
export type TopicContributor = PublishingTopic["contributors"][number];

// A topic's resolved ASSIGNEE handle (A8) — one entry of `PublishingTopic`'s
// `assignees` field. Same shape as `TopicContributor` today, and deliberately
// its own alias rather than a reuse: the two answer different questions (whose
// work this came from vs. who should pick it up) and only one of them is
// membership-constrained, so a future divergence must not have to un-merge
// them first.
export type TopicAssignee = PublishingTopic["assignees"][number];

// 1B: the `PublishingTopicPostType` values, in fixed display order, with UI
// labels — an AI topic's suggested-post-type chip row renders in this order
// regardless of the array order the API returns.
//
// 2B-1 adds `generationLabel`: the Inbox chip wants the short name ("Tweet")
// because it sits in a dense row, while the generation tab uses the card's own
// name for the content type ("Short Post / Tweet"). TWO FIELDS ON ONE LIST, not
// two lists — a second hand-maintained list is exactly the drift the placeholder
// this replaces warned about. `generationLabel` is omitted where the two agree.
//
// LinkedIn sits second rather than last, matching the display order in
// `@repo/database`'s `PUBLISHING_POST_TYPE_OPTIONS`: it and Tweet are the
// short-form social pair, and the Prisma enum's own trailing position is an
// artefact of `ALTER TYPE ... ADD VALUE` rather than a statement about reading
// order.
export const POST_TYPE_LABELS: ReadonlyArray<{
	value: PostType;
	label: string;
	generationLabel?: string;
}> = [
	{ value: "TWEET", label: "Tweet", generationLabel: "Short Post / Tweet" },
	{ value: "LINKEDIN_POST", label: "LinkedIn Post" },
	{ value: "BLOG_POST", label: "Blog Post" },
	{ value: "CASE_STUDY", label: "Case Study" },
	{ value: "STAKEHOLDER_EMAIL", label: "Stakeholder Email" },
	{ value: "WEBINAR_SCRIPT", label: "Webinar / Demo Script" },
];

/**
 * Every content type, in strip order.
 *
 * Row 2 of the Topic Item Page narrows to the topic's own selection; this is
 * what it falls back to when there is no selection to narrow to, which #1853
 * FR1/FR2 require — the generation tabs are activated, not conditional.
 *
 * Derived from `POST_TYPE_LABELS` rather than written out again, for the reason
 * the comment above gives: a second hand-maintained list is exactly the drift
 * this module already decided not to carry.
 */
export const ALL_POST_TYPES: readonly PostType[] = POST_TYPE_LABELS.map(
	(t) => t.value,
);

/**
 * The content types with a generation panel of their own.
 *
 * Phase 2B activated Tweet and Blog Post; 2C-1 added Case Study, 2C-2
 * Stakeholder Email, #1851 LinkedIn Post, and #1988 Webinar / Demo Script
 * (Phase 2D-1).
 *
 * The set stays rather than collapsing into "all of them", and the rule it
 * enforces is a PAIRING rather than a delay: membership here is what makes a
 * tab selectable AND what makes `GenerationTabs` mount a `TabsContent` for it,
 * so an entry added here without a matching arm in `GenerationPanel`'s
 * `postType === …` chain renders a selectable tab whose body carries nothing
 * type-specific. Deriving this from `POST_TYPE_LABELS` would do exactly that,
 * automatically, the moment the Prisma enum grew — which is why it is written
 * out by hand.
 *
 * So a new post type must arrive with its panel, and the two land in one
 * change. A type that genuinely has no panel yet is better left OUT of this
 * set, where it renders disabled and "Coming soon": an honest placeholder beats
 * a live tab that silently lacks its panel.
 *
 * `LINKEDIN_POST` is the first value to test that. It arrived WITH
 * `LinkedInPostPanel` and its arm in the chain, in one change — and the two
 * cases that pin this (`publishing-generation-tabs.test.tsx` "leaves NO tab
 * reading Coming Soon at all" and `publishing-topic-item-page.test.tsx` "leaves
 * NO generation tab disabled or Coming Soon") went green without an assertion
 * moving. Note what those cases do NOT catch: they read the tab strip only, so
 * adding an entry here without the panel arm would satisfy both while the tab
 * body carried nothing type-specific.
 *
 * Task 12 (`WEBINAR_SCRIPT`, #1988) closed that gap:
 * `publishing-generation-tabs.test.tsx`'s "gives every active post type a
 * matching arm in GenerationPanel's postType chain" reads `GenerationTabs.tsx`'s
 * own source and asserts every member of this set names a `postType === "…"`
 * arm. A mounted-DOM assertion could not stand in for it — `GenerationPanel`
 * renders its "Recommendation" section regardless of which arm fires, so an
 * empty-body check stays green with or without one — which is why the pairing
 * is now checked against the source rather than the render.
 */
export const GENERATION_ACTIVE_POST_TYPES: ReadonlySet<PostType> =
	new Set<PostType>([
		"TWEET",
		"LINKEDIN_POST",
		"BLOG_POST",
		"CASE_STUDY",
		"STAKEHOLDER_EMAIL",
		"WEBINAR_SCRIPT",
	]);

export type WhySuggested = NonNullable<PublishingTopic["whySuggested"]>;

// Compose the muted "why suggested" line (format C). Returns the full string
// including the "Based on " prefix. Segments join with " · ".
//
// A source carrying a `date` — meetings, and only when the transcript has one —
// gets it in PARENTHESES rather than after another " · ": the separator already
// means "and here is a different source", so `"Weekly sync" meeting · Sept 9`
// would read as two of them. Parentheses bind the date to the meeting it
// qualifies, which is the whole point of showing it — a recurring series puts
// the same subject on the line twice, and the date is what tells the two apart.
export function formatWhySuggested(w: WhySuggested): string {
	const segments: string[] = [];
	for (const s of w.named) {
		const base =
			s.type === "meeting"
				? s.label
					? `"${s.label}" meeting`
					: "Meeting"
				: `"${s.label}"`;
		segments.push(s.date ? `${base} (${s.date})` : base);
	}
	if (w.prCount > 0) {
		segments.push(`${w.prCount} ${w.prCount === 1 ? "PR" : "PRs"}`);
	}
	if (w.overflowCount > 0) {
		segments.push(`+${w.overflowCount} more`);
	}
	return `Based on ${segments.join(" · ")}`;
}

export type MeetingSpeakers = NonNullable<PublishingTopic["meetingSpeakers"]>;

/**
 * How many participant tokens the line shows before offering to unfold.
 *
 * Deliberately the same number as the server's Inbox cap
 * (`MEETING_PARTICIPANTS_CAP`) and deliberately a SEPARATE constant: the server
 * one decides what is in the payload, this one decides what is on screen. They
 * agree so that a topic page collapsed reads exactly like its Inbox row, and
 * they are distinct so that raising the payload cap — which is what makes the
 * page expandable at all — cannot silently lengthen the line.
 */
const MEETING_PARTICIPANTS_VISIBLE = 3;

/** Visible token for one matched member: @username, else name. */
function participantToken(p: MeetingSpeakers["members"][number]): string {
	return p.username ? `@${p.username}` : (p.name ?? "");
}

/**
 * The participants line, split into what is on screen and what is behind a
 * disclosure.
 *
 * Two different "more"s, and conflating them is the bug this shape exists to
 * prevent. `hiddenCount` is names the payload HAS and the collapsed line is
 * withholding — a reader can unfold those. `overflowCount` is names the server
 * capped out of the payload entirely; nothing on the client can reveal them, so
 * they stay a plain count no matter what is expanded.
 *
 * The Inbox pays nothing for this: its payload is capped at three, so
 * `hiddenCount` is always 0 there, no disclosure renders, and the line is the
 * same string it has always been.
 */
export type MeetingParticipantsLine = {
	/** Tokens shown while collapsed. */
	visible: string[];
	/** Every token in the payload, shown when expanded. */
	all: string[];
	/** In the payload but withheld while collapsed — unfoldable. */
	hiddenCount: number;
	/** Capped out of the payload by the server — never unfoldable. */
	overflowCount: number;
};

export function buildMeetingParticipantsLine(
	m: MeetingSpeakers,
): MeetingParticipantsLine {
	const all = m.members.map(participantToken).filter((token) => token !== "");
	return {
		visible: all.slice(0, MEETING_PARTICIPANTS_VISIBLE),
		all,
		hiddenCount: Math.max(0, all.length - MEETING_PARTICIPANTS_VISIBLE),
		overflowCount: m.overflowCount,
	};
}

// Compose the muted "Meeting participants —" line. Visible token per member:
// @username, else name. Join ", "; append "+N more" for overflow. The label is
// intentionally soft (heuristic name match, not verified identity — spec D9/§8.1).
//
// This is the STATIC form, for the case with nothing to unfold — every Inbox
// row, and a topic whose participants all fit. It is left composing one string
// rather than being folded into the expandable renderer so that path stays
// byte-for-byte what it renders today.
export function formatMeetingParticipants(m: MeetingSpeakers): string {
	const shown = m.members
		.map(participantToken)
		.filter((token) => token !== "")
		.join(", ");
	const overflow = m.overflowCount > 0 ? ` +${m.overflowCount} more` : "";
	return `Meeting participants — ${shown}${overflow}`;
}
