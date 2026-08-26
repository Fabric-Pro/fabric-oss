/**
 * GitHub OAuth Utilities
 *
 * Handles GitHub OAuth flow for task agent integration.
 * Similar to Weft's implementation.
 */

// GitHub OAuth configuration
const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com";

// Scopes needed for repo access and PR creation
const GITHUB_SCOPES = ["repo", "read:user"];

export interface GitHubTokenResponse {
	access_token: string;
	token_type: string;
	scope: string;
	refresh_token?: string;
	expires_in?: number;
	refresh_token_expires_in?: number;
}

export interface GitHubUser {
	id: number;
	login: string;
	name: string | null;
	avatar_url: string;
	email: string | null;
}

export interface GitHubRepo {
	id: number;
	name: string;
	full_name: string;
	owner: {
		login: string;
	};
	private: boolean;
	default_branch: string;
	description: string | null;
	html_url: string;
}

/**
 * Generate the GitHub OAuth authorization URL
 */
export function getGitHubOAuthUrl(
	clientId: string,
	redirectUri: string,
	state: string,
): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		scope: GITHUB_SCOPES.join(" "),
		state,
	});

	return `${GITHUB_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 */
export async function exchangeCodeForToken(
	code: string,
	clientId: string,
	clientSecret: string,
	redirectUri: string,
): Promise<GitHubTokenResponse> {
	const response = await fetch(GITHUB_TOKEN_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			client_id: clientId,
			client_secret: clientSecret,
			code,
			redirect_uri: redirectUri,
		}),
	});

	if (!response.ok) {
		throw new Error(`GitHub token exchange failed: ${response.status}`);
	}

	const data = (await response.json()) as GitHubTokenResponse & {
		error?: string;
		error_description?: string;
	};

	if (data.error) {
		throw new Error(
			`GitHub OAuth error: ${data.error_description || data.error}`,
		);
	}

	if (!data.access_token) {
		throw new Error("No access token in GitHub response");
	}

	return data;
}

/**
 * Get the authenticated user's GitHub profile
 */
export async function getGitHubUser(accessToken: string): Promise<GitHubUser> {
	const response = await fetch(`${GITHUB_API_URL}/user`, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/vnd.github.v3+json",
			"User-Agent": "Fabric-App",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to get GitHub user: ${response.status}`);
	}

	return response.json() as Promise<GitHubUser>;
}

/**
 * List repositories accessible to the user
 */
export async function listGitHubRepos(
	accessToken: string,
	page = 1,
	perPage = 30,
): Promise<GitHubRepo[]> {
	const params = new URLSearchParams({
		sort: "updated",
		direction: "desc",
		per_page: String(perPage),
		page: String(page),
	});

	const response = await fetch(
		`${GITHUB_API_URL}/user/repos?${params.toString()}`,
		{
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/vnd.github.v3+json",
				"User-Agent": "Fabric-App",
			},
		},
	);

	if (!response.ok) {
		throw new Error(`Failed to list GitHub repos: ${response.status}`);
	}

	return response.json() as Promise<GitHubRepo[]>;
}

export interface GitHubBranch {
	name: string;
	protected: boolean;
}

/**
 * List branches for a repository
 */
export async function listGitHubBranches(
	accessToken: string,
	owner: string,
	repo: string,
	perPage = 100,
): Promise<GitHubBranch[]> {
	const params = new URLSearchParams({
		per_page: String(perPage),
	});

	const response = await fetch(
		`${GITHUB_API_URL}/repos/${owner}/${repo}/branches?${params.toString()}`,
		{
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/vnd.github.v3+json",
				"User-Agent": "Fabric-App",
			},
		},
	);

	if (!response.ok) {
		throw new Error(`Failed to list GitHub branches: ${response.status}`);
	}

	return response.json() as Promise<GitHubBranch[]>;
}
