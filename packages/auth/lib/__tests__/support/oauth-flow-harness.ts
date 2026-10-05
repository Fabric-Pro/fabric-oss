/**
 * Better Auth's real request cycle with Fabric's OAuth provider mounted, for
 * the suites that walk an authorization from registration to a token.
 *
 * A test file that uses this must mock `@repo/database` with
 * `createDatabaseMock` from `./oauth-database-mock`: the provider reads it.
 */

import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { getTestInstance } from "better-auth/test";
import { auditOAuthConsent } from "../../oauth-audit";
import {
	createOAuthProviderPlugin,
	OAUTH_DISABLED_PATHS,
} from "../../oauth-provider";
import { enforceOAuthResourceBinding } from "../../oauth-project-binding";
import { enforceRegistrationPolicy } from "../../oauth-registration-policy";
import { OAUTH_SCOPES } from "../../oauth-scopes";

export const APP_URL = "http://localhost:3000";
export const REDIRECT_URI = "http://127.0.0.1:49152/callback";
export const VERIFIER = "v".repeat(43);

/** Every stored row of a plugin table, read through the instance's adapter. */
export async function rowsOf(
	ctx: {
		instance: {
			db: { findMany: (args: { model: string }) => Promise<unknown[]> };
		};
	},
	model: string,
): Promise<Array<Record<string, unknown>>> {
	const rows = await ctx.instance.db.findMany({ model });
	return rows.filter(
		(row): row is Record<string, unknown> =>
			typeof row === "object" && row !== null,
	);
}

export async function challengeOf(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return Buffer.from(digest).toString("base64url");
}

export async function boot() {
	const instance = await getTestInstance({
		baseURL: APP_URL,
		plugins: [createOAuthProviderPlugin(APP_URL)],
		disabledPaths: [...OAUTH_DISABLED_PATHS],
		// The registration policy and the resource binding live in the app's
		// global before-hook; the harness applies the same functions so the
		// requests go through them.
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path === "/oauth2/register") {
					enforceRegistrationPolicy(ctx.body);
				}
				if (
					ctx.path === "/oauth2/authorize" ||
					ctx.path === "/oauth2/consent" ||
					ctx.path === "/oauth2/token"
				) {
					return enforceOAuthResourceBinding(ctx, {
						appUrl: APP_URL,
						getSessionUserId: async () =>
							(await getSessionFromCtx(ctx))?.user.id ?? null,
					});
				}
			}),
			after: createAuthMiddleware(async (ctx) => {
				if (ctx.path === "/oauth2/consent") {
					await auditOAuthConsent(ctx);
				}
			}),
		},
	});
	const { headers } = await instance.signInWithTestUser();
	const cookie = headers.get("cookie") ?? "";
	const auth = instance.auth;

	const call = (path: string, init: RequestInit = {}) =>
		auth.handler(
			new Request(`${APP_URL}/api/auth${path}`, {
				...init,
				headers: {
					origin: APP_URL,
					cookie,
					...(init.headers as Record<string, string> | undefined),
				},
			}),
		) as Promise<Response>;

	return { instance, auth, call, cookie };
}

export type Harness = Awaited<ReturnType<typeof boot>>;

export async function register(call: Harness["call"]) {
	const response = await call("/oauth2/register", {
		method: "POST",
		headers: { "content-type": "application/json", cookie: "" },
		body: JSON.stringify({
			client_name: "Example Agent",
			redirect_uris: [REDIRECT_URI],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			scope: OAUTH_SCOPES.join(" "),
			type: "native",
		}),
	});
	return { response, body: (await response.json()) as { client_id: string } };
}

/**
 * The authorize URL of a request for `resource`, which is the organization-wide
 * gateway unless said otherwise. `challenge` stands in for a different PKCE
 * verifier's.
 */
export async function authorizeUrl(
	clientId: string,
	options: {
		resource?: string | string[] | null;
		verifier?: string;
		withChallenge?: boolean;
		/** A challenge sent as it is, instead of the one the verifier makes. */
		codeChallenge?: string;
	} = {},
): Promise<string> {
	const query = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		scope: OAUTH_SCOPES.join(" "),
		state: "state-example",
	});
	if (options.withChallenge !== false) {
		query.set(
			"code_challenge",
			options.codeChallenge ??
				(await challengeOf(options.verifier ?? VERIFIER)),
		);
		query.set("code_challenge_method", "S256");
	}
	const resource =
		options.resource === undefined
			? `${APP_URL}/api/mcp-gateway`
			: options.resource;
	for (const value of [resource ?? []].flat()) {
		query.append("resource", value);
	}
	return `/oauth2/authorize?${query.toString()}`;
}
