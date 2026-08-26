"use client";

/**
 * Registry of components that currently hold unsaved work and want to defer a
 * silent auto-reload (e.g. a rich-text editor or a dirty form). The
 * build-version watcher consults {@link canAutoReload} before reloading at the
 * return-from-hidden seam. The navigation seam is inherently safe — navigating
 * away abandons page-local state anyway — but it also respects the guard so it
 * doesn't surface a surprise "leave site?" prompt on a dirty page.
 */
const blockers = new Set<symbol>();

/** True when no component is holding an auto-reload block. */
export function canAutoReload(): boolean {
	return blockers.size === 0;
}
