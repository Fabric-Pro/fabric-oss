/**
 * The working-draft body a person actually edits for a Stakeholder Email
 * (Fizzy #1854, Phase 2C slice 2).
 *
 * A module in the shared leaf package rather than a function inside the Temporal
 * activity that first calls it, for the same measured reason its Case Study
 * sibling is: two packages compose this text and they must produce it
 * byte-for-byte identically. `@repo/temporal` seeds the draft when a generation
 * succeeds (`generate-stakeholder-email.ts`), and `@repo/api` re-composes it
 * when a stored version is adopted (`publishing-suite/stakeholder-email.ts`).
 * Both already declare `@repo/utils` as a dependency, so sharing costs nothing.
 *
 * The alternative shape is in the repository and its history is the argument
 * against it: the Blog Post family duplicates its `composeWorkingDraftBody` into
 * the API layer, justified by a doc comment claiming a parity test that did not
 * exist — for two releases the copies agreed only by coincidence between
 * hardcoded literals. #1854 backfilled that test, so the duplication is pinned
 * now rather than merely asserted. One shared function makes the drift
 * impossible instead of catching it after someone writes a guard.
 */

/**
 * Compose the Markdown a reader actually edits from a stored stakeholder email.
 *
 * The headings are the PO's own — "## Subject" and "## Email Draft" from the
 * v1.1 prompt's output skeleton. That is the point of them: the structured
 * output splits the email into fields so the panel can render a subject line
 * separately and keep the publishing advice out of the editor, but a reader who
 * copies this draft still gets the shape the PO specified, with the subject
 * labelled rather than guessable from the first line.
 *
 * The subject has to be IN the editable text, not only above it. A stakeholder
 * email whose draft carries the body alone loses the subject the moment it is
 * copied into a mail client — which is what happens to every one of these
 * drafts — and retyping a subject the model already wrote is the friction that
 * makes people stop regenerating.
 *
 * `audience`, `releaseStatus`, `inputsNeeded` and `safetyNote` are deliberately
 * absent: they are advice ABOUT the draft, and a draft containing them is a
 * draft whose author deletes four sections before sending. They are rendered
 * beside the editor instead, and carried into the export as caveats.
 *
 * Both halves are trimmed. A model that emits a leading newline in `body`, or a
 * caller that stores a subject with trailing whitespace, would otherwise produce
 * text that differs from the same document composed elsewhere — which is the
 * exact class of divergence this shared function exists to rule out.
 */
export function composeStakeholderEmailWorkingDraftBody(doc: {
	subject: string;
	body: string;
}): string {
	return `## Subject\n\n${doc.subject.trim()}\n\n## Email Draft\n\n${doc.body.trim()}`;
}
