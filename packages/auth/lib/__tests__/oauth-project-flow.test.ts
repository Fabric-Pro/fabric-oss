/**
 * An agent signed in for ONE project, through Better Auth's real request cycle.
 *
 * The plugin drops `resource` at authorize and refuses a project resource at
 * token, so everything below is what Fabric's two global before-hooks and
 * `consentReferenceId` make of it: the project the client asked for is bound at
 * consent, travels as the grant's reference, and is the only thing a token
 * exchange or a refresh may name.
 */

import {
	extendOAuthAuthorizationResource,
	findLiveOAuthAuthorizationResource,
	recordAudit,
} from "@repo/database";
import { OAUTH_DISPLAYED_BINDING_FIELD } from "@repo/utils/oauth-project-resource";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	hashOAuthToken,
	OAUTH_REFRESH_TOKEN_PREFIX,
} from "../../../database/prisma/queries/oauth-token-format";
import {
	oauthFixtures as fixtures,
	keyOf,
	ORGANIZATION_ID,
	resetOAuthFixtures,
} from "./support/oauth-database-mock";
import {
	APP_URL,
	authorizeUrl,
	boot,
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
	vi.mocked(recordAudit).mockClear();
	vi.mocked(extendOAuthAuthorizationResource).mockClear();
});

const PROJECT_ONE = `${APP_URL}/api/mcp-gateway/projects/project-example-one`;
const PROJECT_TWO = `${APP_URL}/api/mcp-gateway/projects/project-example-two`;
const API_PROJECT_ONE = `${APP_URL}/api/v1/projects/project-example-one`;
const ORGANIZATION_WIDE = `${APP_URL}/api/mcp-gateway`;

const REFERENCE_ONE = "project:mcp:project-example-one";
const REFERENCE_TWO = "project:mcp:project-example-two";

const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** A second PKCE verifier, so one client can run a second authorization. */
const OTHER_VERIFIER = "w".repeat(43);

interface TokenBody {
	access_token?: string;
	refresh_token?: string;
	error?: string;
	error_description?: string;
}

async function authorize(
	ctx: Harness,
	clientId: string,
	options: Parameters<typeof authorizeUrl>[1] = {},
) {
	return ctx.call(await authorizeUrl(clientId, options), {
		redirect: "manual",
		headers: { accept: "text/html" },
	});
}

interface Displayed {
	projectId: string;
	audience: "mcp" | "api";
}

function signedQueryOf(authorizeResponse: Response): string {
	return (authorizeResponse.headers.get("location") ?? "").split("?")[1];
}

/** What a consent page loaded for this authorization shows: the live binding, or nothing. */
function pageShows(authorizeResponse: Response): Displayed | null {
	const params = new URLSearchParams(signedQueryOf(authorizeResponse));
	const row = fixtures.bindings.get(
		keyOf(
			params.get("client_id") as string,
			params.get("code_challenge") as string,
		),
	);
	return row && row.expiresAt > Date.now()
		? { projectId: row.projectId, audience: row.audience }
		: null;
}

/**
 * The consent page's answer to the authorize response it was opened from. It
 * says what the page showed, unless `extra` says something else, or nothing.
 */
function postConsent(
	ctx: Harness,
	authorizeResponse: Response,
	extra: Record<string, unknown> = {
		[OAUTH_DISPLAYED_BINDING_FIELD]: pageShows(authorizeResponse),
	},
) {
	return ctx.call("/oauth2/consent", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			accept: true,
			oauth_query: signedQueryOf(authorizeResponse),
			...extra,
		}),
	});
}

/** Answer the consent page the authorize response pointed at, and return the code. */
async function consentTo(
	ctx: Harness,
	authorizeResponse: Response,
): Promise<string> {
	const consent = await postConsent(ctx, authorizeResponse);
	const { url } = (await consent.json()) as { url: string };
	return new URL(url).searchParams.get("code") as string;
}

/** Make every binding that was written lapse, as the clock would. */
function lapseBindings(): void {
	for (const row of fixtures.bindings.values()) {
		row.expiresAt = Date.now() - 1;
	}
}

async function exchange(
	ctx: Harness,
	clientId: string,
	code: string,
	options: { resource?: string | null; verifier?: string } = {},
) {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: REDIRECT_URI,
		client_id: clientId,
		code_verifier: options.verifier ?? VERIFIER,
	});
	if (options.resource) {
		body.set("resource", options.resource);
	}
	const response = await ctx.call("/oauth2/token", {
		method: "POST",
		headers: FORM,
		body: body.toString(),
	});
	return { response, body: (await response.json()) as TokenBody };
}

