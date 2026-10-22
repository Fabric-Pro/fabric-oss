import type { TemplateFormat } from "@repo/utils";
import { z } from "zod";
import { renderBoundPromptBody } from "../lib/render-bound-prompt-body";
import type { AgendaContext } from "./collect-agenda-context";

/**
 * Structured agenda output (#1901).
 *
 * Rendered to markdown exactly ONCE, after which the markdown is the source of
 * truth and this structure is kept only as provenance. That is what keeps FR3
 * (user editing) simple — nothing has to be reconciled back into a structured
 * document after a human rewrites a bullet.
 *
 * Structured-output schema conversion and provider flags are selected by the
 * shared packages/ai middleware; callers keep this optional-field contract.
 */
export const AgendaSchema = z.object({
	items: z
		.array(
			z.object({
				title: z.string().min(1),
				intent: z.enum([
					"carry_over",
					"decision",
					"blocker",
					"review",
					"discussion",
				]),
				detail: z.string().optional(),
				/**
				 * Old business vs new items (#2105 FR2). Optional on purpose:
				 * every `generatedStructure` persisted before #2105 lacks it, and
				 * renderAgendaMarkdown falls back to `intent === "carry_over"` so
				 * those rows still render correctly without a backfill.
				 */
				carriedForward: z.boolean().optional(),
				suggestedMinutes: z.number().int().positive().optional(),
				sourceRefs: z
					.array(
						z.object({
							kind: z.enum([
								"action_item",
								"decision",
								"story",
								"prior_meeting",
							]),
							label: z.string(),
						}),
					)
					.optional(),
			}),
		)
		.min(1),
	notes: z.string().optional(),
});

export type AgendaStructure = z.infer<typeof AgendaSchema>;

/**
 * Prompt Library agent key for the editable agenda prompt (#2178).
 *
 * The identical string appears in three places and nothing cross-checks them at
 * runtime — a mismatch resolves no binding and falls back to the default body
 * forever, silently:
 *   - packages/database/prisma/seed-prompts-only.ts (seed + SYSTEM binding)
 *   - apps/web/.../prompts/components/PromptBindingManager.tsx (AGENT_TARGETS)
 *   - here, for getBoundPromptForAgent
 */
export const MEETING_AGENDA_AGENT_KEY = "meeting_agenda_generator";

const formatDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Bound on each prior meeting's summary inside the prompt (#2105).
 *
 * Before #2105 three summaries went in raw and unbounded; the window now admits
 * up to five, so the total has to be capped somewhere. A meeting summary's first
 * ~1200 characters carry the shape of the discussion, which is all this prompt
 * needs — the specifics it must not invent come from the structured lists below.
 */
export const PRIOR_SUMMARY_CHAR_CAP = 1200;

const truncateSummary = (summary: string) =>
	summary.length > PRIOR_SUMMARY_CHAR_CAP
		? `${summary.slice(0, PRIOR_SUMMARY_CHAR_CAP).trimEnd()}…`
		: summary;

/**
 * The data half of the agenda prompt (#2178).
 *
 * Pure and synchronous so it stays unit-testable without an LLM or a database.
 * Each block value is a bullet list WITHOUT its heading: the heading lives in
 * the editable template, so an org can relabel a section without losing the
 * data underneath it. The paired `has_*` boolean is what lets the template keep
 * the invariant that an empty section is omitted rather than rendered as a bare
 * heading — which would invite the model to fill it with plausible inventions.
 */
export type AgendaPromptVariables = {
	meeting_subject: string;
	meeting_date: string;
	has_prior_meetings: boolean;
	prior_meetings: string;
	has_carried_items: boolean;
	carried_items: string;
	has_open_action_items: boolean;
	open_action_items: string;
	has_open_decisions: boolean;
	open_decisions: string;
	has_blocked_stories: boolean;
	blocked_stories: string;
};

