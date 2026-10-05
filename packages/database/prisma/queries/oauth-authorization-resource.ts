/**
 * The project an agent's authorization asked to be bound to, from the first
 * request until the person has answered the consent page.
 *
 * The authorization endpoint of the plugin drops `resource` before it signs the
 * query the login, organization and consent pages carry, so nothing after the
 * first request can see which project was asked for. The authorization server
 * writes it here, keyed by the client and the request's PKCE challenge, and
 * reads it back wherever the grant's reference is decided. The key is the pair
 * the plugin itself keeps in that signed query, so no extra value has to travel
 * with the request.
 *
 * Rows are short-lived and removed in small batches as new ones are written, so
 * the table needs no sweeper of its own.
 *
 * The key is a pair anyone can send to the authorize endpoint, so a live row
 * is write-once and nothing replaces or removes it before it expires: not a
 * request, and not the exchange of a code, which anyone holding a code minted
 * beforehand for the same pair could time against the consent. What the consent
 * page showed is then what the grant is, however many other requests arrive in
 * between.
 */

import type { OAuthProjectAudience } from "@repo/utils/oauth-project-resource";
import { db } from "../client";

/**
 * How long a binding is live. Longer than the plugin's own ten-minute signed
 * query, which is reissued at every redirect: a consent page opened just before
 * the signed query lapses must still find the binding, or the answer would be
 * recorded as an organization-wide consent instead of a project one.
 */
export const OAUTH_AUTHORIZATION_RESOURCE_TTL_MS = 15 * 60 * 1000;

/**
 * The longest a binding may be kept alive from the moment it was written, however
 * often the authorization is continued. Nobody keeps a login open that long.
 */
export const OAUTH_AUTHORIZATION_RESOURCE_MAX_LIFETIME_MS = 30 * 60 * 1000;

const EXPIRED_ROWS_PER_WRITE = 50;

export interface OAuthAuthorizationResourceBinding {
	resource: string;
	projectId: string;
	audience: OAuthProjectAudience;
}

function toAudience(value: string): OAuthProjectAudience | null {
	return value === "mcp" || value === "api" ? value : null;
}

/**
 * Record what one authorization asked for, unless it already has a live
 * binding, and answer with the one that stands: the new one, or the one that was
 * there first. A binding that has expired is replaced like none at all. A client
 * that starts the authorization again for something else uses a new PKCE
 * challenge, which is a new key.
 */
export async function saveOAuthAuthorizationResource(
	params: OAuthAuthorizationResourceBinding & {
		clientId: string;
		codeChallenge: string;
	},
	now: Date = new Date(),
): Promise<OAuthAuthorizationResourceBinding | null> {
	const { clientId, codeChallenge, resource, projectId, audience } = params;
	const expiresAt = new Date(
		now.getTime() + OAUTH_AUTHORIZATION_RESOURCE_TTL_MS,
	);

	await db.oauthAuthorizationResource.deleteMany({
		where: { clientId, codeChallenge, expiresAt: { lte: now } },
	});
	await db.oauthAuthorizationResource.createMany({
		data: [
			{
				clientId,
				codeChallenge,
				resource,
				projectId,
				audience,
				expiresAt,
			},
		],
		skipDuplicates: true,
	});

	const expired = await db.oauthAuthorizationResource.findMany({
		where: { expiresAt: { lt: now } },
		select: { id: true },
		take: EXPIRED_ROWS_PER_WRITE,
	});
	if (expired.length > 0) {
		await db.oauthAuthorizationResource.deleteMany({
			where: { id: { in: expired.map((row) => row.id) } },
		});
	}

	return findLiveOAuthAuthorizationResource(clientId, codeChallenge, now);
}

/** The live binding of one authorization, or null when it has none. */
export async function findLiveOAuthAuthorizationResource(
	clientId: string,
	codeChallenge: string,
	now: Date = new Date(),
): Promise<OAuthAuthorizationResourceBinding | null> {
	const row = await db.oauthAuthorizationResource.findUnique({
		where: { clientId_codeChallenge: { clientId, codeChallenge } },
		select: {
			resource: true,
			projectId: true,
			audience: true,
			expiresAt: true,
		},
	});
	const audience = row ? toAudience(row.audience) : null;
	if (!row || !audience || row.expiresAt <= now) {
		return null;
	}
	return { resource: row.resource, projectId: row.projectId, audience };
}

/**
 * Keep a live binding alive while the authorization it belongs to is still
 * being walked through login and consent, never past the longest a binding may
 * live. A lapsed one is left alone.
 */
export async function extendOAuthAuthorizationResource(
	clientId: string,
	codeChallenge: string,
	now: Date = new Date(),
): Promise<void> {
	const row = await db.oauthAuthorizationResource.findUnique({
		where: { clientId_codeChallenge: { clientId, codeChallenge } },
		select: { createdAt: true, expiresAt: true },
	});
	if (!row || row.expiresAt <= now) {
		return;
	}

	const extendedTo = Math.min(
		now.getTime() + OAUTH_AUTHORIZATION_RESOURCE_TTL_MS,
		row.createdAt.getTime() + OAUTH_AUTHORIZATION_RESOURCE_MAX_LIFETIME_MS,
	);
	if (extendedTo <= row.expiresAt.getTime()) {
		return;
	}
	await db.oauthAuthorizationResource.updateMany({
		where: { clientId, codeChallenge, expiresAt: { gt: now } },
		data: { expiresAt: new Date(extendedTo) },
	});
}
