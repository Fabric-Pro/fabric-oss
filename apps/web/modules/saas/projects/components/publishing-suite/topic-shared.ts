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

// 1B: the four `PublishingTopicPostType` values, in fixed display order, with
// UI labels — an AI topic's suggested-post-type chip row renders in this
// order regardless of the array order the API returns.
export const POST_TYPE_LABELS: ReadonlyArray<{
	value: PostType;
	label: string;
}> = [
	{ value: "TWEET", label: "Tweet" },
	{ value: "BLOG_POST", label: "Blog Post" },
	{ value: "CASE_STUDY", label: "Case Study" },
	{ value: "STAKEHOLDER_EMAIL", label: "Stakeholder Email" },
];

export type WhySuggested = NonNullable<PublishingTopic["whySuggested"]>;

// Compose the muted "why suggested" line (format C). Returns the full string
// including the "Based on " prefix. Segments join with " · ".
export function formatWhySuggested(w: WhySuggested): string {
	const segments: string[] = [];
	for (const s of w.named) {
		segments.push(
			s.type === "meeting"
				? s.label
					? `"${s.label}" meeting`
					: "Meeting"
				: `"${s.label}"`,
		);
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

// Compose the muted "Meeting participants —" line. Visible token per member:
// @username, else name. Join ", "; append "+N more" for overflow. The label is
// intentionally soft (heuristic name match, not verified identity — spec D9/§8.1).
export function formatMeetingParticipants(m: MeetingSpeakers): string {
	const shown = m.members
		.map((p) => (p.username ? `@${p.username}` : (p.name ?? "")))
		.filter((token) => token !== "")
		.join(", ");
	const overflow = m.overflowCount > 0 ? ` +${m.overflowCount} more` : "";
	return `Meeting participants — ${shown}${overflow}`;
}
