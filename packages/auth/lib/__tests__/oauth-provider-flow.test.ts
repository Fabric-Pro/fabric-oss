/**
 * The authorization server, end to end, through Better Auth's real request
 * cycle: register a public client, authorize, consent, exchange the code,
 * refresh, and read what was stored.
 *
 * What this pins that no unit test can: that the digest the plugin WRITES for a
 * token is the digest the gateway and the v1 API LOOK UP (both come from
 * `hashOAuthToken`), that the organization chosen at consent is what every token
 * carries, that consent is shown for a dynamically registered client, and that
 * a spent refresh token ends the whole family. All of those are properties of
 * how the plugin is configured here, so they are asserted against the
 * configured plugin rather than restated from its documentation.
 */

import {
	OAUTH_DISPLAYED_BINDING_FIELD,
	OAUTH_DISPLAYED_ORGANIZATION_FIELD,
} from "@repo/utils/oauth-project-resource";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	hashOAuthToken,
	OAUTH_ACCESS_TOKEN_PREFIX,
	OAUTH_REFRESH_TOKEN_PREFIX,
} from "../../../database/prisma/queries/oauth-token-format";
import {
	OAUTH_ORGANIZATION_CHOSEN_COOKIE,
	OAUTH_SCOPES,
	oauthIssuer,
} from "../oauth-scopes";
import {
	oauthFixtures as membership,
	ORGANIZATION_ID,
	resetOAuthFixtures,
} from "./support/oauth-database-mock";
import {
	APP_URL,
	authorizeUrl,
	boot,
	challengeOf,
	type Harness,
	REDIRECT_URI,
	register,
	rowsOf,
	VERIFIER,
} from "./support/oauth-flow-harness";

vi.mock("@repo/database", async () =>
	(await import("./support/oauth-database-mock")).createDatabaseMock(),
);

beforeEach(() => {
	resetOAuthFixtures();
});

/** Walk register, authorize and consent, and return the token response. */
async function signIn(ctx: Harness, tokenHeaders: Record<string, string> = {}) {
	const { body: client } = await register(ctx.call);

	const authorize = await ctx.call(await authorizeUrl(client.client_id), {
		redirect: "manual",
		headers: { accept: "text/html" },
	});
	const consentLocation = authorize.headers.get("location") ?? "";

	const consent = await ctx.call("/oauth2/consent", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			accept: true,
			oauth_query: consentLocation.split("?")[1],
			[OAUTH_DISPLAYED_BINDING_FIELD]: null,
			[OAUTH_DISPLAYED_ORGANIZATION_FIELD]: ORGANIZATION_ID,
		}),
	});
	const { url } = (await consent.json()) as { url: string };
	const code = new URL(url).searchParams.get("code") as string;

	const token = await ctx.call("/oauth2/token", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			...tokenHeaders,
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT_URI,
			client_id: client.client_id,
			code_verifier: VERIFIER,
			resource: `${APP_URL}/api/mcp-gateway`,
		}).toString(),
	});

	return {
		client,
		code,
		consentLocation,
		consentStatus: consent.status,
		tokenResponse: token,
		tokens: (await token.json()) as {
			access_token: string;
			refresh_token: string;
			scope: string;
			expires_in: number;
		},
	};
}

async function dpopProof() {
	const { publicKey, privateKey } = await generateKeyPair("ES256");
	return new SignJWT({
		htm: "POST",
		htu: `${APP_URL}/api/auth/oauth2/token`,
		jti: crypto.randomUUID(),
	})
		.setIssuedAt()
		.setProtectedHeader({
			typ: "dpop+jwt",
			alg: "ES256",
			jwk: await exportJWK(publicKey),
		})
		.sign(privateKey);
}

