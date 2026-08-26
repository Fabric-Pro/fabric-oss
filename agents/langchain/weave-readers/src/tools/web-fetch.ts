import { tool as aiTool } from "ai";

const tool = aiTool as any;

import { z } from "zod";

/**
 * RFC/Spec URL whitelist for security
 * Only these domains are allowed for RFC fetching
 */
const ALLOWED_RFC_DOMAINS = new Set([
	"datatracker.ietf.org",
	"tools.ietf.org",
	"www.rfc-editor.org",
	"www.w3.org",
	"www.ietf.org",
	"www.openwall.com", // OWASP
	"owasp.org",
	"www.owasp.org",
]);

/**
 * RFC URL patterns for validation
 */
const RFC_URL_PATTERNS = [
	/\/rfc\/(\d+)/i,
	/\/doc\/rfc-(\d+)/i,
	/rfc\.editor\/rfc\/(\d+)/i,
];

// In-memory cache for RFC fetches (per-request lifecycle)
// Using Map with URL as key and result as value
const rfcCache = new Map<string, { content: string; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if a URL is an allowed RFC/spec URL
 */
function isAllowedRfcUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();

		// Check against allowed domains
		if (ALLOWED_RFC_DOMAINS.has(hostname)) {
			return true;
		}

		// Check if it's an RFC URL pattern
		for (const pattern of RFC_URL_PATTERNS) {
			if (pattern.test(url)) {
				return true;
			}
		}

		return false;
	} catch {
		return false;
	}
}

/**
 * Extract RFC number from URL if present
 */
function extractRfcNumber(url: string): string | null {
	for (const pattern of RFC_URL_PATTERNS) {
		const match = url.match(pattern);
		if (match?.[1]) {
			return match[1];
		}
	}
	return null;
}

/**
 * Strip HTML to plain text with better formatting for specs
 */
function stripHtmlForSpec(html: string): string {
	// Remove scripts and styles first
	let text = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "");

	// Replace common HTML elements with appropriate formatting
	text = text
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<\/h[1-6]>/gi, "\n\n## ")
		.replace(/<\/li>/gi, "\n")
		.replace(/<li[^>]*>/gi, "• ")
		.replace(/<pre[^>]*>/gi, "\n```\n")
		.replace(/<\/pre>/gi, "\n```\n")
		.replace(/<code[^>]*>/gi, "`")
		.replace(/<\/code>/gi, "`")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]+/g, " ")
		.trim();

	return text;
}

/**
 * Create a web fetch tool specifically for RFC/spec verification.
 * Used by Warp to cite RFC sections for security patterns.
 *
 * Features:
 * - Whitelist-only URL validation (RFC/spec domains only)
 * - In-memory caching per request
 * - 10s timeout
 * - 100KB max content size
 */
