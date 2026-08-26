/**
 * GitLab OAuth Utilities
 *
 * Handles GitLab OAuth flow for task agent integration.
 * Mirrors the GitHub OAuth utilities pattern.
 */

import { createHash, randomBytes } from "node:crypto";

// GitLab OAuth configuration
const GITLAB_AUTH_URL = "https://gitlab.com/oauth/authorize";
const GITLAB_TOKEN_URL = "https://gitlab.com/oauth/token";
const GITLAB_API_URL = "https://gitlab.com/api/v4";

// Scopes needed for repo access and user info
const GITLAB_SCOPES = ["api", "read_user"];

export interface GitLabTokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token: string;
	created_at: number;
	scope: string;
}

export interface GitLabUser {
	id: number;
	username: string;
	name: string;
	email: string | null;
	avatar_url: string;
	web_url: string;
}

export interface GitLabProject {
	id: number;
	name: string;
	path_with_namespace: string;
	namespace: {
		full_path: string;
	};
	visibility: string;
	default_branch: string;
	description: string | null;
	web_url: string;
	last_activity_at: string;
}

export interface GitLabBranch {
	name: string;
	protected: boolean;
}

/**
 * Generate a random state string for OAuth CSRF protection
 */
export function generateOAuthState(): string {
	const array = new Uint8Array(16);
	crypto.getRandomValues(array);
	return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a PKCE code_verifier + code_challenge pair (S256 method).
 *
 * Why: GitLab supports PKCE for public OAuth clients. Without it, an attacker
 * who intercepts the authorization code (e.g. via browser history, referrer
 * header, or a malicious browser extension) can redeem it. With PKCE, the
 * token exchange requires the original `code_verifier` that only the
 * initiating client knows.
 *
 *  - verifier: 43-128 URL-safe-base64 chars (RFC 7636 §4.1). We use 32 bytes
 *    of random data which base64url-encodes to 43 chars.
 *  - challenge: base64url(sha256(verifier)) per RFC 7636 §4.2.
 */
export function generatePkce(): {
	codeVerifier: string;
	codeChallenge: string;
} {
	// 32 random bytes -> 43 base64url chars (no padding), well within 43-128.
	const codeVerifier = randomBytes(32).toString("base64url");
	const codeChallenge = createHash("sha256")
		.update(codeVerifier)
		.digest("base64url");
	return { codeVerifier, codeChallenge };
}

/**
 * Generate the GitLab OAuth authorization URL.
 *
 * When `codeChallenge` is provided, appends PKCE parameters
 * (`code_challenge` + `code_challenge_method=S256`). The parameter is
 * optional so callers (and existing tests) that don't supply it still get a
 * valid non-PKCE URL — useful for backwards compat during deployment.
 */
export function getGitLabOAuthUrl(
	clientId: string,
	redirectUri: string,
	state: string,
	codeChallenge?: string,
): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: GITLAB_SCOPES.join(" "),
		state,
	});

	if (codeChallenge) {
		params.set("code_challenge", codeChallenge);
		params.set("code_challenge_method", "S256");
	}

	return `${GITLAB_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token.
 *
 * IMPORTANT: GitLab uses application/x-www-form-urlencoded for token exchange.
 *
 * When `codeVerifier` is provided, includes it in the form body to complete
 * the PKCE exchange. Optional so the function remains backwards-compatible
 * with non-PKCE flows (e.g. in-flight OAuth states from before PKCE was
 * enabled).
 */
export async function exchangeCodeForToken(
	code: string,
	clientId: string,
	clientSecret: string,
	redirectUri: string,
	codeVerifier?: string,
): Promise<GitLabTokenResponse> {
	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		code,
		grant_type: "authorization_code",
		redirect_uri: redirectUri,
	});

	if (codeVerifier) {
		body.set("code_verifier", codeVerifier);
	}

	const response = await fetch(GITLAB_TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: body.toString(),
	});

	if (!response.ok) {
		throw new Error(`GitLab token exchange failed: ${response.status}`);
	}

	const data = (await response.json()) as GitLabTokenResponse & {
		error?: string;
		error_description?: string;
	};

	if (data.error) {
		throw new Error(
			`GitLab OAuth error: ${data.error_description || data.error}`,
		);
	}

	if (!data.access_token) {
		throw new Error("No access token in GitLab response");
	}

	return data;
}

/**
 * Refresh a GitLab access token using a refresh token.
 *
 * Re-exported from `@repo/integrations/gitlab` to keep the api surface
 * stable while consolidating the implementation in one place. Both this
 * file, the Temporal step resolver, and the new MCP-config refresh helper
 * now share a single function.
 */
export { refreshGitLabToken } from "@repo/integrations/gitlab";

/**
 * Get the authenticated user's GitLab profile
 */
export async function getGitLabUser(accessToken: string): Promise<GitLabUser> {
	const response = await fetch(`${GITLAB_API_URL}/user`, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to get GitLab user: ${response.status}`);
	}

	return response.json() as Promise<GitLabUser>;
}

