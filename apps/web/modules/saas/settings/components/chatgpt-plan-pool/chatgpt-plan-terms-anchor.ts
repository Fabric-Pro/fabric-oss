/** The id of the pooling terms block on AI Models, for links that lead to it. */
export const CHATGPT_PLAN_TERMS_ANCHOR = "chatgpt-plan-terms";

/**
 * A ref for the terms block: brings it into view when the page was opened at
 * its anchor. The browser's own jump to the hash happens on navigation, before
 * the block exists — it renders only once the policy has loaded — so the block
 * scrolls itself there as it mounts.
 */
export function scrollToTermsWhenTargeted(node: HTMLElement | null): void {
	if (
		!node ||
		typeof window === "undefined" ||
		window.location.hash !== `#${CHATGPT_PLAN_TERMS_ANCHOR}`
	) {
		return;
	}
	const reduceMotion =
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	node.scrollIntoView?.({
		behavior: reduceMotion ? "auto" : "smooth",
		block: "start",
	});
}