export function buildAgendaVariables({
	meetingSubject,
	occurrenceStart,
	context,
}: {
	meetingSubject: string | null;
	occurrenceStart: Date;
	context: AgendaContext;
}): AgendaPromptVariables {
	const priorMeetingLines: string[] = [];
	for (const meeting of context.priorMeetings) {
		const when = meeting.meetingDate
			? formatDate(meeting.meetingDate)
			: "date unknown";
		priorMeetingLines.push(
			`- ${when}: ${meeting.summary ? truncateSummary(meeting.summary) : "(no summary)"}`,
		);
		for (const decision of meeting.decisions) {
			priorMeetingLines.push(`  - Decided: ${decision}`);
		}
		for (const question of meeting.openQuestions) {
			priorMeetingLines.push(`  - Left open: ${question}`);
		}
	}

	const carriedLines = context.carriedActionItems.map((item) => {
		const owner = item.tentativeOwnerName
			? ` (owner: ${item.tentativeOwnerName})`
			: "";
		const due = item.dueHint ? ` (due: ${item.dueHint})` : "";
		const raised = item.fromMeetingDate
			? ` (raised: ${formatDate(item.fromMeetingDate)}${
					item.fromMeetingSubject
						? ` "${item.fromMeetingSubject}"`
						: ""
				})`
			: "";
		return `- ${item.text}${owner}${due}${raised}`;
	});

	const openActionLines = context.openActionItems.map((item) => {
		const owner = item.tentativeOwnerName
			? ` (owner: ${item.tentativeOwnerName})`
			: "";
		const due = item.dueHint ? ` (due: ${item.dueHint})` : "";
		return `- ${item.text}${owner}${due}`;
	});

	const decisionLines = context.openDecisions.map(
		(decision) =>
			`- ${decision.storyIdentifier} (${decision.storyTitle}): ${decision.question}`,
	);

	const blockedLines = context.blockedStories.map(
		(story) =>
			`- ${story.identifier} (${story.title}): ${story.blockedReason ?? "no reason recorded"}`,
	);

	return {
		meeting_subject: meetingSubject ?? "Untitled meeting",
		meeting_date: formatDate(occurrenceStart),
		has_prior_meetings: context.hadPriorTranscripts,
		prior_meetings: priorMeetingLines.join("\n"),
		has_carried_items: context.carriedActionItems.length > 0,
		carried_items: carriedLines.join("\n"),
		has_open_action_items: context.openActionItems.length > 0,
		open_action_items: openActionLines.join("\n"),
		has_open_decisions: context.openDecisions.length > 0,
		open_decisions: decisionLines.join("\n"),
		has_blocked_stories: context.blockedStories.length > 0,
		blocked_stories: blockedLines.join("\n"),
	};
}

/**
 * The default editable body (#2178).
 *
 * MUST stay in sync with the `meeting_agenda_generator` entry in
 * packages/database/prisma/seed-prompts-only.ts — a test pins this. Used
 * verbatim when no binding resolves (a not-yet-seeded environment) and as the
 * recovery body when a bound template fails to render.
 *
 * The two clauses this body does NOT contain — grounding and carried-forward
 * classification — are appended by buildAgendaLockedClauses.
 *
 * Free-text slots use triple-stache: `{{ }}` HTML-escapes, so a meeting subject
 * containing & or " would reach the model as &amp; and &quot;.
 */
export const MEETING_AGENDA_PROMPT_FALLBACK_BODY = `You are preparing an agenda for an upcoming team meeting in Fabric.

Meeting: {{{meeting_subject}}}
Scheduled: {{meeting_date}}

{{#if has_prior_meetings}}
Prior meetings in this series (most recent first):
{{{prior_meetings}}}
{{else}}
No recent meeting transcripts are available for this series. Build the
agenda from the open work below, and do not refer to previous
discussions.
{{/if}}
{{#if has_carried_items}}

Carried forward — open action items raised in earlier meetings of THIS series:
{{{carried_items}}}
{{/if}}
{{#if has_open_action_items}}

Open action items:
{{{open_action_items}}}
{{/if}}
{{#if has_open_decisions}}

Unresolved questions on work items:
{{{open_decisions}}}
{{/if}}
{{#if has_blocked_stories}}

Blocked work:
{{{blocked_stories}}}
{{/if}}

Produce a focused agenda of 3-7 items, ordered by what most needs the
team's attention. Rules:
- Prefer items that need a decision or unblock someone over status recital.
- Keep titles under 10 words.
- Use sourceRefs to name what each item came from.
- Only set suggestedMinutes when the context implies a sensible length.`;

/**
 * Clauses composed code-side and appended after the editable body (#2178).
 *
 * These protect two things an org override must not accidentally drop:
 * grounding, and the classification that renderAgendaMarkdown's Old business /
 * New items split depends on (#2105 FR2, D7).
 *
 * They are resistant to accidental removal, NOT to deliberate contradiction —
 * a body instructing the model to invent topics will contradict the first
 * clause and the model picks a winner. AgendaSchema still enforces output
 * SHAPE at generateObject regardless, so a broken body can never corrupt the
 * persisted row.
 */
export function buildAgendaLockedClauses(context: AgendaContext): string {
	const clauses = [
		"- Every item must trace to the context above. Invent nothing.",
	];

	// Only state the rule when there is a group to classify against. Naming a
	// "Carried forward" section that was never rendered invites the model to
	// produce old business out of nothing.
	if (context.carriedActionItems.length > 0) {
		clauses.push(
			'- An item drawn from "Carried forward" is old business: set',
			"  carriedForward=true and intent=carry_over. Everything else is a new",
			"  item: set carriedForward=false. Never move an item between the two",
			"  groups — that classification is already decided.",
		);
	}

	return clauses.join("\n");
}

