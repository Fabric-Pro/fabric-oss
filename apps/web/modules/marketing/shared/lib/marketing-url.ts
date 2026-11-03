/**
 * The indexable URL of a marketing or legal page.
 *
 * With i18n off, routing uses `localePrefix: "never"`, so `/en` and
 * `/en/legal/...` redirect to their unprefixed paths. A sitemap entry or a
 * canonical that names the redirecting URL keeps the page out of the index,
 * so those pages are listed without the prefix. Blog and docs are not passed
 * here: the proxy serves them only with the locale in the path.
 */
export function marketingUrl(
	baseUrl: string,
	locale: string,
	path: string,
	i18nEnabled: boolean,
): string {
	const pathname = i18nEnabled ? `/${locale}${path}` : path || "/";
	return new URL(pathname, baseUrl).href;
}
