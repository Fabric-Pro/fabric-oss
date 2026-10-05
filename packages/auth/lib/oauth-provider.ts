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
 *   - The organization, or the one project, is bound at consent time.
 *     `consentReferenceId` returns it and the plugin writes it to the consent
 *     and to every token, so a token reaches one organization however many its
 *     owner belongs to, or one project of it. A project is bound when the
 *     client asked for it as the `resource` of its authorization; see
 *     `./oauth-project-binding`. Membership, or access to the project, is
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
	findLiveOAuthAuthorizationResource,
	hashOAuthToken,
	isOrganizationMember,
	OAUTH_ACCESS_TOKEN_PREFIX,
	OAUTH_REFRESH_TOKEN_PREFIX,
	type OAuthAuthorizationResourceBinding,
	resolveOAuthProjectGrantTarget,
	resolveUserOrganization,
} from "@repo/database";
import { buildProjectReference } from "@repo/utils/oauth-project-resource";
import { APIError } from "better-auth/api";
import { parse as parseCookies } from "cookie";
import { PROJECT_ACCESS_DENIED_DESCRIPTION } from "./oauth-project-binding";
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

async function refuseUntilPasswordChanged(userId: string): Promise<void> {
	if (await mustChangePasswordFirst(userId)) {
		throw new APIError("FORBIDDEN", {
			error: "access_denied",
			error_description:
				"Change your password before authorizing an agent.",
		});
	}
}

/**
 * The authorization in flight, as the plugin keeps it in its signed query:
 * which client asked, with which PKCE challenge. Set at `/oauth2/authorize`
 * itself and again from the query the consent and continue calls carry.
 */
async function authorizationInFlight(): Promise<{
	clientId: string;
	codeChallenge: string;
} | null> {
	const query = (await getOAuthProviderState())?.query;
	if (!query) {
		return null;
	}
	const params = new URLSearchParams(query);
	const clientId = params.get("client_id");
	const codeChallenge = params.get("code_challenge");
	return clientId && codeChallenge ? { clientId, codeChallenge } : null;
}

/** The project the authorization in flight asked to be bound to, while that is still live. */
async function liveProjectBinding(): Promise<OAuthAuthorizationResourceBinding | null> {
	const inFlight = await authorizationInFlight();
	return inFlight
		? findLiveOAuthAuthorizationResource(
				inFlight.clientId,
				inFlight.codeChallenge,
			)
		: null;
}

/**
 * What an authorization is for, as the reference the plugin stores on the
 * consent and on every token: the one project its client asked for as the
 * `resource`, or the organization it is for.
 *
 * Both arms refuse a pending password change, here, so no route around the
 * consent pages skips it. A project arm also refuses a person who cannot read
 * the project, and says so in words the consent and error pages show: a project
 * that does not exist, or is deleted, is answered the same way.
 */
async function resolveConsentReferenceId(
	userId: string,
	activeOrganizationId: unknown,
): Promise<string> {
	const binding = await liveProjectBinding();
	if (!binding) {
		return resolveConsentOrganizationId(userId, activeOrganizationId);
	}

	await refuseUntilPasswordChanged(userId);
	const target = await resolveOAuthProjectGrantTarget(
		userId,
		binding.projectId,
	);
	if (!target) {
		throw new APIError("FORBIDDEN", {
			error: "access_denied",
			error_description: PROJECT_ACCESS_DENIED_DESCRIPTION,
		});
	}
	return buildProjectReference(binding.audience, binding.projectId);
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
async function resolveConsentOrganizationId(
	userId: string,
	activeOrganizationId: unknown,
): Promise<string> {
	await refuseUntilPasswordChanged(userId);

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
 * Whether this authorization has to stop at the organization page before the
 * consent page.
 *
 * An authorization bound to a project has no organization to choose: the
 * project's own is the one. It stops there only when the person cannot read the
 * project, so the page can say so instead of the browser landing on a bare
 * error answer.
 *
 * Otherwise, more than one organization means the person has to say which, once
 * per authorization. The plugin re-runs `/oauth2/authorize` when the
 * organization page continues and asks this again, so the answer has to change
 * once the choice is made: the page records it in a cookie holding this
 * authorization's `code_challenge`, and a match ends the question for this
 * authorization only. The cookie only skips a question — the organization
 * itself is the session's active one, set by the page and re-checked for
 * membership in `resolveConsentOrganizationId` — so a forged cookie gains
 * nothing.
 */
async function needsPostLoginPage(
	userId: string,
	headers: Headers,
): Promise<boolean> {
	const binding = await liveProjectBinding();
	if (binding) {
		return !(await resolveOAuthProjectGrantTarget(
			userId,
			binding.projectId,
		));
	}
	if ((await db.member.count({ where: { userId } })) <= 1) {
		return false;
	}
	const challenge = (await authorizationInFlight())?.codeChallenge;
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
				needsPostLoginPage(user.id, headers),
			consentReferenceId: ({ user, session }) =>
				resolveConsentReferenceId(
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