/**
 * Render the editable body against the meeting's context and append the locked
 * clauses (#2178).
 *
 * The guards that decide a bound body "did not render" (a non-templating
 * format, leftover template syntax, a blank result) are `renderBoundPromptBody`'s,
 * shared with the other prompt-library-backed features. They report themselves
 * in the return value, not just to the log: a degraded run still produces a
 * perfectly plausible agenda, so "this came from the default body because your
 * prompt would not render" is exactly the thing a reader cannot infer from the
 * output — it is recorded as provenance on the agenda row and surfaced in "How
 * this agenda was built".
 */
export interface ComposedAgendaPrompt {
	prompt: string;
	/** A non-templating format was rendered as Handlebars. */
	formatOverridden: boolean;
	/**
	 * The supplied body yielded nothing usable — it failed to render, or
	 * rendered to blank — and the default was used instead. One flag for both
	 * because the consequence a reader needs is identical: this agenda did not
	 * come from the prompt it is bound to.
	 */
	bodyRecovered: boolean;
}

export async function composeAgendaPrompt({
	templateBody,
	format,
	meetingSubject,
	occurrenceStart,
	context,
}: {
	templateBody: string;
	format: TemplateFormat;
	meetingSubject: string | null;
	occurrenceStart: Date;
	context: AgendaContext;
}): Promise<ComposedAgendaPrompt> {
	const rendered = await renderBoundPromptBody({
		body: templateBody,
		format,
		fallbackBody: MEETING_AGENDA_PROMPT_FALLBACK_BODY,
		variables: buildAgendaVariables({
			meetingSubject,
			occurrenceStart,
			context,
		}),
		logTag: "meeting-agenda",
	});

	return {
		prompt: `${rendered.text.trimEnd()}\n${buildAgendaLockedClauses(context)}`,
		formatOverridden: rendered.formatOverridden,
		bodyRecovered: rendered.recovered,
	};
}

const INTENT_LABEL: Record<AgendaStructure["items"][number]["intent"], string> =
	{
		carry_over: "Carry-over",
		decision: "Decision",
		blocker: "Blocker",
		review: "Review",
		discussion: "Discussion",
	};

/**
 * Render the structured agenda to markdown once, at generation time. After this
 * the markdown is the editable source of truth.
 */
export function renderAgendaMarkdown(structure: AgendaStructure): string {
	/**
	 * `carriedForward` is authoritative when present. Falling back to the intent
	 * is what lets every `generatedStructure` written before #2105 — where the
	 * field simply does not exist — still split correctly, with no backfill and
	 * no re-generation (D6).
	 */
	const isCarried = (item: AgendaStructure["items"][number]) =>
		item.carriedForward ?? item.intent === "carry_over";

	const carried = structure.items.filter(isCarried);
	const fresh = structure.items.filter((item) => !isCarried(item));

	const renderItems = (
		items: AgendaStructure["items"],
		lines: string[],
	): void => {
		items.forEach((item, index) => {
			const timing = item.suggestedMinutes
				? ` _(${item.suggestedMinutes} min)_`
				: "";
			lines.push(
				`${index + 1}. **${item.title}**${timing} — ${INTENT_LABEL[item.intent]}`,
			);
			if (item.detail) {
				lines.push(`   ${item.detail}`);
			}
			if (item.sourceRefs && item.sourceRefs.length > 0) {
				lines.push(
					`   _From: ${item.sourceRefs.map((ref) => ref.label).join("; ")}_`,
				);
			}
			lines.push("");
		});
	};

	const lines: string[] = ["## Agenda", ""];

	// The rule is deliberately asymmetric (#2105 D7), keyed on old business alone:
	//
	//   carried, fresh  -> both headings
	//   carried only    -> "Old business" only — the label is the whole point of
	//                      FR2, and an agenda that is entirely carry-over is the
	//                      case a reader most needs told
	//   fresh only      -> no headings at all, so a first occurrence renders
	//                      exactly as it did before #2105 (FR3)
	//
	// An empty heading is never emitted, which is also what stops the model
	// reading a bare "Old business" as a section it ought to fill.
	if (carried.length > 0) {
		lines.push("### Old business", "");
		renderItems(carried, lines);
		if (fresh.length > 0) {
			lines.push("### New items", "");
			renderItems(fresh, lines);
		}
	} else {
		renderItems(fresh, lines);
	}

	if (structure.notes) {
		lines.push("## Notes", "", structure.notes, "");
	}

	return lines.join("\n").trimEnd();
}
