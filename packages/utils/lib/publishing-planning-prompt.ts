/**
 * The default Topic Planning & Analysis prompt (Fizzy #1851, AC4/FR16/FR17).
 *
 * It lives in `@repo/utils` — a leaf package both `@repo/database` and
 * `@repo/temporal` already depend on — so the seed and the activity share ONE
 * definition rather than two that must be kept byte-identical by a test.
 *
 * That is a deliberate departure from the `meeting_agenda_generator` precedent,
 * which duplicates its body between `seed-prompts-only.ts` and
 * `build-agenda-prompt.ts`. The seed comment there says "a test in @repo/temporal
 * pins this"; there is no such test — nothing imports the seed module — so those
 * two copies can drift today with nothing to catch it. A shared constant makes
 * the drift impossible instead of detectable.
 */

/**
 * Prompt Library agent key for the editable Planning & Analysis prompt (#1851).
 *
 * Defined ONCE, here, and imported by all three sites that need it — the seed's
 * SYSTEM prompt + binding, `prompt-action-catalog.ts`'s agent target, and the
 * Temporal activity that resolves the binding. The `meeting_agenda_generator`
 * precedent repeats its literal in all three and documents the hazard rather
 * than removing it: "a mismatch resolves no binding and falls back to the
 * default body forever, silently". A shared constant removes it.
 */
export const PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY =
	"publishing_topic_planning_analysis";

/**
 * The default Topic Planning & Analysis prompt (AC4/FR16/FR17), as an org may
 * edit it.
 *
 * Content is the PO's "Topic Planning & Analysis Prompt v1.1" attached to #1851,
 * with ONE deliberate change and one deliberate omission:
 *
 *  - CHANGED: v1.1's hard rule "Output MUST be Markdown only", plus its Markdown
 *    output skeleton. This prompt is executed with structured output, so each
 *    section is returned as its own FIELD whose value is Markdown. The rule's
 *    intent — do not emit the finished content asset — is preserved verbatim in
 *    the locked clauses below, which an override cannot remove.
 *  - OMITTED: the grounding rules that FR40–FR42 make load-bearing (no asset is
 *    generated or used; no customer name, quote, screenshot, internal UI, metric
 *    or AI likeness is treated as approved). They live in the locked clauses for
 *    the same reason the meeting-agenda prompt keeps its grounding rule
 *    code-side: an org must not be able to drop them by accident.
 *
 * This constant IS the seeded body: `seed-prompts-only.ts` imports it, as does
 * the catalog entry and the activity that resolves the binding. There is
 * therefore nothing to keep in sync by hand and no test pinning byte-identity —
 * drift is impossible rather than merely detectable, which is why the constant
 * lives in `@repo/utils` (a leaf both `@repo/database` and `@repo/temporal`
 * already depend on) instead of in either of them.
 *
 * Worth stating plainly because the sibling `meeting_agenda_generator` entry
 * claims a test pins ITS duplicated literal, and that claim is false: the seed
 * calls `process.exit(0)` at module scope, so nothing can import it to test it.
 * Do not copy that comment here.
 *
 * Free-text slots use triple-stache so a topic title containing <, & or quotes
 * is not HTML-escaped into the prompt.
 *
 * INSERT-ONLY once seeded: changing this text does nothing on an environment
 * that has already run the seed. Ship wording changes as an explicit UPDATE
 * migration.
 */
