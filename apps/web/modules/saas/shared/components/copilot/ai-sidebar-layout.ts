import { useEffect, useState } from "react";

/**
 * Shared layout helpers for pages that host the CopilotKit AI assistant
 * sidebar (`<CopilotSidebar>`).
 *
 * CopilotKit docks the assistant panel as a `position: fixed`, 28rem-wide
 * right rail at `@media (min-width: 640px)` (see @copilotkit/react-ui). Its
 * own content-wrapper margin is cancelled in globals.css
 * (`.copilotKitSidebarContentWrapper.sidebarExpanded { margin-right: 0 }`),
 * so each host page instead reserves space for the panel by shifting its
 * fixed page-chrome wrapper's right edge while the panel is expanded
 * (`AI_SIDEBAR_CONTENT_SHIFT_CLASS`, gated on `useAiSidebarExpanded`).
 *
 * The reservation breakpoint MUST match the breakpoint the panel docks at
 * (`sm` = 640px in Tailwind's default scale), not `md` (768px). When the two
 * disagree, the panel is docked but the editor still spans full width beneath
 * it for every viewport in the gap — the 640–767px overlap this fixes.
 * Centralising both the class and the detection here keeps the host pages from
 * drifting apart again.
 */
export const AI_SIDEBAR_CONTENT_SHIFT_CLASS = "sm:right-[28rem]";

/**
 * Tracks whether the CopilotKit assistant sidebar is currently docked-open, so
 * a host page's fixed page-chrome wrapper can reserve space for it via
 * `AI_SIDEBAR_CONTENT_SHIFT_CLASS`. Watches the document for CopilotKit
 * toggling the `sidebarExpanded` class on its content wrapper.
 *
 * Pass `defaultExpanded: true` on pages whose `<CopilotSidebar>` mounts with
 * `defaultOpen`, so the chrome is shifted from the first paint; the observer
 * self-corrects after mount if the panel is actually closed.
 */
export function useAiSidebarExpanded(defaultExpanded = false): boolean {
	const [isAiSidebarExpanded, setIsAiSidebarExpanded] =
		useState(defaultExpanded);
	useEffect(() => {
		// `globalThis.document` (not bare `document`) so the detection is
		// unaffected by any local `document` binding a caller may shadow it with.
		const doc = globalThis.document;
		if (typeof doc === "undefined") {
			return;
		}
		const sync = () => {
			const wrapper = doc.querySelector(
				".copilotKitSidebarContentWrapper",
			);
			setIsAiSidebarExpanded(
				!!wrapper?.classList.contains("sidebarExpanded"),
			);
		};
		sync();
		const observer = new MutationObserver(sync);
		observer.observe(doc.body, {
			subtree: true,
			attributes: true,
			attributeFilter: ["class"],
			childList: true,
		});
		return () => observer.disconnect();
	}, []);
	return isAiSidebarExpanded;
}