function refreshWith(
	ctx: Harness,
	clientId: string,
	refreshToken: string,
	resource?: string,
) {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: clientId,
	});
	if (resource) {
		body.set("resource", resource);
	}
	return ctx.call("/oauth2/token", {
		method: "POST",
		headers: FORM,
		body: body.toString(),
	});
}

/** Register, authorize for `resource`, consent and return the code. */
async function authorizedFor(
	ctx: Harness,
	resource: string | null,
	verifier = VERIFIER,
) {
	const { body: client } = await register(ctx.call);
	const response = await authorize(ctx, client.client_id, {
		resource,
		verifier,
	});
	return {
		clientId: client.client_id,
		response,
		code: await consentTo(ctx, response),
	};
}

describe("authorizing an agent for one project", () => {
	it("goes straight to consent, whatever the number of organizations", async () => {
		fixtures.organizationCount = 3;
		const ctx = await boot();
		const { body: client } = await register(ctx.call);

		const response = await authorize(ctx, client.client_id, {
			resource: PROJECT_ONE,
		});

		const location = response.headers.get("location") ?? "";
		expect(location).toContain("/auth/oauth/consent");
		expect(location).not.toContain("/auth/oauth/organization");
	});

	it("saves the consent, the code's grant and both tokens as the project's reference", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);

		const { response, body } = await exchange(ctx, clientId, code, {
			resource: PROJECT_ONE,
		});

		expect(response.status).toBe(200);
		expect(body.access_token).toBeDefined();
		const consents = await rowsOf(ctx, "oauthConsent");
		expect(consents).toHaveLength(1);
		expect(consents[0]).toMatchObject({
			clientId,
			referenceId: REFERENCE_ONE,
		});
		const access = await rowsOf(ctx, "oauthAccessToken");
		const refresh = await rowsOf(ctx, "oauthRefreshToken");
		expect(access.map((row) => row.referenceId)).toEqual([REFERENCE_ONE]);
		expect(refresh.map((row) => row.referenceId)).toEqual([REFERENCE_ONE]);
	});

	it("asks for consent again for a second project, and not again for the first", async () => {
		const ctx = await boot();
		const { clientId } = await authorizedFor(ctx, PROJECT_ONE);

		const second = await authorize(ctx, clientId, {
			resource: PROJECT_TWO,
			verifier: OTHER_VERIFIER,
		});
		const repeat = await authorize(ctx, clientId, {
			resource: PROJECT_ONE,
			verifier: "x".repeat(43),
		});

		expect(second.headers.get("location")).toContain("/auth/oauth/consent");
		expect(repeat.headers.get("location")).toContain(REDIRECT_URI);
		expect(repeat.headers.get("location")).toContain("code=");
		await consentTo(ctx, second);
		const consents = await rowsOf(ctx, "oauthConsent");
		expect(consents.map((row) => row.referenceId).sort()).toEqual([
			REFERENCE_ONE,
			REFERENCE_TWO,
		]);
	});

	it("keeps an organization grant and a project grant of one client apart", async () => {
		const ctx = await boot();
		const { clientId } = await authorizedFor(ctx, ORGANIZATION_WIDE);

		const bound = await authorize(ctx, clientId, {
			resource: PROJECT_ONE,
			verifier: OTHER_VERIFIER,
		});

		expect(bound.headers.get("location")).toContain("/auth/oauth/consent");
		await consentTo(ctx, bound);
		const consents = await rowsOf(ctx, "oauthConsent");
		expect(consents.map((row) => row.referenceId).sort()).toEqual(
			[ORGANIZATION_ID, REFERENCE_ONE].sort(),
		);
	});

	it("binds an API resource to the API audience", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, API_PROJECT_ONE);

		const exchanged = await exchange(ctx, clientId, code, {
			resource: API_PROJECT_ONE,
		});

		expect(exchanged.response.status).toBe(200);
		expect(
			(await rowsOf(ctx, "oauthAccessToken")).map(
				(row) => row.referenceId,
			),
		).toEqual(["project:api:project-example-one"]);
	});

	describe("refuses", () => {
		it("a person who cannot read the project, the same way for a project that does not exist", async () => {
			fixtures.readableProjects.delete("project-example-one");
			const ctx = await boot();
			const { body: client } = await register(ctx.call);

			const unreadable = await authorize(ctx, client.client_id, {
				resource: PROJECT_ONE,
			});
			const missing = await authorize(ctx, client.client_id, {
				resource: `${APP_URL}/api/mcp-gateway/projects/project-example-missing`,
			});

			for (const response of [unreadable, missing]) {
				expect(response.status).toBe(403);
				expect(await response.json()).toMatchObject({
					error: "access_denied",
					error_description: "You don't have access to this project.",
				});
			}
			expect(fixtures.bindings.size).toBe(0);
			expect(await rowsOf(ctx, "oauthConsent")).toHaveLength(0);
		});

		it("a consent given after the person lost access to the project", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);
			const response = await authorize(ctx, client.client_id, {
				resource: PROJECT_ONE,
			});
			fixtures.readableProjects.delete("project-example-one");

			const consent = await postConsent(ctx, response);

			expect(consent.status).toBe(403);
			expect(await consent.json()).toMatchObject({
				error: "access_denied",
				error_description: "You don't have access to this project.",
			});
			expect(await rowsOf(ctx, "oauthConsent")).toHaveLength(0);
		});

		it("an authorization that is sent on to the organization page when the project cannot be read", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);
			await authorize(ctx, client.client_id, { resource: PROJECT_ONE });
			fixtures.readableProjects.delete("project-example-one");

			// What the plugin dispatches again after the sign-in: the signed query
			// carries no `resource`, only the client and the challenge.
			const resumed = await authorize(ctx, client.client_id, {
				resource: null,
			});

			expect(resumed.headers.get("location")).toContain(
				"/auth/oauth/organization",
			);
		});

		it("more than one resource when one of them names a project", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);

			const response = await authorize(ctx, client.client_id, {
				resource: [PROJECT_ONE, PROJECT_TWO],
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: "invalid_target",
			});
			expect(fixtures.bindings.size).toBe(0);
		});

		it("a project resource that is not spelled exactly as the metadata publishes it", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);

			for (const resource of [
				`${PROJECT_ONE}/`,
				`${PROJECT_ONE}/extra`,
				`${APP_URL}/api/mcp-gateway/projects/a%2Fb`,
			]) {
				const response = await authorize(ctx, client.client_id, {
					resource,
				});

				expect(response.status, resource).toBe(400);
				expect(await response.json()).toMatchObject({
					error: "invalid_target",
				});
			}
			expect(fixtures.bindings.size).toBe(0);
		});

		it("a project resource sent without a PKCE challenge", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);

			const response = await authorize(ctx, client.client_id, {
				resource: PROJECT_ONE,
				withChallenge: false,
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: "invalid_request",
			});
		});
	});

	describe("keeps the binding", () => {
		it("alive while the authorization is walked on, and no request for anything else removes it", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);
			await authorize(ctx, client.client_id, { resource: PROJECT_ONE });

			const resumed = await authorize(ctx, client.client_id, {
				resource: null,
			});
			const asked = await authorize(ctx, client.client_id, {
				resource: ORGANIZATION_WIDE,
			});

			expect(resumed.headers.get("location")).toContain(
				"/auth/oauth/consent",
			);
			expect(asked.headers.get("location")).toContain(
				"/auth/oauth/consent",
			);
			expect([...fixtures.bindings.values()]).toHaveLength(1);
			const code = await consentTo(ctx, asked);
			await exchange(ctx, client.client_id, code);
			expect(
				(await rowsOf(ctx, "oauthConsent")).map(
					(row) => row.referenceId,
				),
			).toEqual([REFERENCE_ONE]);
		});

		it("only while it is live: a lapsed one leaves an organization grant that no project token can come from", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);
			const response = await authorize(ctx, client.client_id, {
				resource: PROJECT_ONE,
			});
			lapseBindings();

			const code = await consentTo(ctx, response);
			const exchanged = await exchange(ctx, client.client_id, code, {
				resource: PROJECT_ONE,
			});

			expect(exchanged.response.status).toBe(400);
			expect(exchanged.body.error).toBe("invalid_target");
			expect(await rowsOf(ctx, "oauthAccessToken")).toHaveLength(0);
		});
	});
});

