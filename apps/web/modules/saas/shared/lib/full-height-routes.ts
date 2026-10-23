/**
 * Routes whose page fills the window and scrolls inside itself, so the app
 * shell drops its padding and fixes its height to the viewport.
 */

/**
 * The workflow editor: `/app/workflows/{id}` and the organization route
 * `/app/{organizationSlug}/workflows/{id}`. The list, `new` and `integrations`
 * pages scroll normally.
 */
export function isWorkflowCanvasPath(pathname: string): boolean {
	const match = pathname.match(/^\/app\/(?:[^/]+\/)?workflows\/([^/]+)$/);
	return match !== null && match[1] !== "new" && match[1] !== "integrations";
}

/** Every route that takes the full-height shell. */
export function isFullHeightPath(pathname: string): boolean {
	return (
		isWorkflowCanvasPath(pathname) ||
		pathname.endsWith("/chatbot") ||
		pathname.endsWith("/nexus") ||
		/\/kanban(\/|\?|$)/.test(pathname)
	);
}
