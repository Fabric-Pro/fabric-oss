/**
 * Preparation of user-supplied source text for the document create flow.
 *
 * The create dialog lets a user paste material that either becomes the document
 * (Use As-Is) or feeds the generation run (Use as Context). Both routes persist
 * that material as a project context row, and one of them hands it to a model in
 * the same request. Three separate obligations fall out of that, and they are
 * gathered here so no call site can satisfy two of them and forget the third:
 *
 *  1. **Neutralize before STORING, not only before delivering** (R30). The
 *     context row is read back raw by later generation runs — the retrieval path
 *     interpolates context into the prompt with no escaping of its own. Text
 *     that is sanitized only on its way to *this* run reopens the hole on the
 *     next one, months later, with no code change to blame.
 *  2. **Bound what reaches the model** (R29, KTD5). The generation path has no
 *     input-size guard at all today; the only budget in it governs output
 *     tokens. An unbounded paste exhausts the model's input window.
 *  3. **Deliver it inside the shared envelope** (KTD4). Retrieved context is
 *     interpolated into the generation prompt raw, so "treat supplied text like
 *     retrieved context" would mean no protection whatsoever.
 *
 * Nothing here is hand-rolled: the delimiter, the neutralizer, and the budget
 * all come from `@repo/utils/ai-chat-attachment`, whose forged-section pattern
 * already special-cases the exact `Retrieved Context` / `Reference N` headings
 * this prompt uses to delimit context. A second delimiter or a second budget
 * number defined here would be the "guard applied to one copy and not another"
 * failure CONCEPTS.md names directly.
 */

import { isEffectivelyBlank } from "@repo/utils";
import {
	type AiChatExtractionOutcome,
	applyAiChatTextBudget,
	buildAiChatAttachmentEntry,
	DEFAULT_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS,
	neutralizeAiChatAttachmentBody,
} from "@repo/utils/ai-chat-attachment";

/**
 * What the envelope calls this material.
 *
 * The shared builder renders it as `[Uploaded Document: <label>]`, so the label
 * has to read as a source name rather than a filename. Deliberately generic —
 * it is model-visible text and must never carry an organization, person, or
 * project name.
 */
export const SUPPLIED_SOURCE_LABEL = "Pasted source content";

/**
 * The largest paste the endpoint will accept at all.
 *
 * Distinct from `DEFAULT_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS`, and deliberately
 * an order of magnitude above it. The budget is a *shaping* rule: text over it
 * is truncated, stored truncated, and the user is told so. That is the designed
 * path for a long paste and must stay reachable — a ceiling at the budget would
 * turn every long paste into a rejection.
 *
 * This is the *transport* rule: the point past which the body is not worth
 * parsing. Nothing upstream bounds it — the App Router imposes no body limit on
 * a route handler, so without this the server fully materializes an arbitrarily
 * large string before the budget above ever gets to trim it.
 *
 * A million characters is roughly a 300-page book. No legitimate paste reaches
 * it; anything that does is not a user pasting source material.
 */
export const MAX_SUPPLIED_SOURCE_TEXT_CHARS = 1_000_000;

/**
 * Supplied text, prepared for both of its destinations.
 *
 * The three fields travel together on purpose, mirroring the reason
 * `applyAiChatTextBudget` returns `{ text, outcome }` rather than a bare string:
 *
 *  - `storedText` and `promptText` are the *same* material for two different
 *    consumers, and the whole point of R30 is that neither may be the only one
 *    that got neutralized. Returning one without the other is how a caller ends
 *    up storing raw text it happened to sanitize for the prompt.
 *  - `outcome` is the truncation signal. A caller handed only `promptText`
 *    cannot tell a complete paste from a cut one, so the user would be told
 *    their whole document was used when a third of it was dropped — and the
 *    model's copy carries the marker while the user's view does not. Both halves
 *    of that disclosure (R29) leave this function or neither does.
 */
export interface PreparedSuppliedText {
	/**
	 * Neutralized, unbounded — what the project context row stores.
	 *
	 * Deliberately NOT truncated. The bound exists to protect one model call's
	 * input window; the stored row is the user's own material and is chunked by
	 * the embedding pipeline rather than read in one piece. Truncating here
	 * would silently destroy pasted content that nothing ever asked to shorten.
	 */
	storedText: string;
	/**
	 * Neutralized, bounded, and wrapped in the shared attachment envelope —
	 * what the generation dispatch carries. Safe to hand to a prompt builder
	 * with no further escaping; the workflow that consumes it adds none.
	 */
	promptText: string;
	/** Whether the bound cut the text, and by how much. */
	outcome: AiChatExtractionOutcome;
}

export interface PrepareSuppliedTextOptions {
	/** Envelope label. Defaults to `SUPPLIED_SOURCE_LABEL`. */
	label?: string;
	/**
	 * Character budget for the model's copy. Defaults to the shared
	 * extracted-text budget — the same number the chat attachment path spends,
	 * deliberately not a second one that could drift from it (KTD5).
	 */
	budgetChars?: number;
}

/**
 * Whether supplied text is empty or whitespace-only (R19).
 *
 * Callers check this *before* any write. A blank paste is not merely useless: it
 * is the cheapest way around the blocked-empty-creation rule, and under Use
 * As-Is it would produce a document with no body and a context row with nothing
 * in it.
 */
export function isBlankSuppliedText(text: string | null | undefined): boolean {
	// Not a bare `.trim()`. That strips Unicode whitespace but leaves the
	// zero-width family standing, so a paste out of a web page or a word
	// processor can be non-empty to every length check and blank to every
	// reader. The shared guard exists because exactly that reached production
	// once already.
	return isEffectivelyBlank(text ?? "");
}

/**
 * Prepare one block of supplied text for storage and for this run's prompt.
 *
 * Order is load-bearing. Neutralization runs first, on the raw text, so the
 * *stored* copy is the neutralized one — the property R30 is about. The budget
 * then applies to already-neutralized text, which is safe because truncation
 * only removes characters and appends a marker; cutting text cannot conjure a
 * delimiter that was not already there.
 *
 * The envelope builder neutralizes its body again. That second pass is
 * deliberate rather than redundant: it is the single place the envelope is
 * constructed for every surface, and its mangling always moves *away* from the
 * real delimiter (an extra underscore), so applying it twice can only ever make
 * a forgery less delimiter-like. Skipping the first pass to avoid it would leave
 * the stored row raw, which is exactly the bug being closed.
 */
export function prepareSuppliedText(
	text: string,
	options: PrepareSuppliedTextOptions = {},
): PreparedSuppliedText {
	const storedText = neutralizeAiChatAttachmentBody(text);

	const budgeted = applyAiChatTextBudget(
		storedText,
		options.budgetChars ?? DEFAULT_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS,
	);

	return {
		storedText,
		promptText: buildAiChatAttachmentEntry(
			options.label ?? SUPPLIED_SOURCE_LABEL,
			budgeted.text,
		),
		outcome: budgeted.outcome,
	};
}
