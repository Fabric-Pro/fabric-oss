import { tool as aiTool } from "ai";

const tool = aiTool as any;

import { z } from "zod";

/**
 * Create AI SDK v6 tools for external research.
 * Uses DuckDuckGo instant answers (no API key) as default,
 * or Tavily/Serper/Exa when API keys are configured.
 */
export function createWebSearchTools() {
	return {
		webSearch: tool({
			description:
				"Search the web for documentation, APIs, best practices, and technical information. Returns relevant results with titles, URLs, and snippets.",
			parameters: z.object({
				query: z.string().describe("The search query"),
				numResults: z
					.number()
					.default(5)
					.describe("Number of results to return (max 10)"),
			}),
			execute: async ({
				query,
				numResults,
			}: {
				query: string;
				numResults?: number;
			}) => {
				const maxResults = Math.min(numResults ?? 5, 10);

				// Try Tavily first (best for technical search)
				if (process.env.TAVILY_API_KEY) {
					return await searchWithTavily(
						query,
						maxResults,
						process.env.TAVILY_API_KEY,
					);
				}

				// Fall back to Serper
				if (process.env.SERPER_API_KEY) {
					return await searchWithSerper(
						query,
						maxResults,
						process.env.SERPER_API_KEY,
					);
				}

				// Fall back to DuckDuckGo (no API key needed)
				return await searchWithDuckDuckGo(query, maxResults);
			},
		}),

		fetchUrl: tool({
			description:
				"Fetch the text content of a web page. Use this to read documentation, API references, or articles found via web search.",
			parameters: z.object({
				url: z.string().url().describe("The URL to fetch"),
				maxLength: z
					.number()
					.default(6000)
					.describe("Maximum content length to return"),
			}),
			execute: async ({
				url,
				maxLength,
			}: {
				url: string;
				maxLength?: number;
			}) => {
				try {
					const controller = new AbortController();
					const timeout = setTimeout(() => controller.abort(), 10000);

					const response = await fetch(url, {
						headers: {
							"User-Agent":
								"Mozilla/5.0 (compatible; FabricWeaveSpindle/1.0)",
							Accept: "text/html,text/plain,application/json",
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

					const contentType =
						response.headers.get("content-type") || "";
					let text: string;

					if (contentType.includes("application/json")) {
						const json = await response.json();
						text = JSON.stringify(json, null, 2);
					} else {
						const raw = await response.text();
						text = stripHtmlTags(raw);
					}

					const cap = Math.min(maxLength ?? 6000, 12000);
					const truncated =
						text.length > cap
							? `${text.slice(0, cap)}\n... [truncated, ${text.length} chars total]`
							: text;

					return { url, content: truncated, length: text.length };
				} catch (error) {
					return {
						url,
						error:
							error instanceof Error
								? error.message
								: "Failed to fetch URL",
					};
				}
			},
		}),

		searchNpm: tool({
			description:
				"Search the npm registry for packages. Returns package names, descriptions, and download counts.",
			parameters: z.object({
				query: z.string().describe("Package search query"),
				limit: z
					.number()
					.default(5)
					.describe("Number of results (max 10)"),
			}),
			execute: async ({
				query,
				limit,
			}: {
				query: string;
				limit?: number;
			}) => {
				try {
					const maxLimit = Math.min(limit ?? 5, 10);
					const response = await fetch(
						`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${maxLimit}`,
						{ signal: AbortSignal.timeout(8000) },
					);

					if (!response.ok) {
						return {
							query,
							error: `npm registry returned ${response.status}`,
						};
					}

					const data = (await response.json()) as {
						objects: Array<{
							package: {
								name: string;
								description?: string;
								version: string;
								links?: { npm?: string; homepage?: string };
							};
							score?: { detail?: { popularity?: number } };
						}>;
					};

					return {
						query,
						packages: data.objects.map((obj) => ({
							name: obj.package.name,
							description: obj.package.description || "",
							version: obj.package.version,
							url:
								obj.package.links?.npm ||
								`https://www.npmjs.com/package/${obj.package.name}`,
							homepage: obj.package.links?.homepage,
						})),
					};
				} catch (error) {
					return {
						query,
						error:
							error instanceof Error
								? error.message
								: "npm search failed",
					};
				}
			},
		}),

		searchGitHub: tool({
			description:
				"Search GitHub for repositories. Returns repository names, descriptions, and stars.",
			parameters: z.object({
				query: z.string().describe("GitHub search query"),
				limit: z
					.number()
					.default(5)
					.describe("Number of results (max 10)"),
			}),
			execute: async ({
				query,
				limit,
			}: {
				query: string;
				limit?: number;
			}) => {
				try {
					const maxLimit = Math.min(limit ?? 5, 10);
					const headers: Record<string, string> = {
						Accept: "application/vnd.github.v3+json",
						"User-Agent": "FabricWeaveSpindle",
					};

					if (process.env.GITHUB_TOKEN) {
						headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
					}

					const response = await fetch(
						`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${maxLimit}&sort=stars`,
						{ headers, signal: AbortSignal.timeout(8000) },
					);

					if (!response.ok) {
						return {
							query,
							error: `GitHub API returned ${response.status}`,
						};
					}

					const data = (await response.json()) as {
						items: Array<{
							full_name: string;
							description?: string;
							html_url: string;
							stargazers_count: number;
							language?: string;
							updated_at: string;
						}>;
					};

					return {
						query,
						repositories: data.items.map((repo) => ({
							name: repo.full_name,
							description: repo.description || "",
							url: repo.html_url,
							stars: repo.stargazers_count,
							language: repo.language,
							updatedAt: repo.updated_at,
						})),
					};
				} catch (error) {
					return {
						query,
						error:
							error instanceof Error
								? error.message
								: "GitHub search failed",
					};
				}
			},
		}),
	};
}

function stripHtmlTags(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim();
}

async function searchWithTavily(
	query: string,
	numResults: number,
	apiKey: string,
) {
	try {
		const response = await fetch("https://api.tavily.com/search", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				api_key: apiKey,
				query,
				max_results: numResults,
				search_depth: "basic",
				include_answer: true,
			}),
			signal: AbortSignal.timeout(10000),
		});

		if (!response.ok) {
			return { query, error: `Tavily API returned ${response.status}` };
		}

		const data = (await response.json()) as {
			answer?: string;
			results: Array<{
				title: string;
				url: string;
				content: string;
			}>;
		};

		return {
			query,
			answer: data.answer,
			results: data.results.map((r) => ({
				title: r.title,
				url: r.url,
				snippet: r.content.slice(0, 300),
			})),
		};
	} catch (error) {
		return {
			query,
			error:
				error instanceof Error ? error.message : "Tavily search failed",
		};
	}
}

