/**
 * Build the tenant-aware story route for a finding's source feature. The Security
 * view is a CLIENT-SIDE tab, so the URL is the project root (…/projects/<id>),
 * NOT …/security — derive the project base and append /stories/<id> rather than
 * replacing a trailing "/security" that isn't there (which no-op'd and left every
 * finding link pointing at the project root).
 */
export function buildStoryHref(pathname: string, storyId: string): string {
	const base =
		pathname.match(/^(.*\/projects\/[^/]+)/)?.[1] ??
		pathname.replace(/\/security$/, "");
	return `${base}/stories/${storyId}`;
}
