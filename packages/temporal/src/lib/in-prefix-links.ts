/**
 * The path-prefix crawl's link filter: which absolute URLs a crawl may
 * follow from a scraped page.
 *
 * Shared by the crawl workflow (`url-source-crawl.ts`, which filters every
 * page's links before queueing them) and the scrape activity (which returns
 * only the links that pass, so a history records nothing the crawl could
 * not enqueue). One implementation keeps the two from drifting.
 *
 * Workflow-safe: imported by workflow code, so it is pure, has no imports,
 * and uses only the `URL` global, which the workflow sandbox provides.
 */

/**
 * Keep the absolute URLs that point at the same origin as `parentUrl` and
 * sit under one of `includePaths`, normalised and deduplicated in input
 * order.
 *
 * Normalisation rules:
 *  - Strip URL fragments (`#section`) so multiple anchors in a page don't
 *    each become their own scrape target.
 *  - Match Firecrawl's `/v1/map` output shape: keep query strings (some
 *    docs platforms use them as page selectors) and don't normalise
 *    trailing slashes (the prefix filter already handles both forms).
 *
 * Filter pipeline per URL: parsable as an absolute URL → same-origin as
 * `parentUrl` → pathname matches at least one of `includePaths` (when
 * non-empty; mirrors `matchesPrefix` in firecrawl-client.ts).
 */
export function filterInPrefixLinks(
	links: Iterable<string>,
	parentUrl: string,
	includePaths?: readonly string[],
): string[] {
	let parentOrigin: string;
	try {
		parentOrigin = new URL(parentUrl).origin;
	} catch {
		return [];
	}

	const out: string[] = [];
	const seenNormalised = new Set<string>();
	for (const candidate of links) {
		let u: URL;
		try {
			u = new URL(candidate);
		} catch {
			continue;
		}
		if (u.origin !== parentOrigin) {
			continue;
		}
		u.hash = ""; // strip fragments
		if (includePaths && includePaths.length > 0) {
			const ok = includePaths.some(
				(prefix) =>
					u.pathname === prefix ||
					u.pathname.startsWith(`${prefix}/`),
			);
			if (!ok) {
				continue;
			}
		}
		const normalised = u.toString();
		if (seenNormalised.has(normalised)) {
			continue;
		}
		seenNormalised.add(normalised);
		out.push(normalised);
	}
	return out;
}
