/**
 * Publishing Suggestion — Topic-Suggestion Prompt (1A, engineering-drafted per Q13)
 *
 * `context` is the record the workflow assembles from whichever collectors
 * succeeded this cycle — `{ [sourceKey]: item[] }` for a subset of `stories`,
 * `documents`, `transcripts`, `pullRequests`, `releases` (see
 * `publishing-suggestion-generation-workflow.ts`, Task 9). Each item array is
 * already recency-ordered and byte-bounded by its collector (§6.7), so this
 * prompt does no further trimming — it only instructs the model how to read
 * the shape and what to produce.
 *
 * Typed `unknown` deliberately: the Temporal workflow sandbox cannot import
 * `@repo/database`'s collector output types, so the boundary is opaque JSON by
 * design. This function is a single pure `unknown -> string` transform — no
 * I/O, no clock reads, no imports beyond stdlib-equivalent `JSON.stringify`.
 */

export function buildTopicSuggestionPrompt(context: unknown): string {
	return `You are scanning a software project's recent activity to find topics worth publishing externally — blog posts, release notes, or newsletter items that would interest customers, users, or the wider engineering community.

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
   - "pitch": one to three sentences describing what happened and why it matters to an external reader (max 500 characters). Ground every claim in the given context — never invent details, numbers, or outcomes that are not present.
   - "angle": a short label (max 60 characters, ideally ≤4 words) naming the topic's overall angle — the distinct perspective or framing to take (e.g. "Engineering deep-dive", "Executive summary", "Customer-impact story"). This is NOT a discipline/role tag and NOT a restatement of the title. Omit it if no clear angle stands out.
   - "subject": a short canonical line naming the underlying thing that happened (the event/change/milestone), independent of the framing (max 120 characters). Two topics that cover the SAME underlying event MUST share the same "subject" text verbatim. Omit it if the topic stands alone.
   - "postTypeRecommendations": an array of 1 to 4 objects, each { "type", "theme", "rationale" }, where "type" is chosen ONLY from this exact set — "Tweet", "Blog Post", "Case Study", "Stakeholder Email" — "theme" is a short angle/perspective (max 120 chars), and "rationale" is one sentence on why that format fits (max 240 chars). Judge fit from the topic's gravitas (a revolutionary, undeniable outcome warrants Case Study; a routine change suits a Tweet), theme (a hot take suits social; an in-depth analysis suits Blog Post or Case Study), and assets (a strong customer quote or outcome data in a transcript unlocks Case Study). Do NOT emit any other "type" value; omit a row rather than inventing a format.
   - "relevantFunctionTags": an array of 0 or more disciplines best positioned to author this topic, chosen ONLY from this exact set — "PRODUCT_OWNER", "PRODUCT_CONTRIBUTOR", "DEVELOPER", "ARCHITECT", "SDET_QA", "SME", "STAKEHOLDER", "DESIGNER". Base this on the nature of the work (an engineering implementation ⇒ "DEVELOPER"/"ARCHITECT"; a UX decision ⇒ "DESIGNER"; a customer/stakeholder outcome ⇒ "PRODUCT_OWNER"/"STAKEHOLDER"). Leave empty if none clearly apply. Use no other values.
   - "provenance": which context items this topic is drawn from, using ONLY ids/keys that literally appear in the context below:
     - "storyIds": array of story "id" values.
     - "docIds": array of document "id" values.
     - "transcriptIds": array of transcript "id" values.
     - "repoPrs": array of { "repoFullName", "prNumber" } pairs, copied verbatim from pullRequests items.
     - "featureVersionIds": omit unless the context explicitly supplies feature-version ids (not present in 1A collectors — leave empty/omit).
   - Omit any provenance field with nothing to cite; do not include empty arrays for sources you did not use.
4. Do not fabricate a topic to fill space. If nothing in the context is genuinely publishing-worthy, return an empty "topics" array — that is a valid and expected answer for a quiet window.
5. Never cite an id, PR number, or repo name that does not appear verbatim in the context below.

Return ONLY the topics — no commentary, no restating the context, no meta-discussion.

CONTEXT:
${JSON.stringify(context, null, 2)}
`;
}

/**
 * Strip the publishing-suite-only `authorGithubId` from `pullRequests` context
 * items before the prompt is built. The numeric GitHub id is consumed by the
 * workflow's PR-author contributor map (see `publishing-suggestion-pr-authors`),
 * NOT by the model — the prompt only asks the LLM to cite `(repoFullName,
 * prNumber)`. Keeping the id out of the serialized CONTEXT avoids sending a real
 * person's numeric GitHub id to the model provider and prompt logs, and trims a
 * few tokens. Pure and non-mutating.
 */
export function stripPrAuthorGithubIdsForPrompt(
	context: Record<string, unknown>,
): Record<string, unknown> {
	const prs = context.pullRequests;
	if (!Array.isArray(prs)) {
		return context;
	}
	return {
		...context,
		pullRequests: prs.map((item) => {
			if (item && typeof item === "object") {
				const { authorGithubId, ...rest } = item as Record<
					string,
					unknown
				>;
				return rest;
			}
			return item;
		}),
	};
}
