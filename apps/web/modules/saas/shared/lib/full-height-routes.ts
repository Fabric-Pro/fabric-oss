/**
 * Routes whose page fills the window and scrolls inside itself, so the app
 * shell drops its padding and fixes its height to the viewport.
 */

/** Both entry points use the same full-height organization workflow studio. */
export function isWorkflowCanvasPath(pathname: string): boolean {
	const match = pathname.match(
		/^\/app\/(?:[^/]+\/)?workflows(?:\/([^/]+))?$/,
	);
	return match !== null && match[1] !== "new" && match[1] !== "integrations";
}

/** Organization agent authoring owns its viewport, with independent editor/chat panes. */
export function isAgentBuilderPath(pathname: string): boolean {
	return /^\/app\/[^/]+\/(?:agents\/(?:create|[^/]+\/(?:edit|duplicate))|agent-templates\/(?:[^/]+\/create|agents\/[^/]+\/edit))$/.test(
		pathname,
	);
}

/** Every route that takes the full-height shell. */
export function isFullHeightPath(pathname: string): boolean {
	return (
		isWorkflowCanvasPath(pathname) ||
		isAgentBuilderPath(pathname) ||
		pathname.endsWith("/chatbot") ||
		pathname.endsWith("/nexus") ||
		/\/kanban(\/|\?|$)/.test(pathname)
	);
}
