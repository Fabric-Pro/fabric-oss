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
 * organization API key. A token proves who is asking and which organization, or
 * which single project, the person chose at consent time; it never proves they
 * still belong there.
 */

import {
	type OAuthProjectAudience,
	parseOAuthReference,
	staticResourceFor,
} from "@repo/utils/oauth-project-resource";
import { db } from "../client";
import { resolveOAuthProjectGrantTarget } from "./oauth-project-grant";
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
	| "revoked"
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
			/**
			 * The organization the token is bound to, fixed at consent time. For a
			 * project grant, the organization hosting the project.
			 */
			organizationId: string;
			/** The one project a project grant reaches; null for an organization grant. */
			projectId: string | null;
			/** Which surface a project grant reaches; null for an organization grant. */
			audience: OAuthProjectAudience | null;
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
 * invalid key gets. The receiving resource uses the deployment URL from trusted
 * configuration, never the request URL or Host header. A holder cannot tell a dead
 * token from a departed
 * person. The reason is for logs and tests only.
 */
export async function verifyOAuthAccessToken(
	presented: string,
	resource: { appUrl: string; audience: OAuthProjectAudience },
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
			resources: true,
			expiresAt: true,
			revoked: true,
			confirmation: true,
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
	// These endpoints verify bearer tokens only. A proof-bound token must not
	// become a bearer credential just because its caller omits the proof.
	if (row.confirmation !== null) {
		return UNKNOWN;
	}
	// Resource identifiers are an independent boundary from the tenant reference.
	// Legacy grants are expanded to all configured resources before activation;
	// empty or malformed lists must never recover that wider legacy access.
	const mcpResource = staticResourceFor(resource.appUrl, "mcp");
	const apiResource = staticResourceFor(resource.appUrl, "api");
	const configured = new Set([mcpResource, `${mcpResource}/`, apiResource]);
	const expected =
		resource.audience === "mcp"
			? [mcpResource, `${mcpResource}/`]
			: [apiResource];
	if (
		!Array.isArray(row.resources) ||
		row.resources.length === 0 ||
		!row.resources.every(
			(identifier) =>
				typeof identifier === "string" && configured.has(identifier),
		) ||
		!expected.some((identifier) => row.resources.includes(identifier))
	) {
		return UNKNOWN;
	}
	if (row.revoked) {
		return { valid: false, reason: "revoked" };
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
	const reference = row.referenceId
		? parseOAuthReference(row.referenceId)
		: null;
	if (!reference) {
		return { valid: false, reason: "no_organization" };
	}

	const holder = {
		tokenId: row.id,
		clientRowId: row.client.id,
		clientName: row.client.name,
		userId: row.user.id,
		userName: row.user.name,
		email: row.user.email,
		role: row.user.role,
		scopes: row.scopes,
	};

	if (reference.kind === "project") {
		const target = await resolveOAuthProjectGrantTarget(
			row.user.id,
			reference.projectId,
		);
		if (!target) {
			return { valid: false, reason: "not_a_member" };
		}
		return {
			valid: true,
			...holder,
			organizationId: target.organizationId,
			projectId: reference.projectId,
			audience: reference.audience,
		};
	}

	// The same helper the API-key paths ask, so a liveness rule added there
	// reaches signed-in agents too.
	if (!(await isOrganizationMember(row.user.id, reference.organizationId))) {
		return { valid: false, reason: "not_a_member" };
	}

	return {
		valid: true,
		...holder,
		organizationId: reference.organizationId,
		projectId: null,
		audience: null,
	};
}

export interface OAuthConnection {
	/** `OauthConsent.id`. Pass it back to `revokeOAuthConnection`. */
	consentId: string;
	clientName: string | null;
	/** The organization of an organization grant, or hosting a project grant's project. */
	organizationId: string | null;
	organizationName: string | null;
	/** Set for a project grant; null for an organization grant. */
	projectId: string | null;
	/** Null when the person can no longer read the project, or it is gone. */
	projectName: string | null;
	audience: OAuthProjectAudience | null;
	scopes: string[];
	createdAt: Date | null;
}

function grantKey(clientId: string, referenceId: string | null): string {
	return `${clientId}\u0000${referenceId ?? ""}`;
}

/**
 * The agents a person has signed in, one row per grant: a (client, organization)
 * pair or a (client, project) pair.
 *
 * Only a grant that can still do something is listed: a consent whose access and
 * refresh tokens are all expired, spent or deleted is a record of the past. A
 * CLI that signed out leaves exactly that behind, and listing it told the person
 * an agent stayed signed in when nothing would let it back in.
 */
export async function listOAuthConnections(
	userId: string,
	now: Date = new Date(),
): Promise<OAuthConnection[]> {
	const [consents, liveAccess, liveRefresh] = await Promise.all([
		db.oauthConsent.findMany({
			where: { userId },
			orderBy: { createdAt: "desc" },
			select: {
				id: true,
				clientId: true,
				referenceId: true,
				scopes: true,
				createdAt: true,
				client: { select: { name: true } },
			},
		}),
		db.oauthAccessToken.findMany({
			where: { userId, revoked: null, expiresAt: { gt: now } },
			select: { clientId: true, referenceId: true },
			distinct: ["clientId", "referenceId"],
		}),
		db.oauthRefreshToken.findMany({
			where: { userId, revoked: null, expiresAt: { gt: now } },
			select: { clientId: true, referenceId: true },
			distinct: ["clientId", "referenceId"],
		}),
	]);

	const liveGrants = new Set(
		[...liveAccess, ...liveRefresh].map((token) =>
			grantKey(token.clientId, token.referenceId),
		),
	);
	const live = consents
		.filter((consent) =>
			liveGrants.has(grantKey(consent.clientId, consent.referenceId)),
		)
		.map((consent) => ({
			consent,
			reference: consent.referenceId
				? parseOAuthReference(consent.referenceId)
				: null,
		}));

	const organizationIds = [
		...new Set(
			live.flatMap(({ reference }) =>
				reference?.kind === "organization"
					? [reference.organizationId]
					: [],
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

	const projectIds = [
		...new Set(
			live.flatMap(({ reference }) =>
				reference?.kind === "project" ? [reference.projectId] : [],
			),
		),
	];
	const projectTargets = new Map(
		await Promise.all(
			projectIds.map(
				async (projectId) =>
					[
						projectId,
						await resolveOAuthProjectGrantTarget(userId, projectId),
					] as const,
			),
		),
	);

	return live.map(({ consent, reference }) => {
		const base = {
			consentId: consent.id,
			clientName: consent.client.name,
			scopes: consent.scopes,
			createdAt: consent.createdAt,
		};
		if (reference?.kind === "project") {
			const target = projectTargets.get(reference.projectId) ?? null;
			return {
				...base,
				organizationId: target?.organizationId ?? null,
				organizationName: target?.organizationName ?? null,
				projectId: reference.projectId,
				projectName: target?.projectName ?? null,
				audience: reference.audience,
			};
		}
		return {
			...base,
			organizationId: consent.referenceId,
			organizationName:
				reference?.kind === "organization"
					? (organizationNames.get(reference.organizationId) ?? null)
					: null,
			projectId: null,
			projectName: null,
			audience: null,
		};
	});
}

export interface RevokedOAuthConnection {
	/** The public `client_id`, not the row id. */
	clientId: string;
	clientName: string | null;
	/** The organization of the grant, or hosting its project. */
	organizationId: string | null;
	projectId: string | null;
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

		const reference = consent.referenceId
			? parseOAuthReference(consent.referenceId)
			: null;
		if (reference?.kind === "project") {
			const project = await tx.project.findUnique({
				where: { id: reference.projectId },
				select: { organizationId: true },
			});
			return {
				clientId: consent.clientId,
				clientName: consent.client.name,
				organizationId: project?.organizationId ?? null,
				projectId: reference.projectId,
			};
		}
		return {
			clientId: consent.clientId,
			clientName: consent.client.name,
			organizationId: consent.referenceId,
			projectId: null,
		};
	});
}
