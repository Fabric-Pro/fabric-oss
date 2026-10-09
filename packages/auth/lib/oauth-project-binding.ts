/**
 * Binding an agent's authorization to one project.
 *
 * An MCP client that is configured with a project's URL asks for that project
 * as the `resource` of its authorization (RFC 8707). The plugin the
 * authorization server is built on accepts only the configured static resources
 * at both authorize and token. Three global before-hooks preserve the project
 * grant while passing its static audience to the provider:
 *
 *   - at authorize, the request's project is written down against the client
 *     and the PKCE challenge, then its resource is normalized to the audience
 *     the plugin keeps in its signed query (see `oauth-authorization-resource`);
 *   - at consent, the grant the page showed must be the one the server would
 *     issue, or nothing is issued; and
 *   - at token, a project resource is checked against the grant's own
 *     reference, the project the person consented to, and swapped for the
 *     static resource stored on the code. The resource selects the surface;
 *     the reference on the grant is what keeps the token on its project.
 *
 * The authorize endpoint is open to anyone who can name a client and a
 * challenge, so a live binding is write-once and nothing removes it but its
 * expiry: not a request, and not the exchange of a code. A request that names
 * no resource keeps the shared organization surfaces by passing all configured
 * resources to the provider. An explicit resource remains limited to that
 * surface.
 */

import {
	extendOAuthAuthorizationResource,
	findLiveOAuthAuthorizationResource,
	hashOAuthToken,
	OAUTH_REFRESH_TOKEN_PREFIX,
	type OAuthAuthorizationResourceBinding,
	resolveOAuthProjectGrantTarget,
	saveOAuthAuthorizationResource,
} from "@repo/database";
import {
	buildProjectReference,
	isProjectId,
	looksLikeProjectResource,
	OAUTH_DISPLAYED_BINDING_FIELD,
	OAUTH_DISPLAYED_ORGANIZATION_FIELD,
	type OAuthProjectAudience,
	parseOAuthReference,
	parseProjectResource,
	staticResourceFor,
} from "@repo/utils/oauth-project-resource";
import { APIError } from "better-auth/api";
import {
	type AuthorizeRefusalContext,
	refusalForClient,
} from "./oauth-client-redirect";
import { oauthValidAudiences } from "./oauth-scopes";

interface OAuthResourceHookContext {
	path?: string;
	method?: string;
	/** Set by the provider when it resumes authorize through its dispatcher. */
	authorizeSettings?: { isAuthorize?: boolean };
	query?: unknown;
	body?: unknown;
	context: {
		internalAdapter: {
			findVerificationValue(
				identifier: string,
			): Promise<{ value: string } | null>;
		};
		adapter: {
			findOne(args: {
				model: string;
				where: Array<{ field: string; value: string }>;
			}): Promise<{
				referenceId?: string | null;
				disabled?: boolean | null;
				redirectUris?: string[] | null;
			} | null>;
		};
	};
}

/** The after-hook's view of a consent: the adapter, and what the endpoint returned. */
export type OAuthIssuedGrantContext = Pick<
	OAuthResourceHookContext,
	"context"
> & {
	context: { returned?: unknown };
};

/** What the authorize hook needs beyond the others: to answer a refusal to the client. */
export interface OAuthAuthorizeHookContext
	extends OAuthResourceHookContext,
		AuthorizeRefusalContext {
	context: OAuthResourceHookContext["context"] &
		AuthorizeRefusalContext["context"];
}

export interface OAuthResourceHookDeps {
	appUrl: string;
	/** The signed-in person, when there is one. Read lazily: most requests need none. */
	getSessionUserId: () => Promise<string | null>;
	/**
	 * The organization an organization-wide authorization would be granted for
	 * if the person allowed it now. Read lazily, and throws as the grant itself
	 * would when there is none.
	 */
	getConsentOrganizationId: () => Promise<string>;
}

export const PROJECT_ACCESS_DENIED_DESCRIPTION =
	"You don't have access to this project.";

