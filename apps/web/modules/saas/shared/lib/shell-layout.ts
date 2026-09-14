/**
 * Geometry the app shell shares with the surfaces that must clear it.
 *
 * `NavBar` is the source of truth for the sidebar's width, and before this
 * module every surface that needed to clear it wrote the pixels out again by
 * hand. Four literals across two files drifted into two different encodings
 * with two different gutters, which is why the security banner and the AI dock
 * never lined up. The guard test in `__tests__/shell-layout.test.ts` reads
 * `NavBar.tsx` as source text and fails if these values stop matching it.
 *
 * The same drift, and the same remedy, are recorded in
 * `docs/solutions/ui-bugs/copilotkit-sidebar-editor-overlap.md`; this module is
 * the sibling of `@saas/shared/components/copilot/ai-sidebar-layout`.
 */

/** Sidebar widths as `NavBar` applies them at the `md` breakpoint and up. */
export const SIDEBAR_WIDTHS_PX = {
	collapsed: 72,
	expanded: 232,
} as const;

/**
 * Inward padding the floating dock uses instead of baking a gutter into its
 * offset. Named rather than inlined so the next reader can see 16px is a
 * choice, not a consequence of the sidebar width.
 */
export const SHELL_DOCK_GUTTER_CLASS = "px-4";

/**
 * Layer for the floating advisory dock.
 *
 * Named here, beside the widths, because it is a decision about the shell's
 * geometry rather than a detail of one component — and because inline it had
 * no test, so a revert to the `z-30` it used to carry (a tie with `NavBar`,
 * separated only by position and DOM order) would pass the whole suite.
 *
 * The band is 31-49: above the sidebar at 30, below every Radix surface at 50.
 * A literal, not a computed class — see the note on the offsets below.
 */
export const SHELL_DOCK_LAYER_CLASS = "z-40";

/**
 * Left margin that keeps the shell's content column clear of the sidebar.
 *
 * The width is a literal here rather than built from `SIDEBAR_WIDTHS_PX`, which
 * looks like the duplication this module exists to remove. It is not optional:
 * Tailwind scans source text for class candidates, and an interpolated
 * `md:ml-[...]` produces none, so the CSS would never be generated and the
 * offset would silently do nothing. This app has no safelist to fall back on.
 * The guard test is what keeps literal and constant in step instead.
 */
export function shellContentOffsetClass(isCollapsed: boolean): string {
	return isCollapsed ? "md:ml-[72px]" : "md:ml-[232px]";
}

/** Left edge that keeps a viewport-fixed shell surface clear of the sidebar. */
export function shellDockOffsetClass(isCollapsed: boolean): string {
	return isCollapsed ? "md:left-[72px]" : "md:left-[232px]";
}

/**
 * Routes that render their own `fixed inset-y-0` chrome over the whole
 * viewport, ignoring the content column's flow.
 *
 * Kept as an explicit list because there is no marker on the routes themselves
 * to detect: each one hand-writes its own `fixed inset-0` / `inset-y-0` chrome.
 * A route that grows such chrome has to be added here by hand.
 *
 * This is NOT the set `AppWrapper` calls `isFullHeightRoute` — that one covers
 * the workflow canvas, `/chatbot`, `/nexus` and kanban, which stay inside the
 * column and merely own their own scrolling. The two sets are disjoint and must
 * not be substituted for one another: an in-flow notice is fine on a
 * full-height route and invisible on a full-bleed one.
 */
const FULL_BLEED_ROUTE_PATTERNS = [
	/\/projects\/[^/]+\/documents\/[^/]+$/,
	/\/projects\/[^/]+\/stories\/[^/]+$/,
	/\/agents\/document-generator$/,
	/\/agents\/[^/]+\/try$/,
	/\/agents\/task-planner$/,
	/\/agents\/fabric-ai$/,
];

/**
 * True when the route paints viewport-fixed chrome that an in-flow shell
 * notice would render behind. Such a notice yields rather than competing —
 * it carries no z-index to compete with (see the layering section of
 * `docs/ui-style-guide.md`).
 */
export function isFullBleedRoute(pathname: string | null | undefined): boolean {
	if (!pathname) {
		return false;
	}

	return FULL_BLEED_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}