describe("exchanging a code for a project's token", () => {
	it("refuses another project's resource with invalid_target and mints nothing", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);

		const { response, body } = await exchange(ctx, clientId, code, {
			resource: PROJECT_TWO,
		});

		expect(response.status).toBe(400);
		expect(body.error).toBe("invalid_target");
		expect(await rowsOf(ctx, "oauthAccessToken")).toHaveLength(0);
		expect(await rowsOf(ctx, "oauthRefreshToken")).toHaveLength(0);
	});

	it("refuses the other audience of the same project", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);

		const { response, body } = await exchange(ctx, clientId, code, {
			resource: API_PROJECT_ONE,
		});

		expect(response.status).toBe(400);
		expect(body.error).toBe("invalid_target");
	});

	it("answers a code that was never issued, or was spent, invalid_grant and not invalid_target", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);
		await exchange(ctx, clientId, code, { resource: PROJECT_ONE });

		const replayed = await exchange(ctx, clientId, code, {
			resource: PROJECT_ONE,
		});
		const unknown = await exchange(ctx, clientId, "never-issued", {
			resource: PROJECT_ONE,
		});

		for (const answer of [replayed, unknown]) {
			expect(answer.body.error).toBe("invalid_grant");
			expect(answer.response.status).toBeGreaterThanOrEqual(400);
			expect(answer.response.status).toBeLessThan(500);
		}
	});

	it("does not spend the code on a refusal, so the right request still works", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);
		await exchange(ctx, clientId, code, { resource: PROJECT_TWO });

		const retried = await exchange(ctx, clientId, code, {
			resource: PROJECT_ONE,
		});

		expect(retried.response.status).toBe(200);
	});

	it("keeps the token on its project when the request names no resource, or the organization-wide one", async () => {
		const ctx = await boot();
		const first = await authorizedFor(ctx, PROJECT_ONE);
		const second = await authorizedFor(ctx, PROJECT_ONE, OTHER_VERIFIER);

		const bare = await exchange(ctx, first.clientId, first.code);
		const wide = await exchange(ctx, second.clientId, second.code, {
			resource: ORGANIZATION_WIDE,
			verifier: OTHER_VERIFIER,
		});

		expect(bare.response.status).toBe(200);
		expect(wide.response.status).toBe(200);
		expect(
			(await rowsOf(ctx, "oauthAccessToken")).map(
				(row) => row.referenceId,
			),
		).toEqual([REFERENCE_ONE, REFERENCE_ONE]);
	});

	it("refuses a project resource for an organization grant", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, ORGANIZATION_WIDE);

		const { response, body } = await exchange(ctx, clientId, code, {
			resource: PROJECT_ONE,
		});

		expect(response.status).toBe(400);
		expect(body.error).toBe("invalid_target");
	});

	it("refuses a project resource that is not spelled exactly as published", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);

		const { response, body } = await exchange(ctx, clientId, code, {
			resource: `${PROJECT_ONE}/`,
		});

		expect(response.status).toBe(400);
		expect(body.error).toBe("invalid_target");
	});

	it("still refuses a resource that is neither the gateway, the API nor a project", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);

		const { response, body } = await exchange(ctx, clientId, code, {
			resource: "https://elsewhere.example/api",
		});

		expect(response.status).toBe(400);
		expect(body.error).toBe("invalid_request");
	});
});

