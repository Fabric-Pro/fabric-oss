/**
 * GitHub Federated Search
 *
 * Real-time search across GitHub code, issues, and PRs using the GitHub Search API.
 * Often better than indexing all repos — GitHub's code search is highly optimized.
 *
 * Respects live permissions — only returns results from repos the token has access to.
 */

import {
	FederatedConnector,
	registerFederatedConnector,
} from "../federated-connector";
import type {
	FederatedSearchOptions,
	FederatedSearchResult,
	GitHubConfig,
} from "../types";

export class GitHubFederatedConnector extends FederatedConnector {
	readonly provider = "GITHUB" as const;

	async federatedSearch(
		options: FederatedSearchOptions,
	): Promise<FederatedSearchResult[]> {
		const { query, config, maxResults = 10 } = options;
		const token = config.credentials.accessToken;

		if (!token) {
			throw new Error(
				"GitHub access token required for federated search",
			);
		}

		const githubConfig = config.providerConfig as unknown as GitHubConfig;
		const owner = githubConfig?.owner;

		// Search code, issues, and PRs in parallel
		const [codeResults, issueResults] = await Promise.all([
			this.searchCode(query, token, owner, Math.ceil(maxResults / 2)),
			this.searchIssues(query, token, owner, Math.floor(maxResults / 2)),
		]);

		return [...codeResults, ...issueResults].slice(0, maxResults);
	}

	private async searchCode(
		query: string,
		token: string,
		owner?: string,
		maxResults = 5,
	): Promise<FederatedSearchResult[]> {
		const qualifiedQuery = owner ? `${query} org:${owner}` : query;

		const response = await fetch(
			`https://api.github.com/search/code?${new URLSearchParams({
				q: qualifiedQuery,
				per_page: String(maxResults),
			})}`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github.v3+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);

		if (!response.ok) {
			return [];
		}

		const data = (await response.json()) as {
			items?: Array<{
				sha: string;
				name: string;
				path: string;
				html_url: string;
				repository?: { full_name?: string };
				text_matches?: Array<{ fragment?: string }>;
			}>;
		};

		return (data.items ?? []).map((item) => {
			const repoName = item.repository?.full_name || "unknown";
			const fragment =
				item.text_matches?.[0]?.fragment || `File: ${item.path}`;

			return this.buildResult({
				id: `gh-code-${item.sha}`,
				title: `${item.path} in ${repoName}`,
				content: this.truncateContent(fragment),
				url: item.html_url,
				sourceName: repoName,
				metadata: {
					type: "code",
					path: item.path,
					repository: repoName,
					freshness: "live",
				},
			});
		});
	}

	private async searchIssues(
		query: string,
		token: string,
		owner?: string,
		maxResults = 5,
	): Promise<FederatedSearchResult[]> {
		const qualifiedQuery = owner ? `${query} org:${owner}` : query;

		const response = await fetch(
			`https://api.github.com/search/issues?${new URLSearchParams({
				q: qualifiedQuery,
				per_page: String(maxResults),
				sort: "updated",
				order: "desc",
			})}`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github.v3+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);

		if (!response.ok) {
			return [];
		}

		const data = (await response.json()) as {
			items?: Array<{
				id: number;
				title: string;
				body?: string;
				html_url: string;
				user?: { login?: string };
				updated_at?: string;
				repository_url?: string;
				pull_request?: unknown;
			}>;
		};

		return (data.items ?? []).map((item) => {
			const repoName =
				item.repository_url?.split("/").slice(-2).join("/") ||
				"unknown";
			const isPR = !!item.pull_request;

			return this.buildResult({
				id: `gh-issue-${item.id}`,
				title: `${isPR ? "PR" : "Issue"}: ${item.title}`,
				content: this.truncateContent(item.body || item.title),
				url: item.html_url,
				sourceName: repoName,
				externalTimestamp: item.updated_at
					? new Date(item.updated_at)
					: undefined,
				author: item.user?.login,
				metadata: {
					type: isPR ? "pull_request" : "issue",
					repository: repoName,
					freshness: "live",
				},
			});
		});
	}
}

// Auto-register on import
registerFederatedConnector("GITHUB", () => new GitHubFederatedConnector());
