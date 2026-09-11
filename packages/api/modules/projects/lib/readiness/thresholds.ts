/**
 * Readiness constants shared between the rules that grade a project, the
 * procedures that serve them, and the client surfaces that render them
 * (Fizzy #2165).
 *
 * Deliberately import-free so a client component can use it without pulling a
 * server module into the browser bundle — the same reason
 * `knowledge-base-category.types.ts` sits apart from its procedure. Nothing
 * here may acquire an import; that property is what lets the panel and the
 * creation form read the same values as the resolver.
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

/**
 * The readiness row the CLI-connection nudge adds (Fizzy #2457).
 *
 * One declaration, four readers: it is the rule's own `key` in the registry,
 * the row both readiness procedures special-case, and the row the panel gives
 * its own in-place action to. Each of those held its own string literal, which
 * is four chances for one of them to be edited alone — and a mismatch is
 * silent, because every reader simply stops matching a row that still exists.
 *
 * Here rather than beside the rule for the reason this whole file exists: the
 * panel is a client component, and the registry is not something a browser
 * bundle should have to pull in to learn one string.
 */
export const CLI_ITEM_KEY = "api-key-for-cli";
