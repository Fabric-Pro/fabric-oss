/** Resolve stored report citations against the current organization route. */
export function resolveReportSourceLink(
	href: string | undefined,
	projectsPath: string,
): string | undefined {
	if (!href?.startsWith("projects/")) {
		return href;
	}
	let suffix = href.slice("projects/".length);
	// Early Project knowledge reports used a nonexistent /context route. Keep
	// their stored evidence immutable while opening the existing Context tab.
	const oldContext = /^([^/?#]+)\/context\?source=([^&#]+)$/.exec(suffix);
	if (oldContext) {
		suffix = `${oldContext[1]}?tab=context&source=${oldContext[2]}`;
	}
	return `${projectsPath}/${suffix}`;
}