export const PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY = `You are generating the Planning & Analysis content for a Publishing Suite topic in Fabric.

This output is used on the Topic Item Page to help a contributor understand the topic angle, key article details, recommended authorship model, author perspective, recommended content types, supporting assets, source signals, unresolved questions, and pre-draft guidance before any content is generated.

This is not the final article, post, email, case study, script, newsletter blurb, video walkthrough, or asset. This is a pre-draft planning worksheet.

## The topic

Title: {{{topic_title}}}
{{#if has_topic_pitch}}
Summary: {{{topic_pitch}}}
{{/if}}
{{#if has_topic_angle}}
Suggested angle: {{{topic_angle}}}
{{/if}}
{{#if has_topic_subject}}
Underlying subject: {{{topic_subject}}}
{{/if}}
{{#if has_function_tags}}
Disciplines this topic serves: {{{function_tags}}}
{{/if}}
{{#if has_contributors}}

People associated with the work behind this topic:
{{{contributors}}}
{{/if}}
{{#if has_post_type_recommendations}}

Content formats already suggested for this topic:
{{{post_type_recommendations}}}
{{/if}}

## Project context

{{#if has_any_source_context}}
The following project context produced this topic. Treat it as the source of
truth, and cite only what appears here.
{{#if has_stories}}

Work items:
{{{stories}}}
{{/if}}
{{#if has_documents}}

Project documents:
{{{documents}}}
{{/if}}
{{#if has_transcripts}}

Meeting and call transcripts:
{{{transcripts}}}
{{/if}}
{{#if has_pull_requests}}

Pull requests. Where a description follows the reference it is the pull
request's own text; where none follows, the reference is evidence that the work
happened and nothing more — do not infer its contents:
{{{pull_requests}}}
{{/if}}
{{else}}
No source context is available for this topic beyond its own title and summary
above. Say so plainly in your analysis, mark the evidence as weak, and do not
supply details that the title and summary do not support.
{{/if}}

## Purpose

Generate a structured Planning & Analysis document that helps the user decide:

- what the topic angle should be,
- why the topic is worth publishing,
- which key details should be used later,
- who should author or contribute to the content,
- what perspective each author should bring,
- which audience or distribution path fits the topic,
- which content type(s) should be generated,
- which content types should be deferred or avoided,
- which supporting assets would strengthen the content,
- which approvals or missing information are needed,
- what source-backed details should guide later drafting.

When possible, distinguish between confirmed facts, likely but unconfirmed
details, candidate claims that require validation, details that require approval
before use, and details that should not be used externally.

## Hard rules

- Do NOT invent facts, metrics, customer names, or customer quotes.
- Do NOT invent author beliefs, emotions, worldview, personal history, language
  competency, or writing style.
- Do NOT claim customer approval unless approval is explicitly present in
  context.
- Do NOT claim a feature shipped unless context explicitly supports that.
- Do NOT claim an implementation detail unless the context supports it.
- Do NOT expose confidential, internal, or sensitive information as publishable
  unless the context explicitly says it is approved for use.
- Do NOT describe contributor associations, content types, or asset
  recommendations as Fabric tags.
- If evidence is weak, say so clearly.
- If a recommendation depends on approval or missing information, mark it as
  requiring confirmation.
- If an author's personal voice or worldview is not available in context,
  recommend only a role-based professional perspective.

## Decision handling

Some recommendations should become user-confirmable decisions. When a
recommendation requires user confirmation, raise it as a recommended question
rather than assuming an answer. Examples: whether to use a customer name;
whether a quote is approved; whether internal UI can be shown; whether a video
walkthrough should be created; which format the first output should take;
whether a contributor should be author, co-author or supporting contributor;
whether outcome metrics are approved and accurate; whether the topic is
internal-only or external-ready; whether a claim is strong enough to use
publicly.

## Authorship guidance

Recommend authors and contributors based on available context: role and function
tags, work item ownership, authored documents, meeting participation, code
contributions, design contributions, QA contributions, stakeholder involvement,
product ownership, delivery ownership and subject-matter expertise.

Support multiple authorship models — one author, several authors, co-authors, an
author plus supporting contributors, or separate role-specific drafts. Do not
assume every contributor should co-author the same piece: if different
contributors have different angles, recommend separate role-specific outputs.

## Author voice and perspective

Explain the professional angle each recommended author should bring, based on
their role, their likely contribution, and their relationship to the problem —
product and value framing, technical implementation, design rationale, QA and
testing insight, delivery lessons, customer impact, leadership perspective, or
stakeholder communication. If two contributors could write about the same
subject, explain how their drafts should differ so they are not duplicative.

Prioritise role-based and contribution-based perspective. Do not invent personal
experiences, beliefs, emotions, worldview, language competency or quotes.

## Audience and distribution

Recommend the most appropriate audience and distribution framing: internal-only,
external public, customer or stakeholder update, peer and practitioner
education, technical audience, product and business audience, leadership
audience, newsletter, webinar or demo, or social amplification.

If the topic may be external-facing but contains sensitive details, recommend
internal-only or approval-needed framing until the risks are resolved. Do not
treat a topic as externally safe unless the context supports that.

## Content types

Recommend content types based on angle, audience, author fit and available
evidence. Supported types include Tweet / Short Post, Blog Post, Case Study,
Stakeholder Email, Webinar or Demo Script, Video Walkthrough Script, Newsletter
Blurb, and AI-assisted Video Walkthrough. For each relevant type, decide whether
it is recommended, possible but needing confirmation, or deferred and not
recommended yet.

## Supporting assets

Recommend supporting assets where they would strengthen the content — customer
or stakeholder quotes, screenshots, internal UI captures, product images,
workflow or architecture diagrams, charts, metric callouts, code snippets, demo
scripts, video walkthroughs, customer logos, project timelines, or before and
after comparisons. Classify each as recommended, requiring confirmation or
approval, or deferred and not recommended yet.

Never assume approval for a sensitive asset: customer names, logos and quotes,
stakeholder quotes, screenshots of internal UI, private roadmap details,
unreleased features, proprietary implementation details, metric and outcome
claims, and AI voice or video likeness are all sensitive.

## Key details

Capture the concrete article ingredients a writer would need later: what shipped
or changed, what problem was solved and why it matters now, what makes the
solution novel or difficult or timely, implementation details safe to discuss,
customer or stakeholder reactions, outcome metrics, constraints and caveats, and
approved or candidate quotes.

Do not invent key details. If a detail is promising but unconfirmed, label it as
unconfirmed, candidate, or requiring approval. Label every quote by approval
status: approved for use, candidate needing approval, internal only, or do not
use externally.`;
