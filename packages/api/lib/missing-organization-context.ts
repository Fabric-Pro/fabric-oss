/**
 * The machine-readable cause of a refusal raised because the request resolved
 * no workspace (Fizzy #2403, R7).
 *
 * Three sites refuse a caller whose request carries no organization, and all
 * three say it with the same sentence. A client that wants to explain the cause
 * — or offer the way out of it — had no way to tell that refusal from any other
 * FORBIDDEN except by matching on that sentence, which stops working the moment
 * the wording is improved. They now carry this code in the error's `data`
 * payload, and the sentence stays exactly what it was.
 *
 * The value is declared once, here, so a fourth emitter cannot invent its own
 * spelling of it.
 *
 * THE SENTENCE IS DELIBERATELY NOT A SIBLING CONSTANT, and the asymmetry with
 * the code is the point rather than an oversight. A test in
 * `modules/prompts/__tests__/deletion-impact-authorization.test.ts` finds every
 * emitter by scanning `packages/api` sources for that literal, and asserts the
 * set is exactly the known gates. Centralising the sentence would leave the
 * literal in one file — this one — so the scan would report the constant's own
 * definition instead of the call sites, and the obvious way to make it pass
 * again is to teach it the new shape. A scan taught to look for an import
 * cannot catch the thing it exists to catch: somebody retyping the sentence by
 * hand at a fourth site. Leave the literal spelled out at each gate.
 *
 * `errorCode` is the shape, following `COVERAGE_BELOW_TARGET` in
 * `modules/projects/procedures/stories/update-story.ts`. The repo carries two
 * conventions for structured refusal payloads and this is the discriminant one:
 * `data.reason` (as in `modules/projects/procedures/diagrams/create-from-chat.ts`)
 * is free-text diagnostic detail sitting beside other diagnostic fields, whereas
 * `data.errorCode` is the "which refusal is this" branch key — and it is already
 * the one `apps/web` reads defensively, in
 * `modules/saas/projects/lib/stories/types.ts`.
 *
 * On vocabulary: the code says `ORGANIZATION` because that is the backend's word
 * for the tenant, the same way the model is `UserStory` while the UI says
 * Feature. Anything user-facing built on this marker says "workspace".
 *
 * Deliberately import-free, so a client component can recognise the marker
 * without dragging a server module into the browser bundle — the same reason
 * `modules/projects/procedures/contexts/knowledge-base-category.types.ts` sits
 * apart from the procedure that validates against it.
 */
export const MISSING_ORGANIZATION_CONTEXT_ERROR_CODE =
	"MISSING_ORGANIZATION_CONTEXT";
