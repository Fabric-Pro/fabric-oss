// Portions of this file are derived from Corsair (https://github.com/corsairdotdev/corsair)
// Original work © Corsair contributors. Licensed under Apache-2.0.
// Modifications © TechFabric LLC. Licensed under MIT (see the containing package's LICENSE).
// See THIRD_PARTY_NOTICES.md at the repository root for full attribution.

/**
 * @fabricorg/integrations-github
 *   import "@fabricorg/integrations-github";              // SDK consumers (types)
 *   import { githubPlugin } from "@fabricorg/integrations-github";  // portal (runtime)
 */

import { defineIntegration, endpoint } from "@fabricorg/integrations-runtime";
// Force resolution of @fabricorg/sdk for module augmentation below.
import type {} from "@fabricorg/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// Typed surface
// ─────────────────────────────────────────────────────────────────────────────

export interface GithubIntegrationClient {
	repos: {
		get(args: { owner: string; repo: string }): Promise<GithubRepo>;
		list(args?: {
			per_page?: number;
			page?: number;
		}): Promise<GithubRepo[]>;
	};
	issues: {
		list(args: {
			owner: string;
			repo: string;
			state?: "open" | "closed" | "all";
			per_page?: number;
		}): Promise<GithubIssue[]>;
		get(args: {
			owner: string;
			repo: string;
			issue_number: number;
		}): Promise<GithubIssue>;
		create(args: {
			owner: string;
			repo: string;
			title: string;
			body?: string;
			labels?: string[];
		}): Promise<GithubIssue>;
		comment(args: {
			owner: string;
			repo: string;
			issue_number: number;
			body: string;
		}): Promise<{ id: number; body: string }>;
	};
	pullRequests: {
		list(args: {
			owner: string;
			repo: string;
			state?: "open" | "closed" | "all";
		}): Promise<GithubPullRequest[]>;
		get(args: {
			owner: string;
			repo: string;
			pull_number: number;
		}): Promise<GithubPullRequest>;
		merge(args: {
			owner: string;
			repo: string;
			pull_number: number;
			merge_method?: "merge" | "squash" | "rebase";
		}): Promise<{ merged: boolean; sha: string }>;
	};
}

export interface GithubRepo {
	id: number;
	full_name: string;
	private: boolean;
	default_branch: string;
}
export interface GithubIssue {
	id: number;
	number: number;
	title: string;
	state: string;
	body: string | null;
	html_url: string;
}
export interface GithubPullRequest {
	id: number;
	number: number;
	title: string;
	state: string;
	merged: boolean;
	head: { ref: string; sha: string };
	base: { ref: string };
}