export function createWebFetchTools() {
	return {
		fetchRfc: tool({
			description:
				"Fetch RFC or specification document sections for verification. Only allows RFC and spec URLs (IETF, W3C, OWASP). Use this to cite specific RFC sections when explaining security patterns or compliance requirements.",
			parameters: z.object({
				url: z.string().describe("The RFC/spec URL to fetch"),
				section: z
					.string()
					.optional()
					.describe(
						"Optional section identifier to extract (e.g., '5.1' or 'abstract')",
					),
				maxLength: z
					.number()
					.default(10000)
					.describe("Maximum content length to return (max 100000)"),
			}),
			execute: async ({
				url,
				section,
				maxLength,
			}: {
				url: string;
				section?: string;
				maxLength?: number;
			}) => {
				// Validate URL is allowed
				if (!isAllowedRfcUrl(url)) {
					const rfcNum = extractRfcNumber(url);
					if (!rfcNum) {
						return {
							url,
							error: `URL not allowed. Only RFC and specification URLs are permitted. Expected domains: ${Array.from(ALLOWED_RFC_DOMAINS).join(", ")}`,
							allowedDomains: Array.from(ALLOWED_RFC_DOMAINS),
						};
					}
				}

				// Check cache first
				const cached = rfcCache.get(url);
				if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
					let content = cached.content;
					if (section) {
						content = extractSection(content, section);
					}
					const cap = Math.min(maxLength ?? 10000, 100000);
					const truncated =
						content.length > cap
							? `${content.slice(0, cap)}\n... [truncated]`
							: content;
					return {
						url,
						content: truncated,
						cached: true,
						length: content.length,
						section: section || "full",
					};
				}

				// Fetch with timeout and size limit
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 10000);
				const MAX_SIZE = 100 * 1024; // 100KB

				try {
					const response = await fetch(url, {
						headers: {
							"User-Agent": "FabricWeaveWarp/1.0 (RFC Fetcher)",
							Accept: "text/html,text/plain,application/xhtml+xml,application/xml",
						},
						signal: controller.signal,
						redirect: "follow",
					});

					clearTimeout(timeout);

					if (!response.ok) {
						return {
							url,
							error: `HTTP ${response.status}: ${response.statusText}`,
						};
					}

					// Check content type
					const contentType =
						response.headers.get("content-type") || "";
					const isHtml =
						contentType.includes("text/html") ||
						contentType.includes("application/xhtml");

					let text: string;
					if (isHtml) {
						const raw = await response.text();
						// Check size before processing
						if (raw.length > MAX_SIZE) {
							return {
								url,
								error: `Content too large (${raw.length} bytes). Maximum allowed is ${MAX_SIZE} bytes.`,
								maxSize: MAX_SIZE,
							};
						}
						text = stripHtmlForSpec(raw);
					} else {
						const reader = response.body?.getReader();
						if (!reader) {
							return {
								url,
								error: "Failed to read response body",
							};
						}

						let totalSize = 0;
						const chunks: Uint8Array[] = [];

						while (true) {
							const { done, value } = await reader.read();
							if (done) {
								break;
							}

							totalSize += value.length;
							if (totalSize > MAX_SIZE) {
								// Limit reached, stop reading
								return {
									url,
									error: `Content too large (${totalSize} bytes). Maximum allowed is ${MAX_SIZE} bytes.`,
									maxSize: MAX_SIZE,
								};
							}
							chunks.push(value);
						}

						const decoder = new TextDecoder();
						text = decoder.decode(
							new Uint8Array(
								chunks.reduce((acc, chunk) => {
									const newAcc = new Uint8Array(
										acc.length + chunk.length,
									);
									newAcc.set(acc);
									newAcc.set(chunk, acc.length);
									return newAcc;
								}, new Uint8Array(0)),
							),
						);
					}

					// Cache the result
					rfcCache.set(url, { content: text, timestamp: Date.now() });

					// Extract section if requested
					if (section) {
						text = extractSection(text, section);
					}

					const cap = Math.min(maxLength ?? 10000, 100000);
					const truncated =
						text.length > cap
							? `${text.slice(0, cap)}\n... [truncated]`
							: text;

					return {
						url,
						content: truncated,
						cached: false,
						length: text.length,
						section: section || "full",
					};
				} catch (error) {
					clearTimeout(timeout);
					return {
						url,
						error:
							error instanceof Error
								? error.message
								: "Failed to fetch RFC",
					};
				}
			},
		}),

		/**
		 * Clear the RFC cache. Useful for testing or when fresh content is needed.
		 */
		clearRfcCache: tool({
			description: "Clear the RFC cache to force fresh fetches.",
			parameters: z.object({}),
			execute: async () => {
				const size = rfcCache.size;
				rfcCache.clear();
				return { cleared: true, entriesRemoved: size };
			},
		}),
	};
}

/**
 * Extract a specific section from RFC/text content
 * Handles common section formats like "Section 5.1", "5.1", "abstract"
 */
function extractSection(content: string, section: string): string {
	const lines = content.split("\n");
	const sectionLower = section.toLowerCase();

	// Try to find section by number (e.g., "5.1" or "Section 5.1")
	const sectionNumMatch = section.match(/^(\d+\.)*\d+$/);
	if (sectionNumMatch) {
		const sectionNum = sectionNumMatch[0];
		const sectionPattern = new RegExp(`^${sectionNum}[.\\s].*`, "i");

		// Find the line with this section
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (sectionPattern.test(line)) {
				// Extract section content until next section or end
				const sectionLines: string[] = [line];
				for (let j = i + 1; j < lines.length; j++) {
					const nextLine = lines[j].trim();
					// Stop at next top-level section (just a number followed by period)
					if (
						/^\d+\.\s/.test(nextLine) &&
						!nextLine.startsWith(sectionNum)
					) {
						break;
					}
					sectionLines.push(nextLine);
				}
				return sectionLines.join("\n");
			}
		}
	}

	// Try to find by keyword (abstract, introduction, etc.)
	const keywordPatterns: Record<string, RegExp> = {
		abstract: /^abstract$/i,
		introduction: /^1\.?\s*introduction$/i,
		overview: /^1\.?\s*overview$/i,
		security: /^[x\d]+\.?\s*security/i,
		references: /^(\d+\.)?\s*references$/i,
		notation: /^[x\d]+\.?\s*notation$/i,
	};

	for (const [keyword, pattern] of Object.entries(keywordPatterns)) {
		if (sectionLower.includes(keyword)) {
			for (let i = 0; i < lines.length; i++) {
				if (pattern.test(lines[i].trim())) {
					const sectionLines: string[] = [lines[i].trim()];
					for (let j = i + 1; j < lines.length; j++) {
						const line = lines[j].trim();
						// Stop at next numbered section
						if (/^(\d+\.)+\d+\s/.test(line)) {
							break;
						}
						sectionLines.push(line);
					}
					return sectionLines.join("\n");
				}
			}
		}
	}

	// Fallback: return full content with note
	return content;
}
