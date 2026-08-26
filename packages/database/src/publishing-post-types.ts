/**
 * Publishing post-type vocabulary and preference bounds — CLIENT-SAFE.
 *
 * Deliberately free of value imports. Its only Prisma reference is `import
 * type`, which the compiler erases, so a browser bundle can deep-import this
 * module (`@repo/database/src/publishing-post-types`) without dragging the
 * generated Prisma client in behind it. This is the same shape as
 * `function-tags.ts`, which `PublishingSuiteList.tsx` already imports that way.
 *
 * It exists because the alternative was a fourth hand-written copy of the same
 * four values. `PostTypesDialog.tsx` and `PublishingSuiteList.tsx` each already
 * carry their own `{ value, label }` array; the settings form would have made
 * three, and the numbers below would have made three more. Those two existing
 * copies are left alone — moving them is not this slice's business — but from
 * here on there is one place to move them TO.
 */

import type { PublishingTopicPostType } from "../prisma/client";

/**
 * The four post types, as value + human label together.
 *
 * One array rather than a values tuple beside a label map, because every
 * consumer so far needs both: the API validates the value, the form renders the
 * label, the prompt clause writes the label. Splitting them is what lets one
 * drift from the other.
 */
export const PUBLISHING_POST_TYPE_OPTIONS = [
	{ value: "TWEET", label: "Tweet" },
	{ value: "BLOG_POST", label: "Blog Post" },
	{ value: "CASE_STUDY", label: "Case Study" },
	{ value: "STAKEHOLDER_EMAIL", label: "Stakeholder Email" },
] as const satisfies readonly {
	value: PublishingTopicPostType;
	label: string;
}[];

/**
 * Just the values, as a tuple — `z.enum()` needs a tuple type, and a caller
 * building a schema at MODULE LOAD cannot wait for anything lazier.
 */
export const PUBLISHING_TOPIC_POST_TYPES = [
	"TWEET",
	"BLOG_POST",
	"CASE_STUDY",
	"STAKEHOLDER_EMAIL",
] as const satisfies readonly PublishingTopicPostType[];

/**
 * The four values as a UNION — what the oRPC boundary accepts, and therefore
 * what any caller writing this field has to be holding.
 *
 * Exported because the alternative at the form was `as string[]`, and a
 * WIDENING assertion is the dangerous direction. It silences nothing where it
 * is written — `string[]` looks like the harmless general case — and surfaces
 * the error at the WRITE site instead, where the union is demanded again. Both
 * ends already know the narrow type; naming it is what stops the middle from
 * throwing it away.
 */
export type PublishingPostTypeValue =
	(typeof PUBLISHING_TOPIC_POST_TYPES)[number];

/**
 * Bounds for `preferredThemes` — the one FREE-FORM preference list.
 *
 * Exported so the oRPC boundary and the settings form read the SAME numbers. A
 * limit written as a literal in a Zod schema and again as a form's `maxLength`
 * is a limit that will disagree with itself the first time one of them is
 * tuned.
 *
 * Bounded per ITEM as well as per list: one very long "theme" bloats a
 * generation prompt as effectively as a hundred short ones, and only the
 * per-list cap would notice the second.
 *
 * `preferredPostTypes` is deliberately NOT governed by these. It is a closed
 * enum, so its vocabulary and its size both come from the enum itself — a cap
 * of 25 on a four-value set is a limit that can never fire, which reads to a
 * later editor as a limit nobody thought about.
 */
export const MAX_PUBLISHING_PREFERENCE_ITEMS = 25;
export const MAX_PUBLISHING_PREFERENCE_ITEM_LENGTH = 60;

/**
 * Bound for `strategicPriorities`, the free-text field. Generous because line
 * structure is meaningful here and a few short paragraphs are the expected
 * shape, but finite because this string is copied into every generation prompt
 * for the project.
 */
export const MAX_PUBLISHING_STRATEGIC_PRIORITIES_LENGTH = 2000;

/**
 * Trim and collapse inner whitespace runs, PRESERVING case. Non-strings become
 * "".
 *
 * The label form, for lists whose consumer is the PROMPT. "API" and "api" reach
 * the model as different words, so folding them would report "unchanged" for an
 * edit that genuinely changes the instruction — and the run under the new
 * guidance would never happen.
 *
 * LIVES HERE, beside the bounds, for exactly the reason the bounds do: three
 * places apply this rule and one of them is a browser bundle. The settings form
 * must reject the same strings the write boundary rejects, and both must agree
 * with the snapshot the prompt is built from. Defining it in
 * `publishing-preferences.ts` would put it behind that module's `node:crypto`
 * import and force the form to hand-copy it — which is the very divergence this
 * function exists to end.
 *
 * ORDER MATTERS at every call site: normalize FIRST, then bound. A value that is
 * over the cap only because of a whitespace run is under it once collapsed, and
 * the model never sees the run — so bounding first rejects a theme that is, as
 * far as the prompt is concerned, perfectly legal.
 */
export function normalizePreferenceLabel(value: unknown): string {
	return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}