describe("refreshing a project's token", () => {
	it("keeps the binding and rotates the pair", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);
		const first = await exchange(ctx, clientId, code, {
			resource: PROJECT_ONE,
		});

		const refreshed = await refreshWith(
			ctx,
			clientId,
			first.body.refresh_token as string,
			PROJECT_ONE,
		);

		expect(refreshed.status).toBe(200);
		expect(
			(await rowsOf(ctx, "oauthAccessToken")).map(
				(row) => row.referenceId,
			),
		).toEqual([REFERENCE_ONE, REFERENCE_ONE]);
		expect(
			(await rowsOf(ctx, "oauthRefreshToken")).map(
				(row) => row.referenceId,
			),
		).toContain(REFERENCE_ONE);
	});

	it("keeps the binding when the refresh names no resource", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);
		const first = await exchange(ctx, clientId, code);

		const refreshed = await refreshWith(
			ctx,
			clientId,
			first.body.refresh_token as string,
		);

		expect(refreshed.status).toBe(200);
		expect(
			(await rowsOf(ctx, "oauthAccessToken")).map(
				(row) => row.referenceId,
			),
		).toEqual([REFERENCE_ONE, REFERENCE_ONE]);
	});

	it("refuses to retarget to another project, to the other audience or to nothing it was made for", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);
		const first = await exchange(ctx, clientId, code);
		const refreshToken = first.body.refresh_token as string;

		for (const resource of [
			PROJECT_TWO,
			API_PROJECT_ONE,
			`${PROJECT_ONE}/`,
		]) {
			const refreshed = await refreshWith(
				ctx,
				clientId,
				refreshToken,
				resource,
			);

			expect(refreshed.status, resource).toBe(400);
			expect(((await refreshed.json()) as TokenBody).error).toBe(
				"invalid_target",
			);
		}
		// Nothing was spent: the same token still refreshes.
		expect((await refreshWith(ctx, clientId, refreshToken)).status).toBe(
			200,
		);
	});

	it("answers a refresh token the server never issued as the plugin does, invalid_grant, and not as a wrong resource", async () => {
		const ctx = await boot();
		const { clientId } = await authorizedFor(ctx, PROJECT_ONE);

		const refreshed = await refreshWith(
			ctx,
			clientId,
			`${OAUTH_REFRESH_TOKEN_PREFIX}${hashOAuthToken("unknown")}`,
			PROJECT_ONE,
		);

		expect(refreshed.status).toBe(400);
		expect(((await refreshed.json()) as TokenBody).error).toBe(
			"invalid_grant",
		);
	});

	it("answers a revoked refresh token invalid_grant, so the client signs in again", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);
		const first = await exchange(ctx, clientId, code, {
			resource: PROJECT_ONE,
		});
		const revoked = await ctx.call("/oauth2/revoke", {
			method: "POST",
			headers: FORM,
			body: new URLSearchParams({
				token: first.body.refresh_token as string,
				token_type_hint: "refresh_token",
				client_id: clientId,
			}).toString(),
		});
		expect(revoked.status).toBe(200);

		const refreshed = await refreshWith(
			ctx,
			clientId,
			first.body.refresh_token as string,
			PROJECT_ONE,
		);

		expect(refreshed.status).toBe(400);
		expect(((await refreshed.json()) as TokenBody).error).toBe(
			"invalid_grant",
		);
	});

	it("still refuses a live refresh token with invalid_target when its grant is for another project", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);
		const first = await exchange(ctx, clientId, code);

		const refreshed = await refreshWith(
			ctx,
			clientId,
			first.body.refresh_token as string,
			PROJECT_TWO,
		);

		expect(refreshed.status).toBe(400);
		expect(((await refreshed.json()) as TokenBody).error).toBe(
			"invalid_target",
		);
	});

	it("ends the whole family when a spent refresh token is replayed, as it does for an organization grant", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);
		const first = await exchange(ctx, clientId, code, {
			resource: PROJECT_ONE,
		});
		const spent = first.body.refresh_token as string;
		await refreshWith(ctx, clientId, spent, PROJECT_ONE);

		const replay = await refreshWith(ctx, clientId, spent, PROJECT_ONE);

		expect(replay.status).toBe(400);
		expect(((await replay.json()) as TokenBody).error).toBe(
			"invalid_grant",
		);
		expect(await rowsOf(ctx, "oauthRefreshToken")).toHaveLength(0);
	});
});

