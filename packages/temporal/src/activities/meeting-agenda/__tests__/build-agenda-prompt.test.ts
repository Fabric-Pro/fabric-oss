import { describe, expect, it } from "vitest";
import {
	AgendaSchema,
	buildAgendaVariables,
	composeAgendaPrompt,
	MEETING_AGENDA_PROMPT_FALLBACK_BODY,
	PRIOR_SUMMARY_CHAR_CAP,
	renderAgendaMarkdown,
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

describe("buildAgendaVariables", () => {
	it("flags no transcript history when there is none (FR5)", () => {
		const vars = buildAgendaVariables({
			meetingSubject: "Fabric DSU",
			occurrenceStart: new Date("2026-07-25T09:00:00Z"),
			context: EMPTY,
		});

		// The "no recent transcripts" wording itself lives in the template's
		// {{else}} branch; what this builder owns is the flag that selects it.
		expect(vars.has_prior_meetings).toBe(false);
		expect(vars.prior_meetings).toBe("");
		expect(vars.meeting_subject).toBe("Fabric DSU");
		expect(vars.meeting_date).toBe("2026-07-25");
	});

	it("populates every context block that has data", () => {
		const vars = buildAgendaVariables({
			meetingSubject: "Fabric DSU",
			occurrenceStart: new Date("2026-07-25T09:00:00Z"),
			context: {
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
			},
		});

		expect(vars.prior_meetings).toContain("Rollout discussed.");
		expect(vars.prior_meetings).toContain("- Decided: Ship behind a flag");
		expect(vars.prior_meetings).toContain(
			"- Left open: Who owns the migration?",
		);
		expect(vars.open_action_items).toContain("Draft the migration");
		expect(vars.open_decisions).toContain("US-114");
		expect(vars.blocked_stories).toContain("Waiting on infra");
	});

	it("leaves absent sections empty and unflagged, so nothing renders", () => {
		const vars = buildAgendaVariables({
			meetingSubject: null,
			occurrenceStart: new Date("2026-07-25T09:00:00Z"),
			context: EMPTY,
		});

		expect(vars.has_open_action_items).toBe(false);
		expect(vars.open_action_items).toBe("");
		expect(vars.has_blocked_stories).toBe(false);
		expect(vars.blocked_stories).toBe("");
		expect(vars.has_open_decisions).toBe(false);
		expect(vars.has_carried_items).toBe(false);
		expect(vars.meeting_subject).toBe("Untitled meeting");
	});

	it("caps a long prior-meeting summary", () => {
		const vars = buildAgendaVariables({
			meetingSubject: "Fabric DSU",
			occurrenceStart: new Date("2026-07-25T09:00:00Z"),
			context: {
				...EMPTY,
				hadPriorTranscripts: true,
				priorMeetings: [
					{
						meetingSubject: "Fabric DSU",
						meetingDate: new Date("2026-07-22T09:00:00Z"),
						summary: "x".repeat(PRIOR_SUMMARY_CHAR_CAP + 500),
						decisions: [],
						openQuestions: [],
					},
				],
			},
		});

		expect(vars.prior_meetings).toContain("…");
		expect(vars.prior_meetings.length).toBeLessThan(
			PRIOR_SUMMARY_CHAR_CAP + 200,
		);
	});
});

describe("AgendaSchema", () => {
	it("requires at least one item", () => {
		expect(AgendaSchema.safeParse({ items: [] }).success).toBe(false);
	});

	it("accepts a minimal item", () => {
		const parsed = AgendaSchema.safeParse({
			items: [{ title: "Carry-over actions", intent: "carry_over" }],
		});
		expect(parsed.success).toBe(true);
	});
});

describe("renderAgendaMarkdown", () => {
	it("numbers items and renders detail, timing, and sources", () => {
		const md = renderAgendaMarkdown({
			items: [
				{
					title: "Carry-over actions",
					intent: "carry_over",
					// Explicitly not carried (#2105 D6 — carriedForward overrides
					// the intent), so this stays a single ungrouped list and the
					// test keeps testing item rendering rather than the
					// old-business split, which has its own tests below.
					carriedForward: false,
					detail: "Three items still open.",
					suggestedMinutes: 10,
					sourceRefs: [
						{ kind: "action_item", label: "Draft the migration" },
					],
				},
				{ title: "Auth provider decision", intent: "decision" },
			],
			notes: "Keep it to 30 minutes.",
		});

		expect(md).toContain("## Agenda");
		expect(md).toContain("1. **Carry-over actions** _(10 min)_");
		expect(md).toContain("Three items still open.");
		expect(md).toContain("Draft the migration");
		expect(md).toContain("2. **Auth provider decision**");
		expect(md).toContain("Keep it to 30 minutes.");
	});

	it("omits the notes heading when there are no notes", () => {
		const md = renderAgendaMarkdown({
			items: [{ title: "Only item", intent: "discussion" }],
		});
		expect(md).not.toContain("## Notes");
	});
});

/**
 * Cross-meeting context aggregation (#2105).
 */
describe("agenda prompt — carried-forward context (#2105)", () => {
	// Asserts on the fully assembled prompt, as it did before #2178 — the
	// default template plus the code-side locked clauses.
	const buildPrompt = async (
		context: AgendaContext,
		meetingSubject: string,
	) =>
		(
			await composeAgendaPrompt({
				templateBody: MEETING_AGENDA_PROMPT_FALLBACK_BODY,
				format: "HANDLEBARS",
				meetingSubject,
				occurrenceStart: new Date("2026-08-05T09:00:00Z"),
				context,
			})
		).prompt;

	const CARRIED: AgendaContext = {
		...EMPTY,
		hadPriorTranscripts: true,
		priorMeetings: [
			{
				meetingSubject: "Weekly Sync",
				meetingDate: new Date("2026-07-29T09:00:00Z"),
				summary: "Rollout discussed.",
				decisions: [],
				openQuestions: [],
			},
		],
		carriedActionItems: [
			{
				text: "Chase the vendor contract",
				tentativeOwnerName: "the vendor owner",
				dueHint: "next week",
				fromMeetingSubject: "Weekly Sync",
				fromMeetingDate: new Date("2026-07-29T09:00:00Z"),
			},
		],
	};

	it("names carried items as old business, attributed to the meeting that raised them (FR2)", async () => {
		const prompt = await buildPrompt(CARRIED, "Weekly Sync");

		expect(prompt).toContain("Carried forward");
		expect(prompt).toContain("Chase the vendor contract");
		expect(prompt).toContain("the vendor owner");
		expect(prompt).toContain("2026-07-29");
		// The classification rule must be explicit, or the model splits the two
		// groups by vibe rather than by provenance. Since #2178 it is appended
		// code-side, so an org prompt override cannot drop it by accident.
		expect(prompt).toContain("carriedForward");
	});

	it("omits the carried-forward section entirely when nothing carried over (FR3)", async () => {
		const prompt = await buildPrompt(EMPTY, "Weekly Sync");

		expect(prompt).not.toContain("Carried forward");
	});

	it("attributes the no-history branch to the window, not to non-existence", async () => {
		// A series whose only transcripts predate the lookback window has history;
		// telling the model it has none is a lie it will repeat to the user.
		const prompt = await buildPrompt(EMPTY, "Weekly Sync");

		expect(prompt).toContain("recent");
	});

	it("truncates long prior-meeting summaries so five occurrences cannot blow the prompt", async () => {
		const prompt = await buildPrompt(
			{
				...EMPTY,
				hadPriorTranscripts: true,
				priorMeetings: [
					{
						meetingSubject: "Weekly Sync",
						meetingDate: new Date("2026-07-29T09:00:00Z"),
						summary: "x".repeat(5000),
						decisions: [],
						openQuestions: [],
					},
				],
			},
			"Weekly Sync",
		);

		expect(prompt).not.toContain("x".repeat(2000));
		expect(prompt).toContain("…");
	});
});

describe("renderAgendaMarkdown — old business vs new items (#2105)", () => {
	it("splits the agenda into two headed sections when both groups exist (FR2)", () => {
		const md = renderAgendaMarkdown({
			items: [
				{
					title: "Vendor contract",
					intent: "carry_over",
					carriedForward: true,
				},
				{
					title: "Auth provider decision",
					intent: "decision",
					carriedForward: false,
				},
			],
		});

		expect(md).toContain("### Old business");
		expect(md).toContain("### New items");
		expect(md.indexOf("### Old business")).toBeLessThan(
			md.indexOf("### New items"),
		);
		// Numbering restarts per section rather than running across both.
		expect(md).toContain("1. **Vendor contract**");
		expect(md).toContain("1. **Auth provider decision**");
	});

	it("falls back to intent for structures persisted before carriedForward existed (D6)", () => {
		const md = renderAgendaMarkdown({
			items: [
				{ title: "Vendor contract", intent: "carry_over" },
				{ title: "Auth provider decision", intent: "decision" },
			],
		});

		expect(md).toContain("### Old business");
		expect(md).toContain("### New items");
	});

	it("renders a single ungrouped list when nothing carried over (FR3)", () => {
		const md = renderAgendaMarkdown({
			items: [
				{ title: "Auth provider decision", intent: "decision" },
				{ title: "Infra spike", intent: "blocker" },
			],
		});

		expect(md).toContain("## Agenda");
		expect(md).not.toContain("### Old business");
		expect(md).not.toContain("### New items");
		expect(md).toContain("1. **Auth provider decision**");
		expect(md).toContain("2. **Infra spike**");
	});

	it("still labels old business when there are no new items (FR2)", () => {
		// The all-carry-over agenda is the one a reader most needs told: without
		// the heading, "nothing here is new" is invisible. An empty "New items"
		// heading is still never emitted.
		const md = renderAgendaMarkdown({
			items: [
				{ title: "Vendor contract", intent: "carry_over" },
				{ title: "Migration plan", intent: "carry_over" },
			],
		});

		expect(md).toContain("### Old business");
		expect(md).not.toContain("### New items");
		expect(md).toContain("1. **Vendor contract**");
		expect(md).toContain("2. **Migration plan**");
	});
});
