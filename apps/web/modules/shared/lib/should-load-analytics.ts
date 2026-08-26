/**
 * Whether analytics/SpeedInsights should render. Tracking is suppressed on
 * `/embed` routes so the iframe never injects Fabric analytics into a
 * third-party site. `isEmbed` is server-authoritative (set from the
 * `x-embed-route` request header), so there is no `usePathname` null/timing
 * ambiguity.
 */
export function shouldLoadAnalytics(
	analyticsAllowed: boolean,
	isEmbed: boolean,
): boolean {
	return analyticsAllowed && !isEmbed;
}
