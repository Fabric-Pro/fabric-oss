/**
 * The default instructions for the bug report the recurring-error scan files
 * when an application error, or a cluster of open bug reports, keeps
 * recurring.
 *
 * Lives in `@repo/utils` for the same reason the page-ask prompt does: it is a
 * leaf package both `@repo/database` (the seed) and `@repo/temporal` (the
 * activity that resolves the binding) already depend on, so the two share ONE
 * definition instead of two copies a test has to keep byte-identical.
 */

/**
 * Prompt Library agent key for the editable recurring-error bug report.
 *
 * Defined once and imported by every site that needs it — the seed's SYSTEM
 * prompt and binding, the catalog's agent target, and the activity. A mismatch
 * between any two of them resolves no binding and falls back to the default
 * body forever, silently.
 */
export const RECURRING_ERROR_BUG_PROMPT_AGENT_KEY =
	"recurring_error_bug_reporter";

/**
 * The default recurring-error bug-report instructions, as an organization may
 * edit them.
 *
 * Variables, passed by the activity (render with `escape: false`):
 * `source_is_logs` / `source_is_incidents` (booleans), `occurrence_count`,
 * `window_hours`, `affected_users`, `components`, `first_seen`, `last_seen`,
 * `exception_type`.
 *
 * What stays in code is how the evidence itself — redacted log samples or the
 * titles of the bug reports in a cluster — is fenced as untrusted data, and
 * the structured output contract (title, description, priority). An edit here
 * retunes the voice and the report layout but cannot teach the model to follow
 * what a log line or a bug report says.
 *
 * INSERT-ONLY once seeded: changing this text does nothing on an environment
 * that has already run the seed. Ship wording changes as an explicit UPDATE
 * migration.
 */
export const RECURRING_ERROR_BUG_FALLBACK_BODY = `You write a bug report for an engineering team's backlog in Fabric. The problem was found automatically, not reported by a person, and a reviewer will read your report before it becomes a work item.
{{#if source_is_logs}}
The evidence is a group of application errors that recurred {{occurrence_count}} times in the last {{window_hours}} hours.{{#if exception_type}} The exception type is {{exception_type}}.{{/if}}{{#if components}} It was emitted by: {{components}}.{{/if}}{{#if affected_users}} It affected {{affected_users}} distinct users.{{/if}} First seen {{first_seen}}, last seen {{last_seen}}. Redacted sample messages follow.
{{/if}}
{{#if source_is_incidents}}
The evidence is {{occurrence_count}} open bug reports that a duplicate check judged to describe the same problem. Their identifiers and titles follow. Write ONE report that consolidates them and names each source report by its identifier.
{{/if}}

Write:
- title: a specific, imperative title of at most 100 characters that names the failing behaviour, not the log wording. No identifiers, ids or numbers that vary between occurrences.
- description: Markdown with the sections "Summary", "Impact", "Evidence" and "Suggested next steps". Keep the frequency, the time window, the affected components and users, and the first and last seen times in "Evidence". Quote at most two sample lines, shortened. Never reconstruct a value shown as [REDACTED].
- priority: P0_CRITICAL, P1_HIGH, P2_MEDIUM or P3_LOW, judged from frequency and impact. Use P0_CRITICAL only when the evidence shows a widespread outage.

State only what the evidence supports. When it is not enough to know the cause, say so and suggest how to find out.`;
