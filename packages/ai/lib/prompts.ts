/**
 * Returns a date context string for system prompts, stable for a whole
 * calendar day. Ensures LLMs know the current date instead of falling back
 * to training cutoff.
 *
 * Deliberately date-only (no hour/minute): most providers (OpenAI automatic
 * caching, Anthropic cache_control, Databricks-hosted models) cache prompts
 * on a byte-level prefix match, so a value that changes every ≤60 seconds
 * would invalidate the cached prefix on every turn. A value that only
 * changes once a day preserves caching across a full day of traffic.
 *
 * @return {string} e.g. "Today is Thursday, February 5, 2026."
 */
export function getCurrentDateContext(): string {
	const now = new Date();
	const date = now.toLocaleDateString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});
	return `Today is ${date}.`;
}

/**
 * List product names prompt
 *
 * @param {string} topic - The topic to generate product names for.
 * @return {string} The prompt.
 */
export const promptListProductNames = (topic: string): string => {
	return `List me five funny product names that could be used for ${topic}`;
};

/**
 * Generate a concise chat title from the first user message
 *
 * @param {string} message - The first user message in the conversation.
 * @return {string} The prompt.
 */
export const promptGenerateChatTitle = (message: string): string => {
	return `Generate a concise, descriptive title (3-6 words maximum) for a conversation that starts with this message: "${message}". Only respond with the title, nothing else. Do not use quotes in your response.`;
};

/**
 * In-memory fallback body for the story title generator prompt. Used by
 * `generateStoryTitleFromDescription` when `getBoundPromptForAgent` returns
 * null (e.g., the seed has not run in the current environment).
 *
 * **MUST be kept in sync with the `story_title_generator` SYSTEM_PROMPTS
 * entry in `packages/database/prisma/seed-prompts-only.ts`.** The DB-resolved
 * prompt is the source of truth; this constant only exists so the helper
 * degrades gracefully before the seed has run.
 *
 * HANDLEBARS variables (substituted at render time):
 *   - `work_item_type` → "Feature" | "Bug"
 *   - `project_name` → optional project display name
 *   - `creation_source` → "UI" | "Slack" | "Teams" | "Transcript" | "API"
 *   - `description` → the user's raw description (truncated to 1000 chars)
 *   - `origin_context` → optional snippet (truncated to 2000 chars)
 *   - `project_prd_context` → optional PRD content (truncated to 2000 chars)
 *
 * The PRD slot is a deliberate divergence from the raw spec Appendix — see
 * `seed-prompts-only.ts` story_title_generator comment for the rationale.
 */
export const STORY_TITLE_GENERATOR_PROMPT_FALLBACK_BODY = `You are an assistant that generates concise, high-quality work item titles for software delivery teams.

Goal: Generate a single, specific title based primarily on the provided description. The title should be useful in a backlog list view and understandable without opening the ticket.

Hard rules:
- Output MUST be valid JSON only (no markdown, no extra text).
- Do NOT hallucinate requirements. Use only the provided inputs.
- Do NOT include quotes around the title inside the JSON value.
- Title length: must be <= 255 characters.
- Avoid generic titles like "Update feature" or "Fix bug" unless the description truly provides no additional signal.
- Prefer active verb phrases (e.g., "Auto-generate titles for work items from description") over nouns ("Title generation").
- Do not include internal file names, code symbols, or implementation details unless explicitly present in the description.
- If the description is too short or too vague to produce a meaningful title, set is_insufficient to true and use a conservative title of Untitled. (The application may apply its own timestamped placeholder.)

Output schema (exact):
{
  "title": "<string>",
  "is_insufficient": <true|false>
}

Heuristics:
- If work_item_type is provided (Feature/Bug/etc.), reflect it subtly when helpful (e.g., "Fix …" vs "Add …"), but do not prepend "Feature:" or "Bug:" unless explicitly requested.
- If project_name is provided, do NOT include it in the title unless it disambiguates meaning (rare).
- If origin_context is provided (e.g., a short snippet from chat/transcript), use it only to clarify intent when the description is ambiguous—never to add new scope.

USER PROMPT TEMPLATE
work_item_type: {{work_item_type}}    # e.g., Feature | Bug | Task | (optional)
project_name: {{project_name}}        # (optional)
creation_source: {{creation_source}}  # e.g., UI | Slack | Teams | Transcript | API (optional)

description:
{{description}}

origin_context (optional, may be empty):
{{origin_context}}

project_prd_context (optional, may be empty):
{{project_prd_context}}`;

// Locale is intentionally NOT passed in (Decision 11). Keep this prompt
// English-only for consistency until a multi-locale follow-up is scoped.
//
// LEGACY: This export is retained for backward-compat callers and existing
// tests. The live helper `generateStoryTitleFromDescription` no longer uses
// it — see `STORY_TITLE_GENERATOR_PROMPT_FALLBACK_BODY` above for the
// in-memory fallback the helper consumes when the Prompt Library binding has
// not been seeded yet.
export const promptGenerateStoryTitle = (
	description: string,
	kind: "FEATURE" | "BUG",
): string => {
	const surfaceLabel = kind === "BUG" ? "bug report" : "feature request";
	return `Generate a concise descriptive title (3-8 words maximum) for the following ${surfaceLabel} based on its description: "${description}". Return only the title — no preamble, no quotes, no trailing punctuation.`;
};