describe("an authorization that names no project", () => {
	it("behaves as it did before: the organization picker, an organization consent, an organization token", async () => {
		fixtures.organizationCount = 2;
		const ctx = await boot();
		const { body: client } = await register(ctx.call);

		const response = await authorize(ctx, client.client_id, {
			resource: ORGANIZATION_WIDE,
		});

		expect(response.headers.get("location")).toContain(
			"/auth/oauth/organization",
		);
		expect(fixtures.bindings.size).toBe(0);
	});
});

const START_AGAIN = { error: "invalid_request" };

async function issuedCodes(ctx: Harness) {
	return (await rowsOf(ctx, "verification")).filter((row) =>
		String(row.value).includes('"type":"authorization_code"'),
	);
}

describe("consenting to what the page showed", () => {
	it("issues the project the page showed, and audits that grant", async () => {
		const ctx = await boot();
		const { body: client } = await register(ctx.call);
		const response = await authorize(ctx, client.client_id, {
			resource: PROJECT_ONE,
		});

		const consent = await postConsent(ctx, response);

		expect(consent.status).toBe(200);
		expect(
			(await rowsOf(ctx, "oauthConsent")).map((row) => row.referenceId),
		).toEqual([REFERENCE_ONE]);
		expect(recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "account.oauth.consent_granted",
				organizationId: ORGANIZATION_ID,
				metadata: expect.objectContaining({
					projectId: "project-example-one",
				}),
			}),
		);
	});

	it("audits an organization consent without a project", async () => {
		const ctx = await boot();
		const { body: client } = await register(ctx.call);
		const response = await authorize(ctx, client.client_id, {
			resource: ORGANIZATION_WIDE,
		});

		const consent = await postConsent(ctx, response);

		expect(consent.status).toBe(200);
		expect(recordAudit).toHaveBeenCalledOnce();
		const [audited] = vi.mocked(recordAudit).mock.calls[0];
		expect(audited.organizationId).toBe(ORGANIZATION_ID);
		expect(audited.metadata).not.toHaveProperty("projectId");
	});

	describe("refuses, and asks for the connection to be started again, when", () => {
		async function expectRefused(ctx: Harness, consent: Response) {
			expect(consent.status).toBe(400);
			expect(await consent.json()).toMatchObject(START_AGAIN);
			expect(await rowsOf(ctx, "oauthConsent")).toHaveLength(0);
			expect(await issuedCodes(ctx)).toHaveLength(0);
			expect(recordAudit).not.toHaveBeenCalled();
		}

		it("the binding was cleared after the page loaded", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);
			const response = await authorize(ctx, client.client_id, {
				resource: PROJECT_ONE,
			});
			const shown = pageShows(response);
			fixtures.bindings.clear();

			const consent = await postConsent(ctx, response, {
				[OAUTH_DISPLAYED_BINDING_FIELD]: shown,
			});

			await expectRefused(ctx, consent);
		});

		it("the binding was replaced by another project after the page loaded", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);
			const response = await authorize(ctx, client.client_id, {
				resource: PROJECT_ONE,
			});
			const shown = pageShows(response);
			for (const row of fixtures.bindings.values()) {
				row.projectId = "project-example-two";
			}

			const consent = await postConsent(ctx, response, {
				[OAUTH_DISPLAYED_BINDING_FIELD]: shown,
			});

			await expectRefused(ctx, consent);
		});

		it("the page showed no project and a binding is live", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);
			const response = await authorize(ctx, client.client_id, {
				resource: PROJECT_ONE,
			});

			const consent = await postConsent(ctx, response, {
				[OAUTH_DISPLAYED_BINDING_FIELD]: null,
			});

			await expectRefused(ctx, consent);
		});

		it("the page showed a project and no binding is live", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);
			const response = await authorize(ctx, client.client_id, {
				resource: ORGANIZATION_WIDE,
			});

			const consent = await postConsent(ctx, response, {
				[OAUTH_DISPLAYED_BINDING_FIELD]: {
					projectId: "project-example-one",
					audience: "mcp",
				},
			});

			await expectRefused(ctx, consent);
		});

		it("the page showed the other audience of the project", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);
			const response = await authorize(ctx, client.client_id, {
				resource: PROJECT_ONE,
			});

			const consent = await postConsent(ctx, response, {
				[OAUTH_DISPLAYED_BINDING_FIELD]: {
					projectId: "project-example-one",
					audience: "api",
				},
			});

			await expectRefused(ctx, consent);
		});

		it("the request does not say what was shown", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);
			const response = await authorize(ctx, client.client_id, {
				resource: ORGANIZATION_WIDE,
			});

			const consent = await postConsent(ctx, response, {});

			await expectRefused(ctx, consent);
		});

		it("what it says was shown is neither a project nor an explicit none", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);
			const response = await authorize(ctx, client.client_id, {
				resource: PROJECT_ONE,
			});

			for (const shown of [
				"project-example-one",
				[],
				{},
				{ projectId: "project-example-one" },
				{ projectId: "a/b", audience: "mcp" },
				{ projectId: 7, audience: "mcp" },
			]) {
				const consent = await postConsent(ctx, response, {
					[OAUTH_DISPLAYED_BINDING_FIELD]: shown,
				});

				expect(consent.status, JSON.stringify(shown)).toBe(400);
			}
			expect(await rowsOf(ctx, "oauthConsent")).toHaveLength(0);
			expect(await issuedCodes(ctx)).toHaveLength(0);
		});

		it("the binding is about to lapse", async () => {
			const ctx = await boot();
			const { body: client } = await register(ctx.call);
			const response = await authorize(ctx, client.client_id, {
				resource: PROJECT_ONE,
			});
			for (const row of fixtures.bindings.values()) {
				row.expiresAt = Date.now() + 30 * 1000;
			}

			const consent = await postConsent(ctx, response);

			await expectRefused(ctx, consent);
		});
	});

	it("lets a denial through, whatever it says was shown", async () => {
		const ctx = await boot();
		const { body: client } = await register(ctx.call);
		const response = await authorize(ctx, client.client_id, {
			resource: PROJECT_ONE,
		});
		fixtures.bindings.clear();

		const denial = await ctx.call("/oauth2/consent", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				accept: false,
				oauth_query: signedQueryOf(response),
			}),
		});

		expect(denial.status).toBe(200);
		expect(((await denial.json()) as { url: string }).url).toContain(
			"error=access_denied",
		);
		expect(recordAudit).not.toHaveBeenCalled();
	});
});

