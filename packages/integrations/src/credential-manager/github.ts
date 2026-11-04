/**
 * GitHub adapter for the credential manager (ADR-026): refreshes a stored
 * GitHub App user grant, which GitHub expires after 8 hours, and reads the
 * account a credential saved without one acts as.
 *
 * Registered when this module loads. The credential-manager entry point
 * imports it, so every process that can call `resolveCredential` (api,
 * Temporal worker, web routes reading repositories through `repo-auth`) has
 * it registered before the first call.
 */

import { readGitHubTokenAccount } from "@repo/connectors";
import type { CredentialSecret } from "@repo/database";
import {
	exchangeGitHubRefreshToken,
	GITHUB_REFRESH_EXCHANGE_BUDGET_MS,
	resolveGitHubRefreshClient,
} from "../github/index";
import { type CredentialAdapter, registerCredentialAdapter } from "./resolve";

type OAuthClient = { clientId: string; clientSecret: string };

function isOAuthClient(value: unknown): value is OAuthClient {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as OAuthClient).clientId === "string" &&
		typeof (value as OAuthClient).clientSecret === "string"
	);
}

/** No scope in the response keeps the stored ones. */
function parseScopes(scope: string | null): string[] | undefined {
	if (!scope) {
		return undefined;
	}
	return [
		...new Set(
			scope
				.split(/[,\s]+/)
				.map((s) => s.trim())
				.filter(Boolean),
		),
	];
}

/** Deadline for the account read on first use. */
const ACCOUNT_READ_TIMEOUT_MS = 5_000;

function isGitHubDotCom(origin: string): boolean {
	try {
		const host = new URL(origin).hostname.toLowerCase();
		return host === "github.com" || host === "www.github.com";
	} catch {
		return false;
	}
}

const githubCredentialAdapter: CredentialAdapter = {
	provider: "GITHUB",
	// `GET /user` with the stored token. Only github.com is asked; an
	// Enterprise origin keeps no account until its connect flow records one.
	readAccount: async ({ credential, token }) => {
		if (!isGitHubDotCom(credential.origin)) {
			return null;
		}
		const account = await readGitHubTokenAccount({
			pat: token,
			signal: AbortSignal.timeout(ACCOUNT_READ_TIMEOUT_MS),
		});
		if (!account.ok) {
			return null;
		}
		// A token's scopes are what GitHub reports (none for a fine-grained
		// one). A sign-in keeps the scopes it was granted with unless GitHub
		// names some: a GitHub App user token reports none.
		const scopes =
			credential.kind === "PAT" || account.scopes.length > 0
				? account.scopes
				: undefined;
		return { id: account.id, login: account.login, scopes };
	},
	prepareRefresh: async ({ credential, secret }) =>
		resolveGitHubRefreshClient({
			issuer:
				typeof secret.issuer === "string" ? secret.issuer : undefined,
			userId: credential.userId ?? undefined,
			organizationId: credential.organizationId,
		}).catch(() => null),
	refresh: async ({ secret, prepared, assertBudget }) => {
		// No client (unconfigured, lookup failed, or not the issuer) is the
		// deployment's fault, never the grant's.
		if (!isOAuthClient(prepared)) {
			return { ok: false, reason: "unavailable" };
		}
		if (typeof secret.refreshToken !== "string" || !secret.refreshToken) {
			return { ok: false, reason: "unavailable" };
		}
		// Too little of the lock's transaction left: an exchange it cannot
		// persist would burn GitHub's single-use refresh token.
		try {
			assertBudget?.(GITHUB_REFRESH_EXCHANGE_BUDGET_MS);
		} catch {
			return { ok: false, reason: "unavailable" };
		}
		const exchanged = await exchangeGitHubRefreshToken({
			refreshToken: secret.refreshToken,
			client: prepared,
		});
		if (!exchanged.ok) {
			return { ok: false, reason: exchanged.reason };
		}
		const next: CredentialSecret = {
			...secret,
			accessToken: exchanged.accessToken,
			// GitHub rotates the refresh token; keep the old one only when it
			// did not send a new one.
			refreshToken: exchanged.refreshToken ?? secret.refreshToken,
		};
		return {
			ok: true,
			secret: next,
			expiresAt: exchanged.expiresAt,
			scopes: parseScopes(exchanged.scope),
		};
	},
};

registerCredentialAdapter(githubCredentialAdapter);
