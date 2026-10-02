/**
 * OAuth access tokens issued to coding agents that signed in through the
 * authorization server in `@repo/auth`.
 *
 * Tokens are opaque and stored as a sha256 hex digest, never in the clear. That
 * choice is what lets the MCP gateway and the v1 API verify a credential with
 * ONE indexed lookup by our own digest instead of decoding a signed token, and
 * it is what makes revocation immediate: deleting the row is the revocation, and
 * the next request after it is refused.
 *
 * `@repo/auth` configures the plugin to use `hashOAuthToken` and the prefixes
 * below, and the entry points call `verifyOAuthAccessToken`. Keeping all three
 * in this module is deliberate: the digest the plugin writes and the digest a
 * request looks up must be produced by the same function, or every token reads
 * as unknown.
 *
 * Membership and the owner's account are re-read on EVERY verification, like an
 * organization API key. A token proves who is asking and which organization the
 * person chose at consent time; it never proves they still belong there.
 */

import { db } from "../client";
import {
	hashOAuthToken,
	OAUTH_ACCESS_TOKEN_PREFIX,
} from "./oauth-token-format";
import { isOrganizationMember } from "./verify-organization-membership";

export {
	hashOAuthToken,
	OAUTH_ACCESS_TOKEN_PREFIX,
	OAUTH_REFRESH_TOKEN_PREFIX,
} from "./oauth-token-format";

export type OAuthAccessTokenRefusal =
	| "unknown"
	| "expired"
	| "client_disabled"
	| "user_banned"
	| "no_organization"
	| "not_a_member";

export type OAuthAccessTokenVerification =
	| {
			valid: true;
			/** `OauthAccessToken.id`. */
			tokenId: string;
			/** `OauthClient.id` — the row, not the public `client_id`. */
			clientRowId: string;
			clientName: string | null;
			userId: string;
			userName: string;
			email: string;
			role: string | null;
			/** The organization the token is bound to. Fixed at consent time. */
			organizationId: string;
			scopes: string[];
	  }
	| { valid: false; reason: OAuthAccessTokenRefusal };

const UNKNOWN: OAuthAccessTokenVerification = {
	valid: false,
	reason: "unknown",
};

/**
 * Verify a presented bearer value as an OAuth access token.
 *
 * Every refusal is a `valid: false` the caller turns into the same 401 an
 * invalid key gets, so a holder cannot tell a dead token from a departed
 * person. The reason is for logs and tests only.
 */
export async function verifyOAuthAccessToken(
	presented: string,
	now: Date = new Date(),
): Promise<OAuthAccessTokenVerification> {
	if (!presented.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
		return UNKNOWN;
	}

	const row = await db.oauthAccessToken.findUnique({
		where: {
			token: hashOAuthToken(
				presented.slice(OAUTH_ACCESS_TOKEN_PREFIX.length),
			),
		},
		select: {
			id: true,
			userId: true,
			referenceId: true,
			scopes: true,
			expiresAt: true,
			client: { select: { id: true, name: true, disabled: true } },
			user: {
				select: {
					id: true,
					name: true,
					email: true,
					role: true,
					banned: true,
					banExpires: true,
				},
			},
		},
	});

	if (!row?.user) {
		return UNKNOWN;
	}
	if (!row.expiresAt || row.expiresAt <= now) {
		return { valid: false, reason: "expired" };
	}
	if (row.client.disabled === true) {
		return { valid: false, reason: "client_disabled" };
	}
	if (
		row.user.banned &&
		(!row.user.banExpires || row.user.banExpires > now)
	) {
		return { valid: false, reason: "user_banned" };
	}
	if (!row.referenceId) {
		return { valid: false, reason: "no_organization" };
	}

	// The same helper the API-key paths ask, so a liveness rule added there
	// reaches signed-in agents too.
	if (!(await isOrganizationMember(row.user.id, row.referenceId))) {
		return { valid: false, reason: "not_a_member" };
	}

	return {
		valid: true,
		tokenId: row.id,
		clientRowId: row.client.id,
		clientName: row.client.name,
		userId: row.user.id,
		userName: row.user.name,
		email: row.user.email,
		role: row.user.role,
		organizationId: row.referenceId,
		scopes: row.scopes,
	};
}

export interface OAuthConnection {
	/** `OauthConsent.id`. Pass it back to `revokeOAuthConnection`. */
	consentId: string;
	clientName: string | null;
	organizationId: string | null;
	organizationName: string | null;
	scopes: string[];
	createdAt: Date | null;
}

/** The agents a person has signed in, one row per (client, organization). */
export async function listOAuthConnections(
	userId: string,
): Promise<OAuthConnection[]> {
	const consents = await db.oauthConsent.findMany({
		where: { userId },
		orderBy: { createdAt: "desc" },
		select: {
			id: true,
			referenceId: true,
			scopes: true,
			createdAt: true,
			client: { select: { name: true } },
		},
	});

	const organizationIds = [
		...new Set(
			consents.flatMap((consent) =>
				consent.referenceId ? [consent.referenceId] : [],
			),
		),
	];
	const organizations = organizationIds.length
		? await db.organization.findMany({
				where: { id: { in: organizationIds } },
				select: { id: true, name: true },
			})
		: [];
	const organizationNames = new Map(
		organizations.map((organization) => [
			organization.id,
			organization.name,
		]),
	);

	return consents.map((consent) => ({
		consentId: consent.id,
		clientName: consent.client.name,
		organizationId: consent.referenceId,
		organizationName: consent.referenceId
			? (organizationNames.get(consent.referenceId) ?? null)
			: null,
		scopes: consent.scopes,
		createdAt: consent.createdAt,
	}));
}

export interface RevokedOAuthConnection {
	/** The public `client_id`, not the row id. */
	clientId: string;
	clientName: string | null;
	organizationId: string | null;
}

/**
 * Revoke one agent's access: the consent AND every token issued under it.
 *
 * The plugin's own consent deletion removes only the consent row, which would
 * leave a live access token and a refresh token that mints more — so revoking
 * here deletes all three, in one transaction. Access tokens go first because
 * they reference the refresh tokens.
 *
 * The client registration stays. An agent keeps the `client_id` it registered
 * and signs in with it again after a revoke; deleting the client would leave
 * it holding an id the server no longer knows, and a sign-in that ends on an
 * error page.
 *
 * Returns null when the consent is not this user's, which is also the answer
 * for one that does not exist.
 */
export async function revokeOAuthConnection(params: {
	userId: string;
	consentId: string;
}): Promise<RevokedOAuthConnection | null> {
	const { userId, consentId } = params;

	return db.$transaction(async (tx) => {
		const consent = await tx.oauthConsent.findFirst({
			where: { id: consentId, userId },
			select: {
				clientId: true,
				referenceId: true,
				client: { select: { name: true } },
			},
		});
		if (!consent) {
			return null;
		}

		const scope = {
			clientId: consent.clientId,
			userId,
			referenceId: consent.referenceId,
		};
		await tx.oauthAccessToken.deleteMany({ where: scope });
		await tx.oauthRefreshToken.deleteMany({ where: scope });
		await tx.oauthConsent.delete({ where: { id: consentId } });

		return {
			clientId: consent.clientId,
			clientName: consent.client.name,
			organizationId: consent.referenceId,
		};
	});
}
