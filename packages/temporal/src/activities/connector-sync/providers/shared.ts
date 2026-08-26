export function normalizeHttpsBaseUrl(domain: string): string {
	const normalizedDomain = domain
		.trim()
		.replace(/^https?:\/\//, "")
		.replace(/\/+$/, "");
	return `https://${normalizedDomain}`;
}

export function buildBasicAuthHeaders(username: string, secret: string) {
	return {
		Authorization: `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`,
		Accept: "application/json",
	};
}

export function convertHtmlToText(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<li[^>]*>/gi, "- ")
		.replace(/<\/li>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function normalizeSubdomainApiBaseUrl(
	domain: string,
	baseDomain: string,
	pathSuffix = "",
): string {
	const normalizedDomain = domain
		.trim()
		.replace(/^https?:\/\//, "")
		.replace(/\/+$/, "");
	return normalizedDomain.endsWith(baseDomain)
		? `https://${normalizedDomain}${pathSuffix}`
		: `https://${normalizedDomain}.${baseDomain}${pathSuffix}`;
}
