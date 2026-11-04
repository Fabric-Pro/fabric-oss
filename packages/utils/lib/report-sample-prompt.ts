/**
 * The default instructions for the sample preview a report template shows
 * before it has ever produced a real report.
 *
 * Lives in `@repo/utils` for the same reason the page-ask prompt does: it is a
 * leaf package both `@repo/database` (the seed) and `@repo/api` (the procedure
 * that resolves the binding) already depend on, so the two share ONE
 * definition instead of two copies a test has to keep byte-identical.
 */

/**
 * Prompt Library agent key for the editable report sample preview.
 *
 * Defined once and imported by every site that needs it — the seed's SYSTEM
 * prompt and binding, the catalog's agent target, and the procedure. A
 * mismatch between any two of them resolves no binding and falls back to the
 * default body forever, silently.
 */
export const REPORT_SAMPLE_PROMPT_AGENT_KEY = "report_sample_preview";

/**
 * The default sample-preview instructions, as an organization may edit them.
 *
 * Variables, passed by the procedure (render with `escape: false`):
 * `template_name`, `template_description`, `template_category`,
 * `output_format`, `report_instructions`, `section_titles`, `data_sources`.
 * All but `template_name` may be empty.
 *
 * The output is shown to the person choosing a template, labelled as sample
 * data by the screen, never stored as a report and never sent anywhere.
 *
 * INSERT-ONLY once seeded: changing this text does nothing on an environment
 * that has already run the seed. Ship wording changes as an explicit UPDATE
 * migration.
 */
export const REPORT_SAMPLE_FALLBACK_BODY = `You write a short sample of a report so that a person can see what a report template produces before they connect any data. Nothing you write is real: invent plausible, clearly generic example data (example work items, people named "Alex" or "Sam", round numbers) and never use a real company, product or person.

The template is "{{template_name}}".
{{#if template_description}}
What it is for: {{template_description}}
{{/if}}
{{#if template_category}}
Category: {{template_category}}
{{/if}}
{{#if data_sources}}
A real report reads from: {{data_sources}}.
{{/if}}
{{#if section_titles}}
Use these sections, in this order: {{section_titles}}.
{{/if}}
{{#if report_instructions}}
The template's own instructions for a real report, which the sample should follow in structure and tone:
{{report_instructions}}
{{/if}}

Write the sample as Markdown{{#if output_format}} (the real report is delivered as {{output_format}}){{/if}}. Start with a level-one heading that names the report. Keep it under 400 words, use at most one small table, and end without a closing summary of what you wrote. Do not mention that you are an AI, and do not add a disclaimer; the screen labels the sample.`;
