/**
 * The OAuth 2.1 authorization server a coding agent signs in through.
 *
 * Built on the `@better-auth/oauth-provider` plugin, not on the older `mcp`
 * plugin: that one shows consent only when a client asks for it, has no
 * resource check and is deprecated. Here consent is always shown the first time
 * for a (client, user, organization), and the organization is part of what is
 * consented to.
 *
 * Decisions that shape every other file touching this:
 *
 *   - Access tokens are OPAQUE and stored as a sha256 digest
 *     (`disableJwtPlugin`, `storeTokens.hash`). The gateway and the v1 API
 *     verify one with a single indexed lookup by our own digest, and revoking
 *     takes effect at the next request. See `verifyOAuthAccessToken`.
 *   - The organization is bound at consent time. `consentReferenceId` returns
 *     it and the plugin writes it to the consent and to every token, so a token
 *     reaches one organization however many its owner belongs to. Membership is
 *     re-read live on every request.
 *   - Scopes are the ceiling of the Connect dialog's coding-instructions key
 *     and nothing more. See `./oauth-scopes`.
 */

import {
	getOAuthProviderState,
	oauthProvider,
} from "@better-auth/oauth-provider";
import {
	db,
	hashOAuthToken,
	isOrganizationMember,
	OAUTH_ACCESS_TOKEN_PREFIX,
	OAUTH_REFRESH_TOKEN_PREFIX,
	resolveUserOrganization,
} from "@repo/database";
import { APIError } from "better-auth/api";
import { parse as parseCookies } from "cookie";
import {
	OAUTH_ORGANIZATION_CHOSEN_COOKIE,
	OAUTH_SCOPES,
	oauthValidAudiences,
} from "./oauth-scopes";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

const OAUTH_LOGIN_PAGE = "/auth/login";
const OAUTH_CONSENT_PAGE = "/auth/oauth/consent";
const OAUTH_ORGANIZATION_PAGE = "/auth/oauth/organization";

/**
 * Plugin endpoints Fabric does not offer, answered 404 by Better Auth's router
 * (`disabledPaths`). Without this any signed-in person could create a client
 * with any redirect URI and grant type through `/oauth2/create-client`, or
 * rewrite one through `/oauth2/update-client`, past the registration policy
 * that only `/oauth2/register` runs. The consent endpoints go too: a consent
 * deleted on its own would leave its tokens alive, so revoking happens only
 * through the Connected agents page, which removes both.
 *
 * What stays: register, authorize, consent, continue, token, revoke,
 * introspect, and `/oauth2/public-client`, which the consent page reads the
 * client's name from.
 */
export const OAUTH_DISABLED_PATHS = [
	"/oauth2/create-client",
	"/oauth2/get-client",
	"/oauth2/get-clients",
	"/oauth2/update-client",
	"/oauth2/client/rotate-secret",
	"/oauth2/delete-client",
	"/oauth2/get-consent",
	"/oauth2/get-consents",
	"/oauth2/update-consent",
	"/oauth2/delete-consent",
] as const;

/**
 * Someone who has to change their password first may not authorize an agent.
 * Read live rather than from the session: the session's cookie cache can be
 * minutes behind the flag in either direction.
 */
async function mustChangePasswordFirst(userId: string): Promise<boolean> {
	const user = await db.user.findUnique({
		where: { id: userId },
		select: { mustChangePassword: true },
	});
	return user?.mustChangePassword === true;
}

/**
 * The organization an authorization is for: the session's active one when the
 * person still belongs to it, else the only one they have.
 *
 * Throws rather than returning nothing. A consent with no organization would
 * produce a token that reaches none, and the plugin documents that this
 * function is where that has to fail.
 *
 * It is also where a pending password change refuses. The plugin calls it on
 * every path that ends in an authorization code — `/oauth2/authorize` itself
 * (which issues a code straight away when a consent already exists, with no
 * page in between), `/oauth2/consent`, `/oauth2/continue`, and the sign-in
 * hook that resumes an authorization — always before the code is issued, so
 * no route around the consent pages skips it.
 */
export async function resolveConsentOrganizationId(
	userId: string,
	activeOrganizationId: unknown,
): Promise<string> {
	if (await mustChangePasswordFirst(userId)) {
		throw new APIError("FORBIDDEN", {
			error: "access_denied",
			error_description:
				"Change your password before authorizing an agent.",
		});
	}

	if (
		typeof activeOrganizationId === "string" &&
		activeOrganizationId.length > 0 &&
		(await isOrganizationMember(userId, activeOrganizationId))
	) {
		return activeOrganizationId;
	}

	const resolution = await resolveUserOrganization(userId);
	if (resolution.kind === "resolved") {
		return resolution.organizationId;
	}

	throw new APIError("BAD_REQUEST", {
		error: "invalid_request",
		error_description:
			"Choose an organization before authorizing an agent for it.",
	});
}

/**
 * Whether this authorization still has to ask which organization it is for.
 *
 * More than one organization means the person has to say which, once per
 * authorization. The plugin re-runs `/oauth2/authorize` when the organization
 * page continues and asks this again, so the answer has to change once the
 * choice is made: the page records it in a cookie holding this authorization's
 * `code_challenge`, and a match ends the question for this authorization only.
 * The cookie only skips a question — the organization itself is the session's
 * active one, set by the page and re-checked for membership in
 * `resolveConsentOrganizationId` — so a forged cookie gains nothing.
 */
async function needsOrganizationChoice(
	userId: string,
	headers: Headers,
): Promise<boolean> {
	if ((await db.member.count({ where: { userId } })) <= 1) {
		return false;
	}
	const query = (await getOAuthProviderState())?.query;
	const challenge = query
		? new URLSearchParams(query).get("code_challenge")
		: null;
	const chosen = parseCookies(headers.get("cookie") ?? "")[
		OAUTH_ORGANIZATION_CHOSEN_COOKIE
	];
	return !challenge || chosen !== challenge;
}

export function createOAuthProviderPlugin(appUrl: string) {
	return oauthProvider({
		loginPage: OAUTH_LOGIN_PAGE,
		consentPage: OAUTH_CONSENT_PAGE,
		postLogin: {
			page: OAUTH_ORGANIZATION_PAGE,
			// A pending password change also goes to the organization page, which
			// the proxy turns into /change-password: a browser lands somewhere it
			// can act instead of on the 403 `consentReferenceId` would answer.
			shouldRedirect: async ({ user, headers }) =>
				(await mustChangePasswordFirst(user.id)) ||
				needsOrganizationChoice(user.id, headers),
			consentReferenceId: ({ user, session }) =>
				resolveConsentOrganizationId(
					user.id,
					session.activeOrganizationId,
				),
		},
		scopes: [...OAUTH_SCOPES],
		clientRegistrationDefaultScopes: [...OAUTH_SCOPES],
		clientRegistrationAllowedScopes: [...OAUTH_SCOPES],
		validAudiences: oauthValidAudiences(appUrl),
		allowDynamicClientRegistration: true,
		allowUnauthenticatedClientRegistration: true,
		grantTypes: ["authorization_code", "refresh_token"],
		disableJwtPlugin: true,
		storeTokens: { hash: (token) => hashOAuthToken(token) },
		prefix: {
			opaqueAccessToken: OAUTH_ACCESS_TOKEN_PREFIX,
			refreshToken: OAUTH_REFRESH_TOKEN_PREFIX,
		},
		accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
		refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
		silenceWarnings: { oauthAuthServerConfig: true },
	});
}