const MAX_CLIENT_ID_LENGTH = 255;

/** An S256 challenge: the unpadded base64url of a SHA-256 digest. */
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * How much life a binding must have left for a consent to rely on it. The
 * plugin reads it again within the same request, so this only has to outlast
 * the request: a binding that lapses between the check and the read would turn
 * a consent the page showed for a project into an organization-wide one.
 */
const CONSENT_MIN_REMAINING_MS = 60 * 1000;

function invalidTarget(description: string): APIError {
	return new APIError("BAD_REQUEST", {
		error: "invalid_target",
		error_description: description,
	});
}

function invalidRequest(description: string): APIError {
	return new APIError("BAD_REQUEST", {
		error: "invalid_request",
		error_description: description,
	});
}

/**
 * A refusal of an authorization whose client is known, delivered to the
 * client's registered `redirect_uri` where there is one (RFC 6749 §4.1.2.1).
 */
function refuseToClient(
	ctx: AuthorizeRefusalContext,
	client: { redirectUris?: string[] | null },
	query: Record<string, unknown>,
	status: "BAD_REQUEST" | "FORBIDDEN",
	details: { error: string; error_description: string },
): Error {
	return refusalForClient(
		ctx,
		{
			redirectUri: singleValueOf(query.redirect_uri),
			state: singleValueOf(query.state),
		},
		client.redirectUris ?? [],
		status,
		details,
	);
}

