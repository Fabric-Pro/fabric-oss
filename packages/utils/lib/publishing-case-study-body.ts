/**
 * The working-draft body a person actually edits for a Case Study (Fizzy #1854,
 * Phase 2C).
 *
 * Deliberately a module in the shared leaf package rather than a function inside
 * the Temporal activity that first calls it, because two packages compose this
 * text and they must produce it byte-for-byte identically: `@repo/temporal`
 * seeds the draft when a generation succeeds (`generate-case-study.ts`), and
 * `@repo/api` re-composes it when a stored version is adopted
 * (`publishing-suite/case-study.ts`). Both already declare `@repo/utils` as a
 * dependency (`packages/api/package.json`, `packages/temporal/package.json`), so
 * sharing costs nothing.
 *
 * This is the correction of a real defect in the Blog Post sibling, and the
 * reason it is written down here rather than repeated. That one duplicates its
 * `composeWorkingDraftBody` into
 * `packages/api/modules/projects/procedures/publishing-suite/blog-post.ts`
 * (`readBlogBody`), and was justified by a doc comment making two claims that
 * were false when it was written. Both have since been dealt with, so read what
 * follows as history rather than as a live warning:
 *
 *  1. "The pairing is pinned by a test asserting both produce the same text for
 *     the same document." No such test existed — for two releases the copies
 *     agreed only by coincidence between hardcoded literals. THIS SAME COMMIT
 *     backfilled it: `blog-post.test.ts` now imports `composeWorkingDraftBody`
 *     from `@repo/temporal` and asserts the adopted body equals what the
 *     Temporal seed composes. The copies are pinned now; the duplication is
 *     still there, but it can no longer drift silently.
 *  2. "That function lives in `@repo/temporal`, which the API package does not
 *     and should not depend on for a string join." The first half was false —
 *     `packages/api/package.json` declares `"@repo/temporal": "workspace:*"` —
 *     and that comment has been corrected in place: the real reason to keep the
 *     copy is bundling (pulling a whole activity module in for a string join),
 *     not layering.
 *
 * The lesson survives its own fix. A duplicated rule with nothing checking the
 * copies is how the seeded draft and the adopted one silently stop matching, and
 * a parity test only catches the drift after someone writes one. One shared
 * function makes the drift impossible instead, which is why the case study skips
 * the duplication rather than pairing it with a guard.
 */

/**
 * Compose the Markdown a reader actually edits from a stored case study.
 *
 * The title is a separate FIELD in the document — that is what lets the panel
 * show a title without parsing Markdown — but it is part of the case study, so
 * the editable body has to carry it or the first thing every author does is
 * retype the headline. The publishing suggestions (supporting assets, suggested
 * categories, suggested keywords, inputs needed) are the opposite case and are
 * deliberately absent: they are advice about the draft, and a draft that
 * contains them is a draft whose author deletes four sections after every
 * regeneration.
 *
 * Both halves are trimmed. A model that emits a leading newline in `body`, or a
 * caller that stores a title with trailing whitespace, would otherwise produce
 * text that differs from the same document composed elsewhere — which is the
 * exact class of divergence this shared function exists to rule out.
 *
 * No subtitle, unlike the Blog Post document: the case study's opening is its
 * Executive Summary section, inside the body.
 */
export function composeCaseStudyWorkingDraftBody(doc: {
	title: string;
	body: string;
}): string {
	return `# ${doc.title.trim()}\n\n${doc.body.trim()}`;
}
