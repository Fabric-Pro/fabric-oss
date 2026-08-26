/**
 * Readiness thresholds shared between the rule that grades a project and the
 * form that should have prevented the gap in the first place (Fizzy #2165).
 *
 * Deliberately import-free so a client component can use it without pulling a
 * server module into the browser bundle — the same reason
 * `knowledge-base-category.types.ts` sits apart from its procedure.
 *
 * One definition matters here: if the creation form and the checklist disagree
 * about what counts, a project passes creation and then immediately fails the
 * checklist for the same field.
 */

/**
 * The checklist spreadsheet's rule for a usable project description:
 * "Description is greater than 50 characters."
 *
 * A length rather than a boolean because a one-word description satisfies
 * "exists" while telling Fabric nothing, and this text is the first thing
 * document generation reads.
 */
export const MIN_DESCRIPTION_LENGTH = 50;