declare module "@fabricorg/sdk" {
	interface FabricIntegrations {
		github: GithubIntegrationClient;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime
// ─────────────────────────────────────────────────────────────────────────────

const GH_API = "https://api.github.com";

function token(creds: Record<string, unknown>): string {
	const t = creds.token ?? creds.access_token ?? creds.pat;
	if (typeof t !== "string") {
		throw new Error("github: missing token in credentials");
	}
	return t;
}

async function gh<T>(
	method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
	path: string,
	tok: string,
	body?: unknown,
): Promise<T> {
	const res = await fetch(`${GH_API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${tok}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"Content-Type": "application/json",
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	return (await res.json()) as T;
}

function qs(params: Record<string, unknown> | undefined): string {
	if (!params) {
		return "";
	}
	const entries = Object.entries(params).filter(([, v]) => v !== undefined);
	if (entries.length === 0) {
		return "";
	}
	return `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}`;
}

export const githubPlugin = defineIntegration({
	slug: "github",
	name: "GitHub",
	endpoints: {
		"repos.get": endpoint(
			(ctx, args: { owner: string; repo: string }) =>
				gh<GithubRepo>(
					"GET",
					`/repos/${args.owner}/${args.repo}`,
					token(ctx.credentials),
				),
			{ riskLevel: "read", description: "Get a repository's metadata" },
		),
		"repos.list": endpoint(
			(ctx, args?: { per_page?: number; page?: number }) =>
				gh<GithubRepo[]>(
					"GET",
					`/user/repos${qs(args)}`,
					token(ctx.credentials),
				),
			{
				riskLevel: "read",
				description: "List repositories accessible to the user",
			},
		),
		"issues.list": endpoint(
			(
				ctx,
				args: {
					owner: string;
					repo: string;
					state?: string;
					per_page?: number;
				},
			) =>
				gh<GithubIssue[]>(
					"GET",
					`/repos/${args.owner}/${args.repo}/issues${qs({ state: args.state, per_page: args.per_page })}`,
					token(ctx.credentials),
				),
			{ riskLevel: "read", description: "List issues in a repository" },
		),
		"issues.get": endpoint(
			(
				ctx,
				args: { owner: string; repo: string; issue_number: number },
			) =>
				gh<GithubIssue>(
					"GET",
					`/repos/${args.owner}/${args.repo}/issues/${args.issue_number}`,
					token(ctx.credentials),
				),
			{ riskLevel: "read", description: "Get a single issue" },
		),
		"issues.create": endpoint(
			(
				ctx,
				args: {
					owner: string;
					repo: string;
					title: string;
					body?: string;
					labels?: string[];
				},
			) =>
				gh<GithubIssue>(
					"POST",
					`/repos/${args.owner}/${args.repo}/issues`,
					token(ctx.credentials),
					{ title: args.title, body: args.body, labels: args.labels },
				),
			{ riskLevel: "write", description: "Open a new issue" },
		),
		"issues.comment": endpoint(
			(
				ctx,
				args: {
					owner: string;
					repo: string;
					issue_number: number;
					body: string;
				},
			) =>
				gh<{ id: number; body: string }>(
					"POST",
					`/repos/${args.owner}/${args.repo}/issues/${args.issue_number}/comments`,
					token(ctx.credentials),
					{ body: args.body },
				),
			{
				riskLevel: "write",
				description: "Comment on an issue or pull request",
			},
		),
		"pullRequests.list": endpoint(
			(
				ctx,
				args: {
					owner: string;
					repo: string;
					state?: string;
				},
			) =>
				gh<GithubPullRequest[]>(
					"GET",
					`/repos/${args.owner}/${args.repo}/pulls${qs({ state: args.state })}`,
					token(ctx.credentials),
				),
			{ riskLevel: "read", description: "List pull requests" },
		),
		"pullRequests.get": endpoint(
			(ctx, args: { owner: string; repo: string; pull_number: number }) =>
				gh<GithubPullRequest>(
					"GET",
					`/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}`,
					token(ctx.credentials),
				),
			{ riskLevel: "read", description: "Get a pull request" },
		),
		"pullRequests.merge": endpoint(
			(
				ctx,
				args: {
					owner: string;
					repo: string;
					pull_number: number;
					merge_method?: "merge" | "squash" | "rebase";
				},
			) =>
				gh<{ merged: boolean; sha: string }>(
					"PUT",
					`/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}/merge`,
					token(ctx.credentials),
					{ merge_method: args.merge_method ?? "merge" },
				),
			{
				riskLevel: "destructive",
				irreversible: true,
				description: "Merge a pull request",
			},
		),
	},
	permissions: { mode: "cautious" },
	oauth: {
		type: "oauth2",
		authorizationUrl: "https://github.com/login/oauth/authorize",
		tokenUrl: "https://github.com/login/oauth/access_token",
		scopes: ["repo", "read:user", "workflow"],
	},
	verifyWebhookSignature: ({ headers }) =>
		// Real verifier: HMAC-SHA256 raw body with webhook secret, compare to
		// `x-hub-signature-256`. Stub falls through to `onUnverified` policy.
		"x-hub-signature-256" in headers && "x-github-event" in headers
			? "unknown"
			: "invalid",
});
