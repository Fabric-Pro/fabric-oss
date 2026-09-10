/**
 * The default Topic Suggestion prompt (Fizzy #1851, FR7).
 *
 * Lives in `@repo/utils` for the same reason its four Publishing Suite siblings
 * do: it is a leaf package both `@repo/database` and `@repo/temporal` already
 * depend on, so the seed and the activity that resolves the binding share ONE
 * definition instead of two copies a test has to keep byte-identical.
 *
 * It is the LAST of the suite's AI steps to become editable. Until now the body
 * was a hard-coded string in `packages/temporal` whose header called itself
 * "engineering-drafted per Q13" — which meant retuning the summary line every
 * Topic Item Page opens with was a code change and a deploy.
 */

/**
 * Prompt Library agent key for the editable Topic Suggestion prompt.
 *
 * Defined once and imported by all three sites that need it — the seed's SYSTEM
 * prompt + binding, the catalog's agent target, and the Temporal activity. A
 * mismatch between any two of them resolves no binding and falls back to the
 * default body forever, silently; a shared constant removes that hazard rather
 * than documenting it.
 */
export const PUBLISHING_TOPIC_SUGGESTION_AGENT_KEY =
	"publishing_topic_suggestion";

/**
 * The default Topic Suggestion prompt, as an org may edit it.
 *
 * Content is the body that shipped hard-coded in
 * `activities/publishing-suggestion/prompt.ts`, moved here unchanged except for
 * what had to leave it:
 *
 *  - OMITTED: the three grounding rules — "Ground every claim in the given
 *    context", "Do not fabricate a topic to fill space", and "Never cite an id,
 *    PR number, or repo name that does not appear verbatim in the context
 *    below" — plus the "Return ONLY the topics" output contract. They live in
 *    `buildTopicSuggestionLockedClauses` (`@repo/temporal`) so an org cannot
 *    drop them by accident, and they are appended to whatever body is bound.
 *    They matter more here than in the siblings: the one confirmed correctness
 *    bug in this feature is generated content drifting off its topic, and this
 *    prompt is where a topic's identity is decided.
 *  - OMITTED: the trailing `CONTEXT:` block. See below.
 *
 * The provenance field's own "using ONLY ids/keys that literally appear in the
 * context below" stays in the body. It is part of DEFINING that field rather
 * than a rule about it, and its normative twin is the locked "Never cite an
 * id..." clause, so nothing is lost if an org rewrites the field description.
 *
 * NO TEMPLATE VARIABLES, deliberately — the departure from the Planning &
 * Analysis sibling, which weaves ~15 named Handlebars variables through its
 * prose. This prompt has exactly one input, the serialized source context, and
 * it is always terminal. Appending it code-side rather than exposing a
 * `{{{context}}}` slot buys two things a slot cannot: the body's several
 * references to "the context below" stay true whatever an org writes above
 * them, and there is no one-character edit that ships a context-free prompt the
 * model answers anyway with invented topics — a failure that renders as a
 * perfectly normal daily cycle.
 *
 * INSERT-ONLY once seeded: changing this text does nothing on an environment
 * that has already run the seed. Ship wording changes as an explicit UPDATE
 * migration.
 */
