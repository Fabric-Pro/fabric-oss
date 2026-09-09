/**
 * Where a social feed folds a post behind "see more" (Fizzy #1853, #1851).
 *
 * Extracted from `ShortPostPanel` when `LinkedInPostPanel` became its second
 * consumer. The constant was written for LinkedIn's behaviour in the first
 * place — the short post's preview borrowed it to make a general point about
 * length — so a second copy would have been two numbers describing one platform,
 * which is how they start disagreeing.
 *
 * Deliberately NOT parameterised per post type. A fold estimate that varied by
 * tab would be claiming a precision nobody has (see below), and the moment the
 * two numbers differ a reader comparing a tweet against a LinkedIn draft is
 * comparing two different rulers.
 */

/**
 * Roughly where a feed folds a post behind "see more".
 *
 * AN ESTIMATE, TO BE TUNED — not a specification, and not any one platform's
 * published limit. The real fold moves with the network, the viewport and
 * whether the reader is on a phone: LinkedIn cuts around 140 characters on
 * mobile and rather more on desktop, and the others all differ again. 200 is a
 * working middle that makes the point the preview exists to make — that the
 * opening line carries the post — without claiming a precision nobody has.
 * Change it when there is a measurement to change it to.
 */
export const FEED_FOLD_ESTIMATE = 200;

/**
 * How far back the fold may snap to avoid dimming half a word.
 *
 * Small: a post whose first 200 characters hold no space at all is one long
 * token, and cutting it at the last space 90 characters earlier would misstate
 * the fold badly enough to be worse than cutting mid-word.
 */
const FOLD_SNAP_WINDOW = 40;

/**
 * Split a post where a feed would fold it.
 *
 * Keyed on `text.length`, NEVER on `estimatedCharacters`. That field is the
 * model's own count with a length fallback, so a low estimate would hide the
 * indicator on a post that visibly runs past the fold — the one case the
 * indicator exists for.
 *
 * The two halves are slices around a single index and always concatenate back
 * to the original. Consuming the boundary space to make the split look tidier
 * would silently drop a character out of the text a reader is about to publish.
 */
export function splitAtFeedFold(text: string): {
	visible: string;
	folded: string;
} {
	if (text.length <= FEED_FOLD_ESTIMATE) {
		return { visible: text, folded: "" };
	}
	const lastSpace = text.lastIndexOf(" ", FEED_FOLD_ESTIMATE);
	const cut =
		lastSpace >= FEED_FOLD_ESTIMATE - FOLD_SNAP_WINDOW
			? lastSpace
			: FEED_FOLD_ESTIMATE;
	return { visible: text.slice(0, cut), folded: text.slice(cut) };
}