describe("a live binding is write-once", () => {
	it("keeps the project that was asked for first when another is asked for with the same key", async () => {
		const ctx = await boot();
		const { body: client } = await register(ctx.call);
		const first = await authorize(ctx, client.client_id, {
			resource: PROJECT_ONE,
		});

		const second = await authorize(ctx, client.client_id, {
			resource: PROJECT_TWO,
		});

		expect(second.status).toBe(400);
		expect(await second.json()).toMatchObject(START_AGAIN);
		expect(pageShows(first)).toEqual({
			projectId: "project-example-one",
			audience: "mcp",
		});
		const code = await consentTo(ctx, first);
		await exchange(ctx, client.client_id, code);
		expect(
			(await rowsOf(ctx, "oauthConsent")).map((row) => row.referenceId),
		).toEqual([REFERENCE_ONE]);
	});

	it("refuses the other audience of the same project the same way", async () => {
		const ctx = await boot();
		const { body: client } = await register(ctx.call);
		await authorize(ctx, client.client_id, { resource: PROJECT_ONE });

		const second = await authorize(ctx, client.client_id, {
			resource: API_PROJECT_ONE,
		});

		expect(second.status).toBe(400);
		expect([...fixtures.bindings.values()]).toMatchObject([
			{ audience: "mcp" },
		]);
	});

	it("takes the same request again for the same binding", async () => {
		const ctx = await boot();
		const { body: client } = await register(ctx.call);
		await authorize(ctx, client.client_id, { resource: PROJECT_ONE });

		const again = await authorize(ctx, client.client_id, {
			resource: PROJECT_ONE,
		});

		expect(again.headers.get("location")).toContain("/auth/oauth/consent");
		expect(fixtures.bindings.size).toBe(1);
	});

	it("does not let a request for the organization remove it", async () => {
		const ctx = await boot();
		const { body: client } = await register(ctx.call);
		const first = await authorize(ctx, client.client_id, {
			resource: PROJECT_ONE,
		});

		await authorize(ctx, client.client_id, { resource: ORGANIZATION_WIDE });

		expect(pageShows(first)).toMatchObject({
			projectId: "project-example-one",
		});
	});
});

