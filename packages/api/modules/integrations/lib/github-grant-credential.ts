/**
 * A GitHub OAuth connect saved as the member's credential (ADR-026, phase 2
 * of the GitHub access spec §4.2).
 *
 * Runs only while `CREDENTIAL_MANAGER` is on for the organization the signed
 * OAuth state names; the callback has already verified that the session is
 * the state's user and still a member there. The legacy stores keep being
 * written by the callback (expand phase); this adds the one row consumers
 * reference.
 */

import {
	db,
	isFeatureEnabled,
	recordAuditTx,
	upsertAccountGrantCredential,
} from "@repo/database";
import { credentialAuditMetadata } from "../../credential-manager/lib/context";
import type { GitHubTokenResponse, GitHubUser } from "./github-oauth";

const GITHUB_CREDENTIAL_ORIGIN = "https://github.com";

/**
 * - `undefined`: the credential manager is off (or the state names no
 *   organization); the caller behaves exactly as before.
 * - `string`: the saved credential's id, for the consumer to reference.
 * - `null`: saving failed; the consumer must not keep pointing at an older
 *   credential, since the fresh token lives only in its legacy columns.
 */
export type SavedGrant = string | null | undefined;

function parseScopes(scope: string | undefined): string[] {
	if (!scope) {
		return [];
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

function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "P2002"
	);
}

export async function saveGitHubGrantAsCredential(input: {
	/** From the verified OAuth state, never from client input. */
	organizationId: string | null | undefined;
	user: { id: string; email?: string | null; name?: string | null };
	tokenResponse: GitHubTokenResponse;
	githubUser: GitHubUser;
	/** The OAuth client the code was exchanged with; a refresh must use it. */
	clientId: string;
}): Promise<SavedGrant> {
	const { organizationId, user, tokenResponse, githubUser } = input;
	if (!organizationId) {
		return undefined;
	}
	// A flag lookup that fails counts as off: the connect proceeds as before.
	let enabled = false;
	try {
		enabled = await isFeatureEnabled("CREDENTIAL_MANAGER", organizationId);
	} catch {
		enabled = false;
	}
	if (!enabled) {
		return undefined;
	}

	// GitHub App user-to-server tokens expire and come with a refresh token;
	// classic OAuth App tokens carry neither (same test as `hasRefreshToken`).
	const kind =
		tokenResponse.refresh_token || tokenResponse.expires_in
			? ("GITHUB_APP_USER" as const)
			: ("OAUTH" as const);
	const expiresAt = tokenResponse.expires_in
		? new Date(Date.now() + tokenResponse.expires_in * 1000)
		: null;

	const save = () =>
		db.$transaction(async (tx) => {
			const { credential, created } = await upsertAccountGrantCredential(
				{
					organizationId,
					userId: user.id,
					provider: "GITHUB",
					kind,
					origin: GITHUB_CREDENTIAL_ORIGIN,
					externalAccountId: String(githubUser.id),
					externalAccountLogin: githubUser.login,
					label: `GitHub · ${githubUser.login}`,
					scopes: parseScopes(tokenResponse.scope),
					secret: {
						accessToken: tokenResponse.access_token,
						...(tokenResponse.refresh_token
							? { refreshToken: tokenResponse.refresh_token }
							: {}),
						issuer: input.clientId,
					},
					expiresAt,
					createdByUserId: user.id,
				},
				tx,
			);
			await recordAuditTx(tx, {
				action: created
					? "account.credential.created"
					: "account.credential.updated",
				actor: {
					type: "user",
					userId: user.id,
					emailSnapshot: user.email ?? null,
					nameSnapshot: user.name ?? null,
				},
				organizationId,
				resource: {
					type: "credential",
					id: credential.id,
					name: credential.label,
				},
				metadata: credentialAuditMetadata(credential, {
					source: "github-oauth",
					...(created ? {} : { secretReplaced: true }),
				}),
			});
			return credential.id;
		});

	try {
		try {
			return await save();
		} catch (error) {
			// A concurrent first connect won the partial unique index; the
			// retry finds its row and updates it.
			if (isUniqueViolation(error)) {
				return await save();
			}
			throw error;
		}
	} catch (error) {
		// Code and name only: a Prisma message can echo the written row.
		console.error(
			"[github-oauth] Failed to save the GitHub grant as a credential:",
			(error as { code?: unknown })?.code ??
				(error instanceof Error ? error.name : "unknown error"),
		);
		return null;
	}
}