function valuesOf(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function singleValueOf(value: unknown): string | null {
	const values = valuesOf(value);
	return values.length === 1 && values[0] ? values[0] : null;
}

interface AuthorizationKey {
	clientId: string;
	codeChallenge: string;
}

/** The key a binding is stored under, when the request's values could be one. */
function authorizationKeyOf(
	clientId: string | null | undefined,
	codeChallenge: string | null | undefined,
): AuthorizationKey | null {
	return clientId &&
		clientId.length <= MAX_CLIENT_ID_LENGTH &&
		codeChallenge &&
		CODE_CHALLENGE_PATTERN.test(codeChallenge)
		? { clientId, codeChallenge }
		: null;
}

function sameProject(
	left: { projectId: string; audience: OAuthProjectAudience },
	right: { projectId: string; audience: OAuthProjectAudience },
): boolean {
	return (
		left.projectId === right.projectId && left.audience === right.audience
	);
}

/**
 * `GET /oauth2/authorize`: write down which project the request asks for.
 *
 * Everything is checked before anything is written: more than one `resource`
 * among which any names a project is refused, as is a project resource without
 * a client and an S256 challenge to key the binding by, and a client that is
 * not registered or is disabled. A signed-in caller who asks for a project they
 * cannot read, or that does not exist, hears one answer for both. A caller who
 * is not signed in yet is not asked: the same check runs at consent, which is
 * after the sign-in.
 *
 * A live binding is never replaced. Asking again for the same project is the
 * same request, and asking for another with the same key is refused, so what a
 * consent page showed cannot be changed from outside; a client that wants
 * another project starts over with a new challenge.
 *
 * The plugin dispatches this endpoint again after sign-in and after the
 * organization page, with the signed query carrying the static audience.
 * Those passes keep the matching live binding alive, for a while.
 */
async function bindResourceOnAuthorize(
	ctx: OAuthAuthorizeHookContext,
	deps: OAuthResourceHookDeps,
): Promise<
	| { context: { query: Record<string, unknown> } }
	| { context: { body: Record<string, unknown> } }
	| undefined
> {
	// A resumed authorize inherits POST from consent/continue, but the provider
	// runs it with the signed query rather than that endpoint's body.
	const usesBody =
		ctx.method === "POST" &&
		(ctx.authorizeSettings === undefined ||
			ctx.authorizeSettings.isAuthorize === true);
	const query = (usesBody ? (ctx.body ?? {}) : (ctx.query ?? {})) as Record<
		string,
		unknown
	>;
	const key = authorizationKeyOf(
		singleValueOf(query.client_id),
		singleValueOf(query.code_challenge),
	);
	const resources = valuesOf(query.resource);

	if (!resources.some((r) => looksLikeProjectResource(deps.appUrl, r))) {
		if (query.resource === undefined) {
			const binding = key
				? await findLiveOAuthAuthorizationResource(
						key.clientId,
						key.codeChallenge,
					)
				: null;
			if (key && binding) {
				await extendOAuthAuthorizationResource(
					key.clientId,
					key.codeChallenge,
				);
			}
			// Put the compatibility audiences into the query before the provider
			// signs it or stores a code. A standing project binding stays narrow,
			// including an older resumed query that omitted its resource.
			const normalized = {
				...query,
				resource: binding
					? staticResourceFor(deps.appUrl, binding.audience)
					: oauthValidAudiences(deps.appUrl),
			};
			return usesBody
				? { context: { body: normalized } }
				: { context: { query: normalized } };
		}
		if (key && resources.length === 1) {
			const binding = await findLiveOAuthAuthorizationResource(
				key.clientId,
				key.codeChallenge,
			);
			if (
				binding &&
				resources[0] ===
					staticResourceFor(deps.appUrl, binding.audience)
			) {
				await extendOAuthAuthorizationResource(
					key.clientId,
					key.codeChallenge,
				);
			}
		}
		return;
	}

	if (resources.length !== 1) {
		throw invalidTarget("Send exactly one resource.");
	}
	const requested = parseProjectResource(deps.appUrl, resources[0]);
	if (!requested) {
		throw invalidTarget(
			"The resource is not a project URL of this deployment.",
		);
	}
	if (!key) {
		throw invalidRequest(
			"A project authorization needs a client_id and an S256 code_challenge.",
		);
	}

	const client = await ctx.context.adapter.findOne({
		model: "oauthClient",
		where: [{ field: "clientId", value: key.clientId }],
	});
	if (!client || client.disabled) {
		throw new APIError("BAD_REQUEST", {
			error: client ? "client_disabled" : "invalid_client",
			error_description: client
				? "The client is disabled."
				: "The client is not registered.",
		});
	}

	const userId = await deps.getSessionUserId();
	if (
		userId &&
		!(await resolveOAuthProjectGrantTarget(userId, requested.projectId))
	) {
		throw refuseToClient(ctx, client, query, "FORBIDDEN", {
			error: "access_denied",
			error_description: PROJECT_ACCESS_DENIED_DESCRIPTION,
		});
	}

	const standing = await saveOAuthAuthorizationResource({
		...key,
		resource: resources[0],
		projectId: requested.projectId,
		audience: requested.audience,
	});
	if (!standing || !sameProject(standing, requested)) {
		throw refuseToClient(ctx, client, query, "BAD_REQUEST", {
			error: "invalid_request",
			error_description:
				"This authorization was already started for something else. Start it again from your agent.",
		});
	}
	// The provider now validates resources at authorize and carries them into
	// the code. Keep the canonical project in Fabric's binding while using the
	// same static audience at both authorize and token exchange.
	const normalized = {
		...query,
		resource: staticResourceFor(deps.appUrl, requested.audience),
	};
	return usesBody
		? { context: { body: normalized } }
		: { context: { query: normalized } };
}

/**
 * What the consent page says it showed: the one project, or an explicit none.
 * Undefined for a request that says nothing, or something that is not either.
 */
function displayedBindingOf(
	value: unknown,
): { projectId: string; audience: OAuthProjectAudience } | null | undefined {
	if (value === null) {
		return null;
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const { projectId, audience } = value as Record<string, unknown>;
	return typeof projectId === "string" &&
		isProjectId(projectId) &&
		(audience === "mcp" || audience === "api")
		? { projectId, audience }
		: undefined;
}

function shownMatches(
	displayed: ReturnType<typeof displayedBindingOf>,
	live: OAuthAuthorizationResourceBinding | null,
): boolean {
	if (displayed === undefined) {
		return false;
	}
	if (displayed === null || live === null) {
		return displayed === null && live === null;
	}
	return sameProject(displayed, live);
}

/**
 * `POST /oauth2/consent`: the grant the person is about to approve must be the
 * one their page showed.
 *
 * The page names the project it displayed, or says it displayed none, and the
 * server compares that with the binding that is live now. The grant is decided
 * from that binding, so any difference, in either direction, means the person
 * would be approving something other than what they read, and the connection
 * has to be started again. A request that does not say what was shown is
 * refused the same way. A denial grants nothing and is never in the way.
 *
 * Reads the key from the same `oauth_query` the plugin does, so the binding
 * compared with is the one the grant is decided from.
 */
async function requireGrantShown(
	ctx: OAuthResourceHookContext,
	deps: OAuthResourceHookDeps,
): Promise<void> {
	const body = (ctx.body ?? {}) as Record<string, unknown>;
	if (body.accept !== true) {
		return;
	}

	const signedQuery =
		typeof body.oauth_query === "string"
			? new URLSearchParams(body.oauth_query)
			: null;
	const key = authorizationKeyOf(
		signedQuery?.get("client_id"),
		signedQuery?.get("code_challenge"),
	);
	const live = key
		? await findLiveOAuthAuthorizationResource(
				key.clientId,
				key.codeChallenge,
				new Date(Date.now() + CONSENT_MIN_REMAINING_MS),
			)
		: null;

	const displayed = displayedBindingOf(body[OAUTH_DISPLAYED_BINDING_FIELD]);
	if (!shownMatches(displayed, live)) {
		throw invalidRequest(
			"What this page showed is not what the connection is for any more. Start it again from your agent.",
		);
	}

	if (live === null) {
		const shownOrganization = body[OAUTH_DISPLAYED_ORGANIZATION_FIELD];
		if (
			typeof shownOrganization !== "string" ||
			shownOrganization !== (await deps.getConsentOrganizationId())
		) {
			throw invalidRequest(
				"The organization this page showed is not the one the connection is for. Start it again from your agent.",
			);
		}
	}
}

/**
 * The reference the plugin stored on an authorization code: the grant it was
 * issued for. Found by the digest of the code, as the plugin stores it, never by
 * the code.
 */
async function referenceOfCode(
	ctx: Pick<OAuthResourceHookContext, "context">,
	code: string,
): Promise<string | null> {
	const verification =
		await ctx.context.internalAdapter.findVerificationValue(
			hashOAuthToken(code),
		);
	if (!verification) {
		return null;
	}
	try {
		const value = JSON.parse(verification.value) as {
			referenceId?: unknown;
		};
		return typeof value.referenceId === "string" ? value.referenceId : null;
	} catch {
		return null;
	}
}

/** The reference a grant carries, read from the code or the refresh token the request spends. */
async function referenceOfGrant(
	ctx: OAuthResourceHookContext,
	body: Record<string, unknown>,
): Promise<string | null> {
	if (
		body.grant_type === "authorization_code" &&
		typeof body.code === "string"
	) {
		return referenceOfCode(ctx, body.code);
	}

	if (
		body.grant_type === "refresh_token" &&
		typeof body.refresh_token === "string" &&
		body.refresh_token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)
	) {
		const row = await ctx.context.adapter.findOne({
			model: "oauthRefreshToken",
			where: [
				{
					field: "token",
					value: hashOAuthToken(
						body.refresh_token.slice(
							OAUTH_REFRESH_TOKEN_PREFIX.length,
						),
					),
				},
			],
		});
		return row?.referenceId ?? null;
	}

	return null;
}

/**
 * `POST /oauth2/token`: a project resource must be the one the grant was made
 * for, and is swapped for the static resource of its audience once it is. A
 * grant that is not there at all is left to the plugin, with the same swap.
 *
 * What the request does not say is not asked: a grant bound to a project stays
 * bound through its reference whatever `resource` the request carries, so a
 * client that sends none, or the organization-wide one, gets a token that still
 * reaches the one project.
 *
 * Nothing here touches the binding. Spending a code does not remove it, because
 * a request that can spend a code minted beforehand for the same client and
 * challenge could then remove a binding between the consent check and the
 * plugin's own read of it, and turn a consent shown for a project into an
 * organization-wide one. A binding ends only by expiring.
 *
 * Returns the context overrides the plugin should run with, or nothing.
 */
async function matchResourceOnToken(
	ctx: OAuthResourceHookContext,
	deps: OAuthResourceHookDeps,
): Promise<{ context: { body: Record<string, unknown> } } | undefined> {
	const body = (ctx.body ?? {}) as Record<string, unknown>;
	const resource = typeof body.resource === "string" ? body.resource : null;
	if (resource === null || !looksLikeProjectResource(deps.appUrl, resource)) {
		return undefined;
	}

	const requested = parseProjectResource(deps.appUrl, resource);
	if (!requested) {
		throw invalidTarget(
			"The resource is not a project URL of this deployment.",
		);
	}

	// A grant that cannot be found has no reference to compare, and is the
	// plugin's to refuse: a code that was spent or never issued, a refresh token
	// that was revoked or rotated away. It answers `invalid_grant`, which is what
	// a client takes to mean "sign in again"; refusing here with `invalid_target`
	// told it its resource was wrong and left it asking for the same thing. Only
	// a live grant that was made for something else is refused here.
	const reference = await referenceOfGrant(ctx, body);
	if (
		reference !== null &&
		reference !==
			buildProjectReference(requested.audience, requested.projectId)
	) {
		throw invalidTarget(
			"The resource is not the one this grant was made for.",
		);
	}

	return {
		context: {
			body: {
				...body,
				resource: staticResourceFor(deps.appUrl, requested.audience),
			},
		},
	};
}

/**
 * The grant a consent actually issued, read back from the code its response
 * carries: the organization, and the one project when the grant is bound to one.
 *
 * The code's own stored reference is the grant. Recomputing it afterwards from
 * the binding would audit whatever that row says by then, which is not
 * necessarily what was issued. Null when the response carries no code or the
 * code is not one this server stored.
 */
export async function issuedGrantOfConsent(
	ctx: OAuthIssuedGrantContext,
	userId: string,
): Promise<{ organizationId: string | null; projectId: string | null } | null> {
	const { returned } = ctx.context;
	const url =
		typeof returned === "object" &&
		returned !== null &&
		"url" in returned &&
		typeof returned.url === "string"
			? returned.url
			: null;
	const code = url
		? new URL(url, "http://localhost").searchParams.get("code")
		: null;
	const referenceId = code ? await referenceOfCode(ctx, code) : null;
	const reference = referenceId ? parseOAuthReference(referenceId) : null;
	if (!reference) {
		return null;
	}

	if (reference.kind === "organization") {
		return { organizationId: reference.organizationId, projectId: null };
	}
	const target = await resolveOAuthProjectGrantTarget(
		userId,
		reference.projectId,
	);
	return {
		organizationId: target?.organizationId ?? null,
		projectId: reference.projectId,
	};
}

/**
 * The global before-hook for the three endpoints. Called from `auth.ts`, and by
 * the test harness that stands in for it.
 */
export async function enforceOAuthResourceBinding(
	ctx: OAuthAuthorizeHookContext,
	deps: OAuthResourceHookDeps,
): Promise<
	| { context: { body: Record<string, unknown> } }
	| { context: { query: Record<string, unknown> } }
	| undefined
> {
	switch (ctx.path) {
		case "/oauth2/authorize":
			return bindResourceOnAuthorize(ctx, deps);
		case "/oauth2/consent":
			await requireGrantShown(ctx, deps);
			return undefined;
		case "/oauth2/token":
			return matchResourceOnToken(ctx, deps);
		default:
			return undefined;
	}
}