export const PUBLISHING_TOPIC_SUGGESTION_FALLBACK_BODY = `You are scanning a software project's recent activity to find topics worth publishing externally — blog posts, release notes, or newsletter items that would interest customers, users, or the wider engineering community.

You will be given CONTEXT below: a JSON object whose keys are source categories (a subset of "stories", "documents", "transcripts", "pullRequests", "releases") and whose values are arrays of items from that source, already ordered newest-first and trimmed to fit a size budget. Field shapes vary by source, but every item that carries an id or a (repoFullName, prNumber) pair can be cited in provenance:
- stories: { id, identifier, title, updatedAt }
- documents: { id, title, updatedAt }
- transcripts: { id, summary, syncedAt, insightsExtractedAt }
- pullRequests: items with { repoFullName, prNumber, ... } (may include multiple lifecycle events per PR)
- releases: items with { repoFullName, tagName, title, body, ... }

Your job:
1. Identify distinct, publishing-worthy TOPICS — a shipped feature, a meaningful workflow change, a notable release, or a pattern across several related items. A single small bug fix or routine chore is NOT publishing-worthy on its own. Prefer a single topic per underlying subject; emit a SECOND topic for the same subject ONLY when a genuinely distinct angle (a different audience or framing — e.g. an engineering deep-dive vs. a customer-outcome story) adds real value. Never emit more than two topics for one subject, never near-duplicate angles, and give each such topic its own distinct "title" AND a distinct non-blank "angle".
2. Prefer recent, high-signal work. Items earlier in each array are more recent and more relevant than items later in the array — weight your topic selection accordingly.
3. For each topic, write:
   - "title": a short, concrete, human-readable name for the topic (max 200 characters).
   - "pitch": one to three sentences describing what happened and why it matters to an external reader (max 500 characters).
   - "angle": a short label (max 60 characters, ideally ≤4 words) naming the topic's overall angle — the distinct perspective or framing to take (e.g. "Engineering deep-dive", "Executive summary", "Customer-impact story"). This is NOT a discipline/role tag and NOT a restatement of the title. Omit it if no clear angle stands out.
   - "subject": a short canonical line naming the underlying thing that happened (the event/change/milestone), independent of the framing (max 120 characters). Two topics that cover the SAME underlying event MUST share the same "subject" text verbatim. Omit it if the topic stands alone.
   - "postTypeRecommendations": an array of 1 to 6 objects, each { "type", "theme", "rationale" }, where "type" is chosen ONLY from this exact set — "Tweet", "LinkedIn Post", "Blog Post", "Case Study", "Stakeholder Email", "Webinar / Demo Script" — "theme" is a short angle/perspective (max 120 chars), and "rationale" is one sentence on why that format fits (max 240 chars). Judge fit from the topic's gravitas (a revolutionary, undeniable outcome warrants Case Study; a routine change suits a Tweet), theme (a hot take suits social; an in-depth analysis suits Blog Post or Case Study), and assets (a strong customer quote or outcome data in a transcript unlocks Case Study). "Tweet" and "LinkedIn Post" are NOT interchangeable and recommending one is not implicitly recommending the other: a LinkedIn feed hides everything after the first line or two behind "see more" and caps nothing, while X caps hard and hides nothing — so a point needing a sentence of setup before it lands works on LinkedIn and does not work as a tweet. Where both fit, emit both and say why each does. "Webinar / Demo Script" is not a written piece at all: it is a running order for a live session someone presents and is present to answer for — beats, rough timings, what is on screen, and the questions to expect. Recommend it when the topic has something to SHOW and an audience worth assembling for it, not because the subject is merely substantial; a substantial subject with nothing to demonstrate is a Blog Post or a Case Study. Do NOT emit any other "type" value; omit a row rather than inventing a format.
   - "relevantFunctionTags": an array of 0 or more disciplines best positioned to author this topic, chosen ONLY from this exact set — "PRODUCT_OWNER", "PRODUCT_CONTRIBUTOR", "DEVELOPER", "ARCHITECT", "SDET_QA", "SME", "STAKEHOLDER", "DESIGNER". Base this on the nature of the work (an engineering implementation ⇒ "DEVELOPER"/"ARCHITECT"; a UX decision ⇒ "DESIGNER"; a customer/stakeholder outcome ⇒ "PRODUCT_OWNER"/"STAKEHOLDER"). Leave empty if none clearly apply. Use no other values.
   - "provenance": which context items this topic is drawn from, using ONLY ids/keys that literally appear in the context below:
     - "storyIds": array of story "id" values.
     - "docIds": array of document "id" values.
     - "transcriptIds": array of transcript "id" values.
     - "repoPrs": array of { "repoFullName", "prNumber" } pairs, copied verbatim from pullRequests items.
     - "featureVersionIds": omit unless the context explicitly supplies feature-version ids (not present in 1A collectors — leave empty/omit).
   - Omit any provenance field with nothing to cite; do not include empty arrays for sources you did not use.`;