/**
 * List projects accessible to the user
 */
export async function listGitLabProjects(
	accessToken: string,
	page = 1,
	perPage = 30,
): Promise<GitLabProject[]> {
	const params = new URLSearchParams({
		membership: "true",
		order_by: "updated_at",
		sort: "desc",
		per_page: String(perPage),
		page: String(page),
	});

	const response = await fetch(
		`${GITLAB_API_URL}/projects?${params.toString()}`,
		{
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		},
	);

	if (!response.ok) {
		throw new Error(`Failed to list GitLab projects: ${response.status}`);
	}

	return response.json() as Promise<GitLabProject[]>;
}

/**
 * List branches for a GitLab project
 */
export async function listGitLabBranches(
	accessToken: string,
	projectId: string,
): Promise<GitLabBranch[]> {
	const response = await fetch(
		`${GITLAB_API_URL}/projects/${encodeURIComponent(projectId)}/repository/branches`,
		{
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		},
	);

	if (!response.ok) {
		throw new Error(`Failed to list GitLab branches: ${response.status}`);
	}

	return response.json() as Promise<GitLabBranch[]>;
}

/**
 * Test if a GitLab token is valid
 */
export async function testGitLabToken(accessToken: string): Promise<boolean> {
	try {
		await getGitLabUser(accessToken);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve organizationId for Prisma queries against tenant-scoped tables.
 *
 * Why: state.organizationId can be undefined (personal context) or empty string
 * (logic bug). Both must coerce to `null` so the Prisma XOR pattern
 * (`organizationId: null` for personal, `organizationId: <id>` for org) holds.
 * Passing `undefined` to Prisma where-clauses removes the condition entirely,
 * which would leak cross-tenant rows. This is a security invariant.
 */
export function resolveOrgIdForQuery(state: {
	organizationId?: string | null;
}): string | null {
	if (!state.organizationId) {
		return null;
	}
	return state.organizationId;
}

/**
 * Record a tool-ingestion failure on the WorkflowIntegration row so the UI
 * can surface a "Connected, but tools failed to load — retry" affordance.
 *
 * Why: OAuth callback previously swallowed ingestion errors with console.error,
 * masking real failures. Persist them on the integration row instead so users
 * see "connected but broken" state rather than a misleading success toast.
 */
export async function recordToolIngestError(args: {
	// update is typed as (args: unknown) so that the real PrismaClient satisfies
	// this interface structurally — the narrower arg shape is enforced at the call
	// inside this function, not at the boundary.
	db: {
		workflowIntegration: {
			update: (args: unknown) => Promise<unknown>;
		};
	};
	integrationId: string;
	error: unknown;
}): Promise<void> {
	const message =
		args.error instanceof Error ? args.error.message : String(args.error);
	await args.db.workflowIntegration.update({
		where: { id: args.integrationId },
		data: {
			settings: {
				lastToolIngestError: {
					message,
					at: new Date().toISOString(),
				},
			},
		},
	});
}
