/**
 * The notice the Direct chat adds under a reply that claims an action no tool
 * call backs (`completion-claim-notice.ts` in `@repo/temporal`). It is said to
 * the user about the reply, so it belongs to the chat, not to the reply's
 * content: a surface that takes the reply as content, such as "Apply to
 * document", leaves it out.
 *
 * Lives in `@repo/utils` so the activity that adds the notice and the browser
 * code that leaves it out share one definition.
 */

/**
 * Shown under a reply that claims an action no tool call backs. Product copy,
 * not model instructions: it tells the user what did not happen.
 */
export const UNBACKED_CLAIM_NOTICE =
	"_Note: no tool ran while this reply was written, so nothing it describes was created, scheduled, run or changed just now, and nothing was checked. Ask again to have it done._";

/** The reply as the assistant wrote it, without the notice added under it. */
export function withoutUnbackedClaimNotice(reply: string): string {
	const trimmed = reply.trimEnd();
	if (!trimmed.endsWith(UNBACKED_CLAIM_NOTICE)) {
		return reply;
	}
	return trimmed.slice(0, -UNBACKED_CLAIM_NOTICE.length).trimEnd();
}
