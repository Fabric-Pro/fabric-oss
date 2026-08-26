import { describe, expect, it } from "vitest";
import {
	buildAgendaLockedClauses,
	composeAgendaPrompt,
	MEETING_AGENDA_PROMPT_FALLBACK_BODY,
} from "../build-agenda-prompt";
import type { AgendaContext } from "../collect-agenda-context";

const EMPTY: AgendaContext = {
	priorMeetings: [],
	hadPriorTranscripts: false,
	carriedActionItems: [],
	openActionItems: [],
	openDecisions: [],
	blockedStories: [],
	truncated: {
		actionItems: false,
		decisions: false,
		blockedStories: false,
		carriedActionItems: false,
	},
};

const FULL: AgendaContext = {
	...EMPTY,
	hadPriorTranscripts: true,
	priorMeetings: [
		{
			meetingSubject: "Fabric DSU",
			meetingDate: new Date("2026-07-22T09:00:00Z"),
			summary: "Rollout discussed.",
			decisions: ["Ship behind a flag"],
			openQuestions: ["Who owns the migration?"],
		},
	],
	carriedActionItems: [
		{
			text: "Chase the vendor SLA",
			tentativeOwnerName: "the platform lead",
			dueHint: "Monday",
			fromMeetingSubject: "Fabric DSU",
			fromMeetingDate: new Date("2026-07-15T09:00:00Z"),
		},
	],
	openActionItems: [
		{
			text: "Draft the migration",
			tentativeOwnerName: "the reporter",
			dueHint: "Friday",
		},
	],
	openDecisions: [
		{
			storyIdentifier: "US-114",
			storyTitle: "Auth provider",
			question: "Which provider?",
		},
	],
	blockedStories: [
		{
			identifier: "US-120",
			title: "Infra spike",
			blockedReason: "Waiting on infra",
		},
	],
};

const compose = async (context: AgendaContext, meetingSubject: string | null) =>
	(
		await composeAgendaPrompt({
			templateBody: MEETING_AGENDA_PROMPT_FALLBACK_BODY,
			format: "HANDLEBARS",
			meetingSubject,
			occurrenceStart: new Date("2026-07-25T09:00:00Z"),
			context,
		})
	).prompt;

/**
 * Every line the pre-#2178 `buildAgendaPrompt` emitted for a fully-populated
 * context. Rendering the default template must still produce all of them.
 *
 * Compared after whitespace normalisation, and without asserting ORDER: the
 * two locked clauses deliberately move from the middle of the rules list to
 * the tail, because they are now appended code-side. Content identical,
 * position changed — that move is asserted explicitly below.
 */
const EXPECTED_LINES_FULL = [
	"You are preparing an agenda for an upcoming team meeting in Fabric.",
	"Meeting: Fabric DSU",
	"Scheduled: 2026-07-25",
	"Prior meetings in this series (most recent first):",
	"- 2026-07-22: Rollout discussed.",
	"- Decided: Ship behind a flag",
	"- Left open: Who owns the migration?",
	"Carried forward — open action items raised in earlier meetings of THIS series:",
	'- Chase the vendor SLA (owner: the platform lead) (due: Monday) (raised: 2026-07-15 "Fabric DSU")',
	"Open action items:",
	"- Draft the migration (owner: the reporter) (due: Friday)",
	"Unresolved questions on work items:",
	"- US-114 (Auth provider): Which provider?",
	"Blocked work:",
	"- US-120 (Infra spike): Waiting on infra",
	"Produce a focused agenda of 3-7 items, ordered by what most needs the",
	"team's attention. Rules:",
	"- Prefer items that need a decision or unblock someone over status recital.",
	"- Keep titles under 10 words.",
	"- Use sourceRefs to name what each item came from.",
	"- Only set suggestedMinutes when the context implies a sensible length.",
	"- Every item must trace to the context above. Invent nothing.",
	'- An item drawn from "Carried forward" is old business: set',
	"carriedForward=true and intent=carry_over. Everything else is a new",
	"item: set carriedForward=false. Never move an item between the two",
	"groups — that classification is already decided.",
];

/** Collapse indentation and blank runs so Handlebars block whitespace is not
 *  what this test is about. */
const normalize = (text: string) =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

describe("agenda prompt equivalence with the pre-#2178 hard-coded prompt", () => {
	it("emits every line the old builder emitted for a full context", async () => {
		const lines = normalize(await compose(FULL, "Fabric DSU"));
		for (const expected of EXPECTED_LINES_FULL) {
			expect(lines).toContain(expected);
		}
	});

	it("keeps the no-history wording, not a claim that none exist", async () => {
		const prompt = await compose(EMPTY, "Fabric DSU");
		expect(prompt).toContain("No recent meeting transcripts");
		expect(prompt).not.toContain("Prior meetings in this series");
	});

	it("still omits absent sections entirely", async () => {
		const prompt = await compose(EMPTY, null);
		expect(prompt).not.toContain("Open action items:");
		expect(prompt).not.toContain("Blocked work:");
		expect(prompt).not.toContain("Carried forward");
		expect(prompt).not.toContain("Unresolved questions");
		expect(prompt).toContain("Meeting: Untitled meeting");
	});

	it("places the locked clauses at the tail, after the editable body", async () => {
		const prompt = await compose(FULL, "Fabric DSU");
		expect(prompt.trimEnd()).toMatch(
			/that classification is already decided\.$/,
		);
		expect(prompt.indexOf("Keep titles under 10 words")).toBeLessThan(
			prompt.indexOf("Invent nothing"),
		);
	});

	it("omits the classification clause when nothing carried over", () => {
		const clauses = buildAgendaLockedClauses(EMPTY);
		expect(clauses).toContain("Invent nothing");
		// Naming a group that was never rendered invites the model to invent
		// old business — the same reason empty sections are omitted.
		expect(clauses).not.toContain("carriedForward=true");
	});

	it("does not HTML-escape a subject containing an ampersand or quotes", async () => {
		const prompt = await compose(FULL, 'Q3 "Roadmap" & Budget');
		expect(prompt).toContain('Meeting: Q3 "Roadmap" & Budget');
		expect(prompt).not.toContain("&amp;");
	});
});