describe("the OAuth authorization server as configured for Fabric", () => {
	it("refuses a valid optional DPoP proof without consuming the authorization code or issuing a bound token", async () => {
		const ctx = await boot();
		const flow = await signIn(ctx, { DPoP: await dpopProof() });
		expect(flow.tokenResponse.status).toBe(400);
		expect(flow.tokens).toMatchObject({ error: "invalid_request" });
		expect(await rowsOf(ctx, "oauthAccessToken")).toHaveLength(0);
		expect(await rowsOf(ctx, "oauthRefreshToken")).toHaveLength(0);
		const bearer = await ctx.call("/oauth2/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: flow.code,
				redirect_uri: REDIRECT_URI,
				client_id: flow.client.client_id,
				code_verifier: VERIFIER,
				resource: `${APP_URL}/api/mcp-gateway`,
			}).toString(),
		});
		expect(bearer.status).toBe(200);
		expect(await bearer.json()).toMatchObject({ token_type: "Bearer" });
		expect(
			(await rowsOf(ctx, "oauthAccessToken"))[0].confirmation,
		).toBeFalsy();
	});

	it("refuses DPoP on refresh without rotating the existing bearer grant", async () => {
		const ctx = await boot();
		const { client, tokens } = await signIn(ctx);
		const form = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: tokens.refresh_token,
			client_id: client.client_id,
		});
		const rejected = await ctx.call("/oauth2/token", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				dPoP: await dpopProof(),
			},
			body: form.toString(),
		});
		expect(rejected.status).toBe(400);
		expect(await rejected.json()).toMatchObject({
			error: "invalid_request",
		});
		expect(await rowsOf(ctx, "oauthAccessToken")).toHaveLength(1);
		expect(await rowsOf(ctx, "oauthRefreshToken")).toHaveLength(1);
		expect((await rowsOf(ctx, "oauthRefreshToken"))[0].revoked).toBeFalsy();
		const bearer = await ctx.call("/oauth2/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form.toString(),
		});
		expect(bearer.status).toBe(200);
		expect(await bearer.json()).toMatchObject({ token_type: "Bearer" });
	});

	it("also refuses optional DPoP in server token calls that bypass HTTP request hooks", async () => {
		const ctx = await boot();
		const { client, tokens } = await signIn(ctx);
		await expect(
			ctx.auth.api.oauth2Token({
				body: {
					grant_type: "refresh_token",
					refresh_token: tokens.refresh_token,
					client_id: client.client_id,
				},
				headers: new Headers({ DPoP: await dpopProof() }),
				asResponse: true,
			}),
		).rejects.toMatchObject({
			statusCode: 400,
			body: { error: "invalid_request" },
		});
		expect(await rowsOf(ctx, "oauthAccessToken")).toHaveLength(1);
		expect((await rowsOf(ctx, "oauthRefreshToken"))[0].revoked).toBeFalsy();
	});
	it("keeps new provider management and unused logout endpoints unavailable", async () => {
		const ctx = await boot();
		for (const [path, method] of [
			["/admin/oauth2/create-client", "POST"],
			["/admin/oauth2/update-client", "POST"],
			["/oauth2/public-client-prelogin", "POST"],
			["/oauth2/end-session", "GET"],
			["/oauth2/end-session/confirm", "POST"],
			["/oauth2/userinfo", "GET"],
			["/admin/oauth2/resources", "POST"],
			["/admin/oauth2/resources", "GET"],
			["/admin/oauth2/resources/example-resource", "GET"],
			["/admin/oauth2/resources/example-resource", "PATCH"],
			["/admin/oauth2/resources/example-resource", "DELETE"],
			[
				"/admin/oauth2/resources/example-resource/clients/example-client",
				"PUT",
			],
			[
				"/admin/oauth2/resources/example-resource/clients/example-client",
				"DELETE",
			],
		] as const) {
			const response = await ctx.call(path, {
				method,
				headers: { "content-type": "application/json" },
				...(method === "GET" ? {} : { body: "{}" }),
			});
			expect(response.status, `${method} ${path}`).toBe(404);
		}
		expect(await rowsOf(ctx, "oauthClient")).toHaveLength(0);
	});

	it.each([
		"http://127.0.0.1:5050/callback",
		"http://localhost:5050/callback",
	])("supports legacy registration metadata with %s", async (redirect) => {
		const ctx = await boot();
		const response = await ctx.call("/oauth2/register", {
			method: "POST",
			headers: { "content-type": "application/json", cookie: "" },
			body: JSON.stringify({
				redirect_uris: [redirect],
				type: "native",
				token_endpoint_auth_method: "none",
			}),
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			application_type: "native",
			token_endpoint_auth_method: "none",
		});
	});

	it("revokes access on browser sign-out while preserving the offline refresh grant", async () => {
		const ctx = await boot();
		const { client, tokens } = await signIn(ctx);
		expect(
			(
				await ctx.call("/sign-out", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				})
			).status,
		).toBe(200);
		expect((await rowsOf(ctx, "oauthAccessToken"))[0].revoked).toBeTruthy();
		expect((await rowsOf(ctx, "oauthRefreshToken"))[0].revoked).toBeFalsy();
		const refreshed = await ctx.call("/oauth2/token", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				cookie: "",
			},
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: tokens.refresh_token,
				client_id: client.client_id,
			}).toString(),
		});
		expect(refreshed.status).toBe(200);
		expect(await refreshed.json()).toMatchObject({
			scope: OAUTH_SCOPES.join(" "),
		});
	});
	it("publishes metadata whose issuer is the path-inserted /api/auth issuer", async () => {
		const { auth } = await boot();

		const metadata = await auth.api.getOAuthServerConfig({
			asResponse: false,
		});

		expect(metadata.issuer).toBe(oauthIssuer(APP_URL));
		expect(metadata.registration_endpoint).toBe(
			`${APP_URL}/api/auth/oauth2/register`,
		);
		expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
		expect(metadata.token_endpoint_auth_methods_supported).toContain(
			"none",
		);
		expect(metadata.grant_types_supported).toEqual([
			"authorization_code",
			"refresh_token",
		]);
		expect(metadata.scopes_supported).toEqual([...OAUTH_SCOPES]);
		expect(metadata.jwks_uri).toBeUndefined();
		expect(metadata.dpop_signing_alg_values_supported).toEqual([]);
	});

	it("shows consent for a client that registered itself and binds the organization", async () => {
		const ctx = await boot();

		const flow = await signIn(ctx);

		expect(flow.consentLocation).toContain("/auth/oauth/consent");
		expect(flow.consentStatus).toBe(200);
		expect(flow.tokenResponse.status).toBe(200);
		expect(flow.tokens.scope.split(" ")).toEqual([...OAUTH_SCOPES]);
		expect(flow.tokens.expires_in).toBe(3600);

		const consents = await rowsOf(ctx, "oauthConsent");
		expect(consents).toHaveLength(1);
		expect(consents[0]).toMatchObject({
			clientId: flow.client.client_id,
			referenceId: ORGANIZATION_ID,
		});
	});

	it("writes the digest the gateway looks up, never the token itself", async () => {
		const ctx = await boot();

		const { tokens } = await signIn(ctx);

		expect(tokens.access_token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)).toBe(
			true,
		);
		expect(
			tokens.refresh_token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX),
		).toBe(true);

		const accessRows = await rowsOf(ctx, "oauthAccessToken");
		expect(accessRows).toHaveLength(1);
		expect(accessRows[0].token).toBe(
			hashOAuthToken(
				tokens.access_token.slice(OAUTH_ACCESS_TOKEN_PREFIX.length),
			),
		);
		expect(accessRows[0].token).not.toContain(tokens.access_token);
		expect(accessRows[0].referenceId).toBe(ORGANIZATION_ID);
		expect(accessRows[0].scopes).toEqual([...OAUTH_SCOPES]);

		const refreshRows = await rowsOf(ctx, "oauthRefreshToken");
		expect(refreshRows[0].token).toBe(
			hashOAuthToken(
				tokens.refresh_token.slice(OAUTH_REFRESH_TOKEN_PREFIX.length),
			),
		);
		expect(refreshRows[0].referenceId).toBe(ORGANIZATION_ID);
	});

	it("refuses a resource that is not the gateway or the API", async () => {
		const ctx = await boot();
		const { body: client } = await register(ctx.call);
		const authorize = await ctx.call(await authorizeUrl(client.client_id), {
			redirect: "manual",
			headers: { accept: "text/html" },
		});
		const consent = await ctx.call("/oauth2/consent", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				accept: true,
				oauth_query: (authorize.headers.get("location") ?? "").split(
					"?",
				)[1],
				[OAUTH_DISPLAYED_BINDING_FIELD]: null,
				[OAUTH_DISPLAYED_ORGANIZATION_FIELD]: ORGANIZATION_ID,
			}),
		});
		const code = new URL(
			((await consent.json()) as { url: string }).url,
		).searchParams.get("code") as string;

		const token = await ctx.call("/oauth2/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				client_id: client.client_id,
				code_verifier: VERIFIER,
				resource: "https://elsewhere.example/api",
			}).toString(),
		});

		expect(token.status).toBe(400);
	});

	it("rotates refresh tokens and ends the whole family when a spent one is replayed", async () => {
		const ctx = await boot();
		const { client, tokens } = await signIn(ctx);

		const refresh = (refreshToken: string) =>
			ctx.call("/oauth2/token", {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: refreshToken,
					client_id: client.client_id,
				}).toString(),
			});

		const rotated = await refresh(tokens.refresh_token);
		expect(rotated.status).toBe(200);
		const next = (await rotated.json()) as { refresh_token: string };
		expect(next.refresh_token).not.toBe(tokens.refresh_token);

		const replay = await refresh(tokens.refresh_token);
		expect(replay.status).toBe(400);

		const afterReplay = await refresh(next.refresh_token);
		expect(afterReplay.status).toBe(400);
		expect(await rowsOf(ctx, "oauthRefreshToken")).toHaveLength(0);
	});

	describe("for a person who has to change their password first", () => {
		afterEach(() => {
			membership.mustChangePassword = false;
		});

		it("issues no code from authorize, even where a consent already exists", async () => {
			const ctx = await boot();
			// Consented while the password was fine, so authorize would hand out
			// a code straight away — no consent page in between.
			const { client } = await signIn(ctx);
			membership.mustChangePassword = true;

			const authorize = await ctx.call(
				await authorizeUrl(client.client_id),
				{
					redirect: "manual",
					headers: { accept: "text/html" },
				},
			);
			const location = authorize.headers.get("location") ?? "";

			expect(location).not.toContain("code=");
			expect(location).not.toContain(REDIRECT_URI);
			// The page the proxy turns into /change-password.
			expect(location).toContain("/auth/oauth/organization");
		});

		it("refuses the consent itself, so posting it directly mints nothing", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);
			const authorize = await ctx.call(
				await authorizeUrl(client.client_id),
				{
					redirect: "manual",
					headers: { accept: "text/html" },
				},
			);
			const consentQuery =
				(authorize.headers.get("location") ?? "").split("?")[1] ?? "";
			membership.mustChangePassword = true;

			const consent = await ctx.call("/oauth2/consent", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					accept: true,
					oauth_query: consentQuery,
					[OAUTH_DISPLAYED_BINDING_FIELD]: null,
					[OAUTH_DISPLAYED_ORGANIZATION_FIELD]: ORGANIZATION_ID,
				}),
			});

			expect(consent.status).toBe(403);
			expect(await consent.text()).not.toContain("code=");
			expect(await rowsOf(ctx, "oauthConsent")).toHaveLength(0);
		});
	});

	describe("for a person in more than one organization", () => {
		afterEach(() => {
			membership.organizationCount = 1;
		});

		it("asks which organization once per authorization, then goes on to consent", async () => {
			membership.organizationCount = 2;
			const ctx = await boot();
			const { body: client } = await register(ctx.call);

			const authorize = await ctx.call(
				await authorizeUrl(client.client_id),
				{
					redirect: "manual",
					headers: { accept: "text/html" },
				},
			);
			const pickerLocation = authorize.headers.get("location") ?? "";
			expect(pickerLocation).toContain("/auth/oauth/organization");
			const signedQuery = pickerLocation.split("?")[1] ?? "";

			const continueWith = (cookie: string) =>
				ctx.call("/oauth2/continue", {
					method: "POST",
					headers: { "content-type": "application/json", cookie },
					body: JSON.stringify({
						postLogin: true,
						oauth_query: signedQuery,
					}),
				});

			// Continuing without recording the choice asks again: this is the
			// loop the organization page has to break.
			const unchosen = (await (
				await continueWith(ctx.cookie)
			).json()) as {
				url: string;
			};
			expect(unchosen.url).toContain("/auth/oauth/organization");

			// A choice recorded for a different authorization changes nothing.
			const otherAuthorization = (await (
				await continueWith(
					`${ctx.cookie}; ${OAUTH_ORGANIZATION_CHOSEN_COOKIE}=another-challenge`,
				)
			).json()) as { url: string };
			expect(otherAuthorization.url).toContain(
				"/auth/oauth/organization",
			);

			const chosen = (await (
				await continueWith(
					`${ctx.cookie}; ${OAUTH_ORGANIZATION_CHOSEN_COOKIE}=${await challengeOf(VERIFIER)}`,
				)
			).json()) as { url: string };
			expect(chosen.url).toContain("/auth/oauth/consent");
		});
	});

	it("refuses an authorization with no PKCE challenge", async () => {
		const ctx = await boot();
		const { body: client } = await register(ctx.call);
		const query = new URLSearchParams({
			response_type: "code",
			client_id: client.client_id,
			redirect_uri: REDIRECT_URI,
			scope: OAUTH_SCOPES.join(" "),
			state: "state-example",
		});

		const response = await ctx.call(
			`/oauth2/authorize?${query.toString()}`,
			{
				redirect: "manual",
				headers: { accept: "text/html" },
			},
		);

		const location = response.headers.get("location") ?? "";
		expect(location).toContain("error=invalid_request");
		expect(location).toContain("pkce");
		expect(location).not.toContain("/auth/oauth/consent");
	});
});