describe("spending a code leaves the binding where it is", () => {
	it("is still there once a project's code is exchanged", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);
		expect(fixtures.bindings.size).toBe(1);

		const exchanged = await exchange(ctx, clientId, code, {
			resource: PROJECT_ONE,
		});

		expect(exchanged.response.status).toBe(200);
		expect(fixtures.bindings.size).toBe(1);
	});

	it("is still there when the exchange names no resource", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);

		await exchange(ctx, clientId, code);

		expect(fixtures.bindings.size).toBe(1);
	});

	it("is still there when the exchange is refused before the code is spent", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);

		await exchange(ctx, clientId, code, { resource: PROJECT_TWO });

		expect(fixtures.bindings.size).toBe(1);
	});

	it("keeps a later flow with the same challenge bound to the same project, until the binding expires", async () => {
		const ctx = await boot();
		const { clientId, code } = await authorizedFor(ctx, PROJECT_ONE);
		await exchange(ctx, clientId, code, { resource: PROJECT_ONE });

		const other = await authorize(ctx, clientId, { resource: PROJECT_TWO });
		const unbound = await authorize(ctx, clientId, {
			resource: ORGANIZATION_WIDE,
		});

		expect(other.status).toBe(400);
		expect(await other.json()).toMatchObject(START_AGAIN);
		const location = unbound.headers.get("location") ?? "";
		expect(location).toContain(REDIRECT_URI);
		const nextCode = new URL(location).searchParams.get("code") as string;
		const next = await exchange(ctx, clientId, nextCode);
		expect(next.response.status).toBe(200);
		expect(
			(await rowsOf(ctx, "oauthAccessToken")).map(
				(row) => row.referenceId,
			),
		).toEqual([REFERENCE_ONE, REFERENCE_ONE]);
	});

	it("cannot be removed between the consent check and the plugin's own read by spending codes minted beforehand", async () => {
		const ctx = await boot();
		const { clientId, code: mintedBeforehand } = await authorizedFor(
			ctx,
			ORGANIZATION_WIDE,
		);
		const victim = await authorize(ctx, clientId, {
			resource: PROJECT_ONE,
		});
		const shown = pageShows(victim);
		expect(shown).toMatchObject({ projectId: "project-example-one" });

		// The binding is read once by the hook, as live, and the codes minted
		// for the same key are spent right behind that read, before the plugin
		// decides the grant from the binding.
		const params = new URLSearchParams(signedQueryOf(victim));
		const read = vi.mocked(findLiveOAuthAuthorizationResource);
		const stillLive = read.getMockImplementation();
		read.mockImplementationOnce(async (...args) => {
			const binding = await stillLive?.(...args);
			await exchange(
				ctx,
				params.get("client_id") as string,
				mintedBeforehand,
			);
			return binding ?? null;
		});

		const consent = await postConsent(ctx, victim, {
			[OAUTH_DISPLAYED_BINDING_FIELD]: shown,
		});
		const { url } = (await consent.json()) as { url: string };
		const code = new URL(url).searchParams.get("code") as string;
		const issued = await exchange(ctx, clientId, code);

		expect(issued.response.status).toBe(200);
		expect(
			(await rowsOf(ctx, "oauthAccessToken")).map(
				(row) => row.referenceId,
			),
		).toEqual([ORGANIZATION_ID, REFERENCE_ONE]);
	});
});

