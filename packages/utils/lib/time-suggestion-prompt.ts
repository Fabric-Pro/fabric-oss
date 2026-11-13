/**
 * The default instructions for describing a member's suggested time entries.
 *
 * Lives in `@repo/utils` for the same reason the recurring-error prompt does:
 * it is a leaf package both `@repo/database` (the seed) and `@repo/temporal`
 * (the activity that resolves the binding) already depend on, so the two
 * share ONE definition.
 */

/**
 * Prompt Library agent key for the editable time-suggestion drafter.
 *
 * Defined once and imported by every site that needs it: the seed's SYSTEM
 * prompt and binding, the catalog's agent target, and the activity. A
 * mismatch between any two of them resolves no binding and falls back to the
 * default body forever, silently.
 */
export const TIME_SUGGESTION_PROMPT_AGENT_KEY = "time_suggestion_drafter";

/**
 * The default time-suggestion instructions, as an organization may edit them.
 *
 * Variables, passed by the activity (render with `escape: false`):
 * `group_count`, and `activities`, the activity values the model may choose
 * from with their labels.
 *
 * What stays in code is how the evidence itself (project names, work item
 * titles, counts and times) is fenced as untrusted data, and the structured
 * output contract. The model only words a description and picks an activity:
 * the duration, the project, the work item and the billable flag come from
 * the evidence and the member, never from the model. An edit here retunes
 * the wording but cannot change that.
 *
 * INSERT-ONLY once seeded: changing this text does nothing on an environment
 * that has already run the seed. Ship wording changes as an explicit UPDATE
 * migration.
 */
export const TIME_SUGGESTION_FALLBACK_BODY = `You describe blocks of time a member of a software team may want to log in their timesheet. Each block was found in their own activity in Fabric, and they will review every description before it is saved.

There are {{group_count}} blocks. For each one the evidence gives the project, the work item if there is one, what kind of activity was seen, how often and at what times.

For every block, write:
- group: the block's number, exactly as given.
- description: one plain sentence of at most 200 characters saying what the member worked on, as they would write it in a timesheet. Use the work item and project names when they help. Do not name other people. Do not invent work the evidence does not show, and do not state a duration. Describe what the evidence shows was worked on. Never say that a meeting was attended, that work was completed, merged, shipped or fixed, or state any other outcome, unless the evidence itself says so.
- activity: the one value from this list that best fits the block:
{{activities}}

Return one entry per block, in the order given.`;