describe("dynamic registration", () => {
	it("refuses a redirect to a script, a file or a plain-http host", async () => {
		const ctx = await boot();

		for (const redirect of [
			"javascript:alert(1)",
			"data:text/html,x",
			"file:///etc/passwd",
			"http://attacker.example/callback",
		]) {
			const response = await ctx.call("/oauth2/register", {
				method: "POST",
				headers: { "content-type": "application/json", cookie: "" },
				body: JSON.stringify({
					redirect_uris: [redirect],
					token_endpoint_auth_method: "none",
				}),
			});
			expect(response.status, redirect).toBe(400);
		}
	});

	it("accepts https, loopback and private-use scheme redirects", async () => {
		const ctx = await boot();

		for (const redirect of [
			"https://agent.example/callback",
			"http://127.0.0.1:5050/callback",
			"http://localhost:5050/callback",
			"com.example.agent:/callback",
		]) {
			const response = await ctx.call("/oauth2/register", {
				method: "POST",
				headers: { "content-type": "application/json", cookie: "" },
				body: JSON.stringify({
					redirect_uris: [redirect],
					token_endpoint_auth_method: "none",
				}),
			});
			expect(response.ok, redirect).toBe(true);
		}
	});

	it("registers Cursor's pre-RFC 8252 callback and accepts it at authorize, and nothing near it", async () => {
		const ctx = await boot();
		const cursorCallback = "cursor://anysphere.cursor-mcp/oauth/callback";
		const registerBody = (redirectUris: string[]) =>
			JSON.stringify({
				client_name: "Cursor",
				redirect_uris: redirectUris,
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				scope: OAUTH_SCOPES.join(" "),
			});
		const registerClient = (redirectUris: string[]) =>
			ctx.call("/oauth2/register", {
				method: "POST",
				headers: { "content-type": "application/json", cookie: "" },
				body: registerBody(redirectUris),
			});

		const legacy = await registerClient([cursorCallback]);
		expect(legacy.status).toBe(201);
		const current = await registerClient([
			cursorCallback,
			"https://www.cursor.com/agents/mcp/oauth/callback",
			"http://localhost:8787/callback",
		]);
		expect(current.status).toBe(201);
		const { client_id: clientId } = (await current.json()) as {
			client_id: string;
		};

		for (const redirect of [
			cursorCallback,
			"https://www.cursor.com/agents/mcp/oauth/callback",
			"http://localhost:8787/callback",
		]) {
			const url = new URL(
				await authorizeUrl(clientId),
				"http://localhost",
			);
			url.searchParams.set("redirect_uri", redirect);
			const authorize = await ctx.call(`${url.pathname}${url.search}`, {
				redirect: "manual",
				headers: { accept: "text/html" },
			});
			const location = authorize.headers.get("location") ?? "";
			expect(location, redirect).toContain("/auth/oauth/consent");
			expect(location, redirect).not.toContain("error=");
		}

		for (const nearMiss of [
			"cursor://evil.example/callback",
			"cursor://anysphere.cursor-mcp/other",
			`${cursorCallback}?x=1`,
			`${cursorCallback}/`,
		]) {
			const response = await registerClient([nearMiss]);
			expect(response.status, nearMiss).toBe(400);
		}
	});

	it("offers no other way to create or change a client, or to drop a consent on its own", async () => {
		const ctx = await boot();
		const { body: client } = await register(ctx.call);

		// Signed in, which is all these endpoints would otherwise ask for: a
		// confidential client the registration policy refuses, and a redirect
		// moved to a host nobody approved.
		const created = await ctx.call("/oauth2/create-client", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				redirect_uris: ["https://attacker.example/callback"],
				token_endpoint_auth_method: "client_secret_basic",
				scope: OAUTH_SCOPES.join(" "),
			}),
		});
		const updated = await ctx.call("/oauth2/update-client", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_id: client.client_id,
				update: {
					redirect_uris: ["https://attacker.example/callback"],
				},
			}),
		});
		const consentDropped = await ctx.call("/oauth2/delete-consent", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "any" }),
		});

		expect(created.status).toBe(404);
		expect(updated.status).toBe(404);
		expect(consentDropped.status).toBe(404);
		const clients = await rowsOf(ctx, "oauthClient");
		expect(clients).toHaveLength(1);
		expect(clients[0]?.redirectUris).toEqual([REDIRECT_URI]);

		// The consent screen still reads the client's name.
		const named = await ctx.call(
			`/oauth2/public-client?client_id=${client.client_id}`,
		);
		expect(named.status).toBe(200);
	});

	it("refuses a confidential client, a skip_consent request and a scope outside the ceiling", async () => {
		const ctx = await boot();
		const register = (extra: Record<string, unknown>) =>
			ctx.call("/oauth2/register", {
				method: "POST",
				headers: { "content-type": "application/json", cookie: "" },
				body: JSON.stringify({
					redirect_uris: [REDIRECT_URI],
					...extra,
				}),
			});

		expect(
			(
				await register({
					token_endpoint_auth_method: "client_secret_basic",
				})
			).status,
		).toBe(400);
		expect(
			(
				await register({
					token_endpoint_auth_method: "none",
					skip_consent: true,
				})
			).status,
		).toBe(400);
		expect(
			(
				await register({
					token_endpoint_auth_method: "none",
					scope: "mcp:write",
				})
			).status,
		).toBe(400);
		expect(
			(
				await register({
					token_endpoint_auth_method: "none",
					scope: "instructions:publish",
				})
			).status,
		).toBe(400);
		expect(
			(await register({ token_endpoint_auth_method: "none", scope: "*" }))
				.status,
		).toBe(400);
		expect(
			(
				await register({
					token_endpoint_auth_method: "none",
					grant_types: ["client_credentials"],
				})
			).status,
		).toBe(400);
	});
});
