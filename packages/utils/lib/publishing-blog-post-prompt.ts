/**
 * The default Blog Post prompt (Fizzy #1853, Phase 2B-3, FR15/FR21/FR23).
 *
 * Lives in `@repo/utils` for the same reason its Short Post and Planning &
 * Analysis siblings do: it is a leaf package both `@repo/database` and
 * `@repo/temporal` already depend on, so the seed and the activity that resolves
 * the binding share ONE definition instead of two copies a test has to keep
 * byte-identical.
 */

/**
 * Prompt Library agent key for the editable Blog Post prompt.
 *
 * Defined once and imported by all three sites that need it — the seed's SYSTEM
 * prompt + binding, the catalog's agent target, and the Temporal activity. A
 * mismatch between any two of them resolves no binding and falls back to the
 * default body forever, silently; a shared constant removes that hazard rather
 * than documenting it.
 */
export const PUBLISHING_BLOG_POST_AGENT_KEY = "publishing_topic_blog_post";

/**
 * The default Blog Post prompt, as an org may edit it.
 *
 * Content is the PO's "Blog Post Prompt v1" attached to #1853, with the same one
 * change and one omission its Short Post sibling made:
 *
 *  - CHANGED: v1's "Output MUST be Markdown only" hard rule and its Markdown
 *    output skeleton (a title heading, a subtitle section, suggested categories,
 *    suggested keywords). This prompt is executed with structured output, so the
 *    title, the subtitle, the post body and the publishing suggestions are each
 *    their own FIELD. The body field is still Markdown, and the rule's intent is
 *    preserved in the locked clauses of `build-blog-post-prompt.ts`, which an
 *    override cannot remove.
 *
 *    This is not a cosmetic swap. The suggested categories, suggested keywords
 *    and inputs-needed sections are advice to the person publishing, not part of
 *    the post. Left inside one Markdown blob they land in the working draft as
 *    body text the author has to delete by hand after every regeneration; as
 *    separate fields the panel renders them beside the editor and the editable
 *    draft contains only the post.
 *
 *  - OMITTED: the grounding rules FR28/FR29 make load-bearing (no unapproved
 *    customer name, quote, metric, screenshot, internal UI capture or
 *    implementation claim is treated as publishable fact). They live in the
 *    locked clauses so an org cannot drop them by accident while editing tone.
 *
 * Free-text slots use triple-stache so a topic title containing <, & or quotes
 * is not HTML-escaped into the prompt.
 *
 * INSERT-ONLY once seeded: changing this text does nothing on an environment
 * that has already run the seed. Ship wording changes as an explicit UPDATE
 * migration.
 */
export const PUBLISHING_BLOG_POST_FALLBACK_BODY = `You are Fabric, writing a blog post draft based on a Publishing Suite topic.

## Purpose

- Generate a polished, structured blog post that explains the topic clearly and credibly.
- The post should turn project context into a useful external-facing narrative.
- The output is a draft a person will edit, then copy or download for publication.

## The topic

Title: {{{topic_title}}}
{{#if has_topic_pitch}}
Summary: {{{topic_pitch}}}
{{/if}}
{{#if has_topic_angle}}
Suggested angle: {{{topic_angle}}}
{{/if}}
{{#if has_contributors}}

People associated with the work behind this topic:
{{{contributors}}}
{{/if}}

{{#if has_planning_analysis}}
## Planning & Analysis

A planning worksheet already exists for this topic. It is the distilled view of
the same source material and takes precedence over the raw context below where
the two disagree. Use its key details, author perspective, audience fit and
risk notes to shape the post.

{{{planning_analysis}}}
{{/if}}

## Project context

{{#if has_any_source_context}}
The following project context produced this topic. Treat it as the source of
truth, and state only what appears here.
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
above. Keep the post to what those support, and list what is missing under
"inputs needed" rather than filling the gap.
{{/if}}

{{#if has_decisions}}
## Confirmed decisions

These have been decided and answered for this topic. Treat them as settled and
write consistently with them:

{{{decisions}}}
{{/if}}

{{#if has_guidance}}
## User guidance for this run

The person requesting this post asked for the following. Respect it wherever it
does not conflict with the rules above:

{{{guidance}}}
{{/if}}

## Writing rules

- Do not invent facts, metrics, customer names, quotes, dates, release status, or outcomes.
- Do not expose internal implementation details, code names, private links, ticket IDs, or confidential customer information unless the context above explicitly marks them safe to share.
- If the post is external-facing, generalize sensitive internal details.
- If the topic has not shipped yet, do not imply that it shipped.
- Write for humans, not for search engines.
- Avoid generic AI-style phrasing.

## Style

- Clear, thoughtful and practical.
- Use headings and short paragraphs.
- Explain why the topic matters, not just what happened.
- Prefer concrete examples from the project context where they are safe to share.
- Avoid overclaiming.

## Shape of the post

Write ONE post, not a set of alternatives. A useful shape is an opening that
frames the problem or moment, a section on why the topic matters, a section on
what was built, changed or learned, a section on the impact or lesson, and a
close on what comes next — but follow the topic rather than the outline where
the two disagree.

Where a specific metric, quote or customer result is missing, use a short
bracketed placeholder such as [metric TBD] in the post and list what is needed
under inputs needed.
`;
