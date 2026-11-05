/** Only return to this organization's prompt library; never follow arbitrary redirects. */
export function promptReturnHref(basePath: string, candidate?: string | null) {
	const fallback = `${basePath}/prompts`;
	if (!candidate || candidate.includes("#")) {
		return fallback;
	}
	try {
		const url = new URL(candidate, "https://example.com");
		return candidate.startsWith(`${fallback}?`) &&
			url.origin === "https://example.com" &&
			url.pathname === fallback
			? `${fallback}${url.search}`
			: fallback;
	} catch {
		return fallback;
	}
}