async function searchWithSerper(
	query: string,
	numResults: number,
	apiKey: string,
) {
	try {
		const response = await fetch("https://google.serper.dev/search", {
			method: "POST",
			headers: {
				"X-API-KEY": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ q: query, num: numResults }),
			signal: AbortSignal.timeout(10000),
		});

		if (!response.ok) {
			return { query, error: `Serper API returned ${response.status}` };
		}

		const data = (await response.json()) as {
			organic: Array<{
				title: string;
				link: string;
				snippet: string;
			}>;
			answerBox?: { answer?: string };
		};

		return {
			query,
			answer: data.answerBox?.answer,
			results: (data.organic || []).map((r) => ({
				title: r.title,
				url: r.link,
				snippet: r.snippet,
			})),
		};
	} catch (error) {
		return {
			query,
			error:
				error instanceof Error ? error.message : "Serper search failed",
		};
	}
}

async function searchWithDuckDuckGo(query: string, numResults: number) {
	try {
		// DuckDuckGo HTML search (no API key needed)
		const response = await fetch(
			`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
			{
				headers: {
					"User-Agent":
						"Mozilla/5.0 (compatible; FabricWeaveSpindle/1.0)",
				},
				signal: AbortSignal.timeout(10000),
			},
		);

		if (!response.ok) {
			return {
				query,
				error: `DuckDuckGo returned ${response.status}`,
			};
		}

		const html = await response.text();

		// Parse results from HTML
		const results: Array<{
			title: string;
			url: string;
			snippet: string;
		}> = [];

		const resultBlocks = html.split('class="result__body"');
		for (
			let i = 1;
			i < resultBlocks.length && results.length < numResults;
			i++
		) {
			const block = resultBlocks[i];

			const titleMatch = block.match(
				/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/,
			);
			const snippetMatch = block.match(
				/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:td|div|span)/,
			);

			if (titleMatch) {
				let url = titleMatch[1];
				// DuckDuckGo wraps URLs in a redirect
				const udMatch = url.match(/uddg=([^&]+)/);
				if (udMatch) {
					url = decodeURIComponent(udMatch[1]);
				}

				results.push({
					title: stripHtmlTags(titleMatch[2]).trim(),
					url,
					snippet: snippetMatch
						? stripHtmlTags(snippetMatch[1]).trim().slice(0, 300)
						: "",
				});
			}
		}

		if (results.length === 0) {
			return {
				query,
				results: [],
				note: "No results found. Try a different query or more specific terms.",
			};
		}

		return { query, results };
	} catch (error) {
		return {
			query,
			error:
				error instanceof Error
					? error.message
					: "DuckDuckGo search failed",
		};
	}
}
