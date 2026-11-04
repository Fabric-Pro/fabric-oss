/**
 * The one check a GitHub personal access token passes before Fabric saves
 * it, whichever form it was pasted into: the credential manager's "New"
 * dialog, a replaced secret, or a repository import / connect form.
 *
 * - `GET /user` names the account the token acts as (stored on the row).
 * - A classic token reports its scopes; it must hold every scope Fabric asks
 *   a GitHub sign-in for (`GITHUB_OAUTH_SCOPES`, implied scopes counted).
 * - A fine-grained token reports none, so its repository permissions are
 *   shown to the person, who confirms them before it is saved.
 * - GitHub refusing the token (401) refuses the save. GitHub being
 *   unreachable does not: the account is read later, on first use.
 *
 * The token is only sent to GitHub; it is never logged or put in an error.
 */

import { ORPCError } from "@orpc/server";
import {
	canGitHubTokenListRepositories,
	readGitHubTokenAccount,
} from "@repo/connectors";
import { expandScopes } from "@repo/integrations/credential-manager";
import {
	GITHUB_FINE_GRAINED_PERMISSIONS,
	GITHUB_OAUTH_SCOPES,
} from "@repo/utils/github-oauth-scopes";

/** Deadline for each GitHub call made while saving. */
const GITHUB_CHECK_TIMEOUT_MS = 8_000;

const GITHUB_TOKEN_REJECTED_MESSAGE =
	"GitHub rejected this token. Check that it was copied in full and has not expired or been revoked.";

export type GitHubTokenAccountRead = {
	id: string;
	login: string;
	scopes: string[];
};

/** The reasons a client reads from the refusal's `data`. */
type GitHubTokenCheckRefusal =
	| {
			reason: "GITHUB_TOKEN_MISSING_SCOPES";
			tokenType: "classic";
			required: string[];
			missing: string[];
	  }
	| {
			reason: "GITHUB_TOKEN_CONFIRM_PERMISSIONS";
			tokenType: "fine-grained";
			permissions: { name: string; access: "read" | "write" }[];
			canListRepositories: boolean | null;
	  };

/** The required scopes the granted ones do not cover, in Fabric's order. */
function missingGitHubScopes(granted: readonly string[]): string[] {
	const have = expandScopes("GITHUB", granted);
	return GITHUB_OAUTH_SCOPES.filter((scope) => !have.has(scope));
}

function missingScopesMessage(missing: readonly string[]): string {
	return `This token is missing: ${missing.join(", ")}. Edit it on GitHub (Settings → Developer settings → Personal access tokens) and add them, then save again.`;
}

const CONFIRM_PERMISSIONS_MESSAGE =
	"GitHub does not report a fine-grained token's permissions, so they can't be checked before use. Make sure the token has the listed repository permissions, confirm, and save again.";

async function probeRepositoryListing(token: string): Promise<boolean | null> {
	try {
		return await canGitHubTokenListRepositories({
			pat: token,
			signal: AbortSignal.timeout(GITHUB_CHECK_TIMEOUT_MS),
		});
	} catch {
		return null;
	}
}

/**
 * Checks a GitHub token about to be saved. Answers the account it acts as,
 * or `null` when GitHub could not be asked (the save goes ahead without
 * it). Throws BAD_REQUEST when GitHub rejects the token, when a classic
 * token lacks a scope, or when a fine-grained token's permissions are not
 * confirmed yet; the latter two carry a `GitHubTokenCheckRefusal` as `data`.
 */
export async function checkGitHubTokenForSave(input: {
	token: string;
	confirmFineGrainedPermissions: boolean;
}): Promise<GitHubTokenAccountRead | null> {
	let account: Awaited<ReturnType<typeof readGitHubTokenAccount>>;
	try {
		account = await readGitHubTokenAccount({
			pat: input.token,
			signal: AbortSignal.timeout(GITHUB_CHECK_TIMEOUT_MS),
		});
	} catch {
		return null;
	}
	if (!account.ok) {
		if (account.status === 401) {
			throw new ORPCError("BAD_REQUEST", {
				message: GITHUB_TOKEN_REJECTED_MESSAGE,
				data: { reason: "GITHUB_TOKEN_REJECTED" },
			});
		}
		return null;
	}

	if (account.tokenType === "classic") {
		const missing = missingGitHubScopes(account.scopes);
		if (missing.length > 0) {
			const data: GitHubTokenCheckRefusal = {
				reason: "GITHUB_TOKEN_MISSING_SCOPES",
				tokenType: "classic",
				required: [...GITHUB_OAUTH_SCOPES],
				missing,
			};
			throw new ORPCError("BAD_REQUEST", {
				message: missingScopesMessage(missing),
				data,
			});
		}
	} else if (!input.confirmFineGrainedPermissions) {
		const data: GitHubTokenCheckRefusal = {
			reason: "GITHUB_TOKEN_CONFIRM_PERMISSIONS",
			tokenType: "fine-grained",
			permissions: GITHUB_FINE_GRAINED_PERMISSIONS.map((p) => ({ ...p })),
			canListRepositories: await probeRepositoryListing(input.token),
		};
		throw new ORPCError("BAD_REQUEST", {
			message: CONFIRM_PERMISSIONS_MESSAGE,
			data,
		});
	}

	return { id: account.id, login: account.login, scopes: account.scopes };
}

/** Only github.com is asked; a GitHub Enterprise origin is saved as is. */
export function isGitHubDotComOrigin(origin: string): boolean {
	try {
		const host = new URL(origin).hostname.toLowerCase();
		return host === "github.com" || host === "www.github.com";
	} catch {
		return false;
	}
}
