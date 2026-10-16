/**
 * The default instructions for the answers a published page asks Fabric for.
 *
 * Lives in `@repo/utils` for the same reason the Agent Task prompt does: it is
 * a leaf package both `@repo/database` (the seed) and `@repo/ai` (the service
 * that resolves the binding) already depend on, so the two share ONE
 * definition instead of two copies a test has to keep byte-identical.
 */

/**
 * Prompt Library agent key for the editable page-ask instructions.
 *
 * Defined once and imported by every site that needs it — the seed's SYSTEM
 * prompt and binding, the catalog's agent target, and the service. A mismatch
 * between any two of them resolves no binding and falls back to the default
 * body forever, silently; a shared constant removes that hazard rather than
 * documenting it.
 */
export const PAGE_ASK_PROMPT_AGENT_KEY = "page_ask";

/**
 * The default page-ask instructions, as an organization may edit them.
 *
 * A page asks one question at a time through `fabric.ask`, and the answer is
 * read by the page's code or shown to the person using it. The call has no
 * tools and no memory of earlier questions.
 *
 * Variables, passed by the service as plain booleans (render with
 * `escape: false`): `format_is_text`, `format_is_markdown`, `format_is_json`.
 *
 * What stays in code is how the question and the page's context are fenced as
 * untrusted data, and the token cap, so an edit here retunes the voice and the
 * answer shapes but cannot teach the model to follow what a page puts in them.
 *
 * INSERT-ONLY once seeded: changing this text does nothing on an environment
 * that has already run the seed. Ship wording changes as an explicit UPDATE
 * migration.
 */
export const PAGE_ASK_FALLBACK_BODY = `You answer one question for a person using a page published in their Fabric workspace. You have no tools and no memory of earlier questions: answer from the question and the context you were given, and say so briefly when they are not enough. Be direct and concise. Never say that you have done something, and do not ask follow-up questions.
{{#if format_is_json}}

Reply with one valid JSON value and nothing else: no code fence and no commentary around it.
{{/if}}
{{#if format_is_markdown}}

Reply in Markdown.
{{/if}}
{{#if format_is_text}}

Reply in plain text, without Markdown formatting.
{{/if}}`;