describe("checking a request before anything is written", () => {
	it("refuses a client that is not registered", async () => {
		const ctx = await boot();

		const response = await authorize(ctx, "client-never-registered", {
			resource: PROJECT_ONE,
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: "invalid_client",
		});
		expect(fixtures.bindings.size).toBe(0);
	});

	it("refuses a client that is disabled", async () => {
		const ctx = await boot();
		const { body: client } = await register(ctx.call);
		await ctx.instance.db.update({
			model: "oauthClient",
			where: [{ field: "clientId", value: client.client_id }],
			update: { disabled: true },
		});

		const response = await authorize(ctx, client.client_id, {
			resource: PROJECT_ONE,
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: "client_disabled",
		});
		expect(fixtures.bindings.size).toBe(0);
	});

	it("refuses a client_id longer than any this server issues", async () => {
		const ctx = await boot();

		const response = await authorize(ctx, "c".repeat(256), {
			resource: PROJECT_ONE,
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject(START_AGAIN);
		expect(fixtures.bindings.size).toBe(0);
	});

	it("refuses a code_challenge that is not an S256 digest", async () => {
		const ctx = await boot();
		const { body: client } = await register(ctx.call);

		for (const codeChallenge of [
			"short",
			"a".repeat(44),
			`${"a".repeat(42)}+`,
			`${"a".repeat(42)}=`,
			"a".repeat(4096),
		]) {
			const response = await authorize(ctx, client.client_id, {
				resource: PROJECT_ONE,
				codeChallenge,
			});

			expect(response.status, codeChallenge.slice(0, 12)).toBe(400);
			expect(await response.json()).toMatchObject(START_AGAIN);
		}
		expect(fixtures.bindings.size).toBe(0);
	});

	it("extends nothing for a pair that could not be a binding's key", async () => {
		const ctx = await boot();
		const { body: client } = await register(ctx.call);

		await authorize(ctx, client.client_id, {
			resource: null,
			codeChallenge: "a".repeat(4096),
		});

		expect(extendOAuthAuthorizationResource).not.toHaveBeenCalled();
	});
});
