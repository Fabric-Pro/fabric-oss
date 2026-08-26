/**
 * Daily Brief — per-repo credential resolution for the multi-provider collectors.
 *
 * Maps one ProjectRepositoryIntegration row (as returned by
 * `getProjectReposForCodeSearch`) to a provider-specific auth context, or an
 * explicit `unsupported` outcome the collectors record as a per-repo failure.
 * Dispatch mirrors `activities/repo-health-check.ts` (GITHUB+OAUTH /
 * GITLAB+OAUTH / AZURE_DEVOPS+PAT / unknown → explicit error).
 *
 * SECURITY: decrypted tokens are request-scoped — never logged, never embedded
 * in failure reasons.
 */

import { parseAdoRepositoryUrl } from "@repo/connectors";
import { db, type getProjectReposForCodeSearch } from "@repo/database";
import {
	getValidGitLabAccessToken,
	refreshGitLabToken,
} from "@repo/integrations/gitlab";
import { resolveFreshRepoTokenForRow } from "@repo/integrations/repo-auth";
import { decryptApiKey } from "@repo/utils";

export type RepoIntegrationRow = Awaited<
	ReturnType<typeof getProjectReposForCodeSearch>
>[number];

export type RepoAuth =
	| { kind: "github"; token: string }
	| { kind: "gitlab"; getToken: () => Promise<string> }
	| { kind: "ado"; basicAuth: string; organization: string; project: string }
	| { kind: "unsupported"; reason: string };

function errorMessage(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	try {
		return String(err);
	} catch {
		return "Unknown error";
	}
}

export async function resolveRepoAuth(
	repo: RepoIntegrationRow,
	/**
	 * Scopes the `GITHUB_OAUTH_APP` client-credential lookup to the org/user
	 * record. Without it a deployment that configures its OAuth app in the DB
	 * (rather than env vars) resolves no credentials and cannot refresh.
	 */
	ctx?: { userId?: string | null; organizationId?: string | null },
): Promise<RepoAuth> {
	// PAT-connected GitHub/GitLab. Handled before the OAuth branches because
	// those are gated on `authMethod === "OAUTH"`, so a PAT row previously fell
	// all the way through to "unsupported" and every daily-brief collector and
	// security scan silently skipped the repository — even though the PAT
	// authenticates fine. The canonical resolver returns a stored PAT untouched
	// for any provider; PATs carry no expiry, so there is nothing to refresh.
	if (
		repo.authMethod === "PAT" &&
		(repo.provider === "GITHUB" || repo.provider === "GITLAB")
	) {
		if (!repo.encryptedPat) {
			return {
				kind: "unsupported",
				reason: "No PAT on integration (not yet authorized?)",
			};
		}
		const { token } = await resolveFreshRepoTokenForRow(repo, ctx);
		if (!token) {
			return {
				kind: "unsupported",
				reason: `Failed to decrypt the stored ${repo.provider === "GITHUB" ? "GitHub" : "GitLab"} PAT`,
			};
		}
		return repo.provider === "GITHUB"
			? { kind: "github", token }
			: // GitLab accepts a PAT as a bearer token, and the clone URL builder
				// already treats it like any other GitLab secret. No refresh path
				// exists or is needed, so `getToken` just yields the PAT.
				{ kind: "gitlab", getToken: async () => token };
	}

	if (repo.provider === "GITHUB" && repo.authMethod === "OAUTH") {
		if (!repo.encryptedAccessToken) {
			return {
				kind: "unsupported",
				reason: "No access token on integration (not yet authorized?)",
			};
		}
		// GitHub App user tokens die after 8 hours, so the stored token is
		// usable for only the first sliver of a connection's life. Resolve
		// through the canonical refresh-aware helper — this branch used to
		// decrypt directly, which left every daily-brief and security-scan run
		// authenticating with a long-dead token while the GitLab branch beside
		// it refreshed correctly.
		const { token } = await resolveFreshRepoTokenForRow(repo, ctx);
		if (!token) {
			// The row HAS an access token (checked above) and the resolver falls
			// back to decrypting it whenever a refresh is unavailable or fails,
			// so a null here means the stored ciphertext could not be decrypted.
			return {
				kind: "unsupported",
				reason: "Failed to decrypt the stored GitHub access token",
			};
		}
		return { kind: "github", token };
	}

	if (repo.provider === "GITLAB" && repo.authMethod === "OAUTH") {
		const encrypted = repo.encryptedAccessToken;
		if (!encrypted) {
			return {
				kind: "unsupported",
				reason: "No access token on integration (not yet authorized?)",
			};
		}
		const clientId = process.env.GITLAB_CLIENT_ID;
		const clientSecret = process.env.GITLAB_CLIENT_SECRET;
		// Refresh-aware path mirrors repo-health-check.ts:393-411. Without env
		// OAuth creds or a refresh token we degrade to the stored token and let
		// 401 surface as that repo's failure entry.
		const getToken =
			clientId && clientSecret && repo.encryptedRefreshToken
				? () =>
						getValidGitLabAccessToken({
							db: db as never,
							integrationId: repo.integrationId,
							clientId,
							clientSecret,
							source: "project",
							refresh: refreshGitLabToken,
							// FR-7: cross-process single-flight. Without `prisma` the
							// helper degrades to an in-process map — two Temporal
							// workers could refresh the same integration concurrently.
							prisma: db as never,
						})
				: async () => decryptApiKey(encrypted);
		return { kind: "gitlab", getToken };
	}

	if (repo.provider === "AZURE_DEVOPS" && repo.authMethod === "PAT") {
		if (!repo.encryptedPat) {
			return {
				kind: "unsupported",
				reason: "No PAT on integration (not yet authorized?)",
			};
		}
		const parsed = parseAdoRepositoryUrl(repo.repositoryUrl);
		const organization =
			repo.azureOrganization ?? parsed?.organization ?? null;
		if (!parsed || !organization) {
			return {
				kind: "unsupported",
				reason: "Cannot parse Azure DevOps repository URL",
			};
		}
		let pat: string;
		try {
			pat = decryptApiKey(repo.encryptedPat);
		} catch (err) {
			return {
				kind: "unsupported",
				reason: `Failed to decrypt PAT: ${errorMessage(err)}`,
			};
		}
		return {
			kind: "ado",
			basicAuth: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
			organization,
			project: parsed.project,
		};
	}

	return {
		kind: "unsupported",
		reason: `Unsupported provider/auth combination: ${repo.provider}/${repo.authMethod}`,
	};
}
