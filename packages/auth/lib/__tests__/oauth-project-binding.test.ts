/**
 * The before-hooks that bind an authorization to a project, and the reader of
 * what a consent issued, on the edges the end-to-end suite
 * (`oauth-project-flow.test.ts`) cannot reach with the real plugin: a grant that
 * cannot be read, a request that never touches the database, and a caller who
 * is not signed in yet.
 */

import { OAUTH_DISPLAYED_BINDING_FIELD } from "@repo/utils/oauth-project-resource";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	enforceOAuthResourceBinding,
	issuedGrantOfConsent,
} from "../oauth-project-binding";

interface Standing {
	resource: string;
	projectId: string;
	audience: "mcp" | "api";
}

const database = vi.hoisted(() => ({
	extendOAuthAuthorizationResource: vi.fn(async () => undefined),
	findLiveOAuthAuthorizationResource: vi.fn(
		async (
			_clientId: string,
			_codeChallenge: string,
			_now?: Date,
		): Promise<Standing | null> => null,
	),
	resolveOAuthProjectGrantTarget: vi.fn(
		async (): Promise<{
			projectId: string;
			organizationId: string;
		} | null> => null,
	),
	saveOAuthAuthorizationResource: vi.fn(
		async (_params: Standing): Promise<Standing | null> => null,
	),
}));

/** What the database answers when nothing else stands: the binding that was written. */
async function writtenAsAsked(params: Standing): Promise<Standing | null> {
	return {
		resource: params.resource,
		projectId: params.projectId,
		audience: params.audience,
	};
}

vi.mock("@repo/database", async () => ({
	...(await import("../../../database/prisma/queries/oauth-token-format")),
	...database,
}));

const APP_URL = "https://app.example.com";
const PROJECT = `${APP_URL}/api/mcp-gateway/projects/project-example-one`;
const CHALLENGE = "c".repeat(43);

function context(
	input: {
		path: string;
		query?: Record<string, unknown>;
		body?: Record<string, unknown>;
		returned?: unknown;
	},
	stored: {
		verification?: string | null;
		refresh?: { referenceId: string };
		client?: { disabled?: boolean } | null;
	} = {},
) {
	const findVerificationValue = vi.fn(async (_identifier: string) =>
		stored.verification === undefined || stored.verification === null
			? null
			: { value: stored.verification },
	);
	const findOne = vi.fn(
		async (args: {
			model: string;
			where: Array<{ field: string; value: string }>;
		}) =>
			args.model === "oauthClient"
				? stored.client === undefined
					? { disabled: false }
					: stored.client
				: (stored.refresh ?? null),
	);
	const { returned, ...request } = input;
	return {
		ctx: {
			...request,
			context: {
				internalAdapter: { findVerificationValue },
				adapter: { findOne },
				returned,
			},
		},
		findVerificationValue,
		findOne,
	};
}

const signedOut = { appUrl: APP_URL, getSessionUserId: async () => null };
const signedIn = { appUrl: APP_URL, getSessionUserId: async () => "user-1" };

const PROJECT_QUERY = {
	client_id: "client-1",
	code_challenge: CHALLENGE,
	resource: PROJECT,
};

beforeEach(() => {
	vi.clearAllMocks();
	database.resolveOAuthProjectGrantTarget.mockResolvedValue(null);
	database.findLiveOAuthAuthorizationResource.mockResolvedValue(null);
	database.saveOAuthAuthorizationResource.mockImplementation(writtenAsAsked);
});

describe("an endpoint it has no business with", () => {
	it("is left alone, without touching the database", async () => {
		const { ctx, findOne, findVerificationValue } = context({
			path: "/sign-in/email",
			body: { resource: PROJECT },
		});

		expect(
			await enforceOAuthResourceBinding(ctx, signedIn),
		).toBeUndefined();

		expect(findVerificationValue).not.toHaveBeenCalled();
		expect(findOne).not.toHaveBeenCalled();
		expect(database.saveOAuthAuthorizationResource).not.toHaveBeenCalled();
	});
});

describe("authorizing", () => {
	it("records the binding of a caller who is not signed in without asking whether the project exists", async () => {
		const { ctx } = context({
			path: "/oauth2/authorize",
			query: PROJECT_QUERY,
		});

		await enforceOAuthResourceBinding(ctx, signedOut);

		expect(database.resolveOAuthProjectGrantTarget).not.toHaveBeenCalled();
		expect(database.saveOAuthAuthorizationResource).toHaveBeenCalledWith({
			clientId: "client-1",
			codeChallenge: CHALLENGE,
			resource: PROJECT,
			projectId: "project-example-one",
			audience: "mcp",
		});
	});

	it("refuses, and says to start again, when the binding that stands is another project's", async () => {
		database.saveOAuthAuthorizationResource.mockResolvedValue({
			resource: `${APP_URL}/api/mcp-gateway/projects/project-example-two`,
			projectId: "project-example-two",
			audience: "mcp",
		});
		const { ctx } = context({
			path: "/oauth2/authorize",
			query: PROJECT_QUERY,
		});

		await expect(
			enforceOAuthResourceBinding(ctx, signedOut),
		).rejects.toMatchObject({ body: { error: "invalid_request" } });
	});

	it("refuses when no binding stands after the write", async () => {
		database.saveOAuthAuthorizationResource.mockResolvedValue(null);
		const { ctx } = context({
			path: "/oauth2/authorize",
			query: PROJECT_QUERY,
		});

		await expect(
			enforceOAuthResourceBinding(ctx, signedOut),
		).rejects.toMatchObject({ body: { error: "invalid_request" } });
	});

	it("accepts the binding that stands when it is the one asked for", async () => {
		const { ctx } = context({
			path: "/oauth2/authorize",
			query: PROJECT_QUERY,
		});

		await expect(
			enforceOAuthResourceBinding(ctx, signedOut),
		).resolves.toBeUndefined();
	});

	describe("writes nothing for", () => {
		it("a client that is not registered", async () => {
			const { ctx, findOne } = context(
				{ path: "/oauth2/authorize", query: PROJECT_QUERY },
				{ client: null },
			);

			await expect(
				enforceOAuthResourceBinding(ctx, signedOut),
			).rejects.toMatchObject({ body: { error: "invalid_client" } });

			expect(findOne).toHaveBeenCalledWith({
				model: "oauthClient",
				where: [{ field: "clientId", value: "client-1" }],
			});
			expect(
				database.saveOAuthAuthorizationResource,
			).not.toHaveBeenCalled();
		});

		it("a client that is disabled", async () => {
			const { ctx } = context(
				{ path: "/oauth2/authorize", query: PROJECT_QUERY },
				{ client: { disabled: true } },
			);

			await expect(
				enforceOAuthResourceBinding(ctx, signedOut),
			).rejects.toMatchObject({ body: { error: "client_disabled" } });

			expect(
				database.saveOAuthAuthorizationResource,
			).not.toHaveBeenCalled();
		});

		it("a client_id of more than 255 characters, without looking it up", async () => {
			const { ctx, findOne } = context({
				path: "/oauth2/authorize",
				query: { ...PROJECT_QUERY, client_id: "c".repeat(256) },
			});

			await expect(
				enforceOAuthResourceBinding(ctx, signedOut),
			).rejects.toMatchObject({ body: { error: "invalid_request" } });

			expect(findOne).not.toHaveBeenCalled();
			expect(
				database.saveOAuthAuthorizationResource,
			).not.toHaveBeenCalled();
		});

		it("a client_id of 255 characters", async () => {
			const { ctx } = context({
				path: "/oauth2/authorize",
				query: { ...PROJECT_QUERY, client_id: "c".repeat(255) },
			});

			await enforceOAuthResourceBinding(ctx, signedOut);

			expect(
				database.saveOAuthAuthorizationResource,
			).toHaveBeenCalledOnce();
		});

		it.each([
			["too short", "c".repeat(42)],
			["too long", "c".repeat(44)],
			["standard base64", `${"c".repeat(42)}+`],
			["padded", `${"c".repeat(42)}=`],
			["with a space", `${"c".repeat(42)} `],
			["oversized", "c".repeat(100_000)],
		])("a code_challenge that is %s", async (_label, codeChallenge) => {
			const { ctx, findOne } = context({
				path: "/oauth2/authorize",
				query: { ...PROJECT_QUERY, code_challenge: codeChallenge },
			});

			await expect(
				enforceOAuthResourceBinding(ctx, signedOut),
			).rejects.toMatchObject({ body: { error: "invalid_request" } });

			expect(findOne).not.toHaveBeenCalled();
			expect(
				database.saveOAuthAuthorizationResource,
			).not.toHaveBeenCalled();
		});
	});

	it("answers a signed-in caller who cannot read the project, and writes nothing", async () => {
		const { ctx } = context({
			path: "/oauth2/authorize",
			query: PROJECT_QUERY,
		});

		await expect(
			enforceOAuthResourceBinding(ctx, signedIn),
		).rejects.toMatchObject({
			body: {
				error: "access_denied",
				error_description: "You don't have access to this project.",
			},
		});

		expect(database.saveOAuthAuthorizationResource).not.toHaveBeenCalled();
	});

	it("records the binding of a signed-in caller who can read the project", async () => {
		database.resolveOAuthProjectGrantTarget.mockResolvedValue({
			projectId: "project-example-one",
			organizationId: "org-example-alpha",
		});
		const { ctx } = context({
			path: "/oauth2/authorize",
			query: PROJECT_QUERY,
		});

		await enforceOAuthResourceBinding(ctx, signedIn);

		expect(database.resolveOAuthProjectGrantTarget).toHaveBeenCalledWith(
			"user-1",
			"project-example-one",
		);
		expect(database.saveOAuthAuthorizationResource).toHaveBeenCalledOnce();
	});

	it("takes a repeated client_id or code_challenge for neither", async () => {
		const { ctx } = context({
			path: "/oauth2/authorize",
			query: { ...PROJECT_QUERY, client_id: ["client-1", "client-2"] },
		});

		await expect(
			enforceOAuthResourceBinding(ctx, signedOut),
		).rejects.toMatchObject({ body: { error: "invalid_request" } });
		expect(database.saveOAuthAuthorizationResource).not.toHaveBeenCalled();
	});

	it("keeps an authorization that names no resource alive and touches nothing else", async () => {
		const { ctx } = context({
			path: "/oauth2/authorize",
			query: { client_id: "client-1", code_challenge: CHALLENGE },
		});

		await enforceOAuthResourceBinding(ctx, signedIn);

		expect(database.extendOAuthAuthorizationResource).toHaveBeenCalledWith(
			"client-1",
			CHALLENGE,
		);
		expect(database.saveOAuthAuthorizationResource).not.toHaveBeenCalled();
	});

	it("leaves an organization-wide request to the plugin and writes or extends nothing", async () => {
		const { ctx } = context({
			path: "/oauth2/authorize",
			query: {
				client_id: "client-1",
				code_challenge: CHALLENGE,
				resource: `${APP_URL}/api/mcp-gateway`,
			},
		});

		await enforceOAuthResourceBinding(ctx, signedIn);

		expect(database.saveOAuthAuthorizationResource).not.toHaveBeenCalled();
		expect(
			database.extendOAuthAuthorizationResource,
		).not.toHaveBeenCalled();
	});
});

describe("consenting", () => {
	const SIGNED_QUERY = new URLSearchParams({
		client_id: "client-1",
		code_challenge: CHALLENGE,
		scope: "mcp:read",
	}).toString();

	const LIVE: Standing = {
		resource: PROJECT,
		projectId: "project-example-one",
		audience: "mcp",
	};

	function consent(body: Record<string, unknown>) {
		return context({ path: "/oauth2/consent", body });
	}

	it("lets an approval through that says it showed the binding that is live", async () => {
		database.findLiveOAuthAuthorizationResource.mockResolvedValue(LIVE);
		const { ctx } = consent({
			accept: true,
			oauth_query: SIGNED_QUERY,
			[OAUTH_DISPLAYED_BINDING_FIELD]: {
				projectId: "project-example-one",
				audience: "mcp",
			},
		});

		await expect(
			enforceOAuthResourceBinding(ctx, signedIn),
		).resolves.toBeUndefined();
	});

	it("lets an approval through that says it showed none when none is live", async () => {
		const { ctx } = consent({
			accept: true,
			oauth_query: SIGNED_QUERY,
			[OAUTH_DISPLAYED_BINDING_FIELD]: null,
		});

		await expect(
			enforceOAuthResourceBinding(ctx, signedIn),
		).resolves.toBeUndefined();
	});

	it("reads the binding by the client and challenge of the signed query, as of a minute from now", async () => {
		const before = Date.now();
		const { ctx } = consent({
			accept: true,
			oauth_query: SIGNED_QUERY,
			[OAUTH_DISPLAYED_BINDING_FIELD]: null,
		});

		await enforceOAuthResourceBinding(ctx, signedIn);

		const [clientId, codeChallenge, asOf] =
			database.findLiveOAuthAuthorizationResource.mock.calls[0];
		expect([clientId, codeChallenge]).toEqual(["client-1", CHALLENGE]);
		expect(asOf?.getTime()).toBeGreaterThanOrEqual(before + 60 * 1000);
		expect(asOf?.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 1000);
	});

	it("refuses an approval that says none was shown when a binding is live", async () => {
		database.findLiveOAuthAuthorizationResource.mockResolvedValue(LIVE);
		const { ctx } = consent({
			accept: true,
			oauth_query: SIGNED_QUERY,
			[OAUTH_DISPLAYED_BINDING_FIELD]: null,
		});

		await expect(
			enforceOAuthResourceBinding(ctx, signedIn),
		).rejects.toMatchObject({ body: { error: "invalid_request" } });
	});

	it("refuses an approval that names a project when none is live", async () => {
		const { ctx } = consent({
			accept: true,
			oauth_query: SIGNED_QUERY,
			[OAUTH_DISPLAYED_BINDING_FIELD]: {
				projectId: "project-example-one",
				audience: "mcp",
			},
		});

		await expect(
			enforceOAuthResourceBinding(ctx, signedIn),
		).rejects.toMatchObject({ body: { error: "invalid_request" } });
	});

	it.each([
		[
			"another project",
			{ projectId: "project-example-two", audience: "mcp" },
		],
		[
			"another audience",
			{ projectId: "project-example-one", audience: "api" },
		],
		["no field at all", undefined],
		["a string", "project-example-one"],
		["an array", []],
		["an object without an audience", { projectId: "project-example-one" }],
		["a project id that is not one", { projectId: "a/b", audience: "mcp" }],
	])(
		"refuses an approval that carries %s against a live binding",
		async (_label, displayed) => {
			database.findLiveOAuthAuthorizationResource.mockResolvedValue(LIVE);
			const { ctx } = consent({
				accept: true,
				oauth_query: SIGNED_QUERY,
				...(displayed === undefined
					? {}
					: { [OAUTH_DISPLAYED_BINDING_FIELD]: displayed }),
			});

			await expect(
				enforceOAuthResourceBinding(ctx, signedIn),
			).rejects.toMatchObject({ body: { error: "invalid_request" } });
		},
	);

	it.each([
		["a denial", { accept: false }],
		["a request without accept", {}],
		["an accept that is not true", { accept: "true" }],
	])("does not look at the database for %s", async (_label, body) => {
		const { ctx } = consent({ oauth_query: SIGNED_QUERY, ...body });

		await expect(
			enforceOAuthResourceBinding(ctx, signedIn),
		).resolves.toBeUndefined();

		expect(
			database.findLiveOAuthAuthorizationResource,
		).not.toHaveBeenCalled();
	});

	it("takes a signed query it cannot read a pair from for one with no binding", async () => {
		for (const oauthQuery of [undefined, "", "client_id=client-1", 7]) {
			const { ctx } = consent({
				accept: true,
				oauth_query: oauthQuery,
				[OAUTH_DISPLAYED_BINDING_FIELD]: null,
			});

			await expect(
				enforceOAuthResourceBinding(ctx, signedIn),
			).resolves.toBeUndefined();
		}
		expect(
			database.findLiveOAuthAuthorizationResource,
		).not.toHaveBeenCalled();
	});
});

describe("exchanging a token", () => {
	it("does not read the grant when the request names no resource", async () => {
		const { ctx, findOne, findVerificationValue } = context({
			path: "/oauth2/token",
			body: { grant_type: "authorization_code", code: "code-1" },
		});

		expect(
			await enforceOAuthResourceBinding(ctx, signedIn),
		).toBeUndefined();

		expect(findVerificationValue).not.toHaveBeenCalled();
		expect(findOne).not.toHaveBeenCalled();
	});

	it("does not read the grant when the resource is the organization-wide one", async () => {
		const { ctx, findVerificationValue } = context({
			path: "/oauth2/token",
			body: {
				grant_type: "authorization_code",
				code: "code-1",
				resource: `${APP_URL}/api/mcp-gateway`,
			},
		});

		expect(
			await enforceOAuthResourceBinding(ctx, signedIn),
		).toBeUndefined();

		expect(findVerificationValue).not.toHaveBeenCalled();
	});

	it("never writes, extends or reads a binding, whatever it lets through", async () => {
		for (const resource of [undefined, PROJECT]) {
			const { ctx } = context(
				{
					path: "/oauth2/token",
					body: {
						grant_type: "authorization_code",
						code: "code-1",
						...(resource === undefined ? {} : { resource }),
					},
				},
				{
					verification: JSON.stringify({
						referenceId: "project:mcp:project-example-one",
						query: {
							client_id: "client-1",
							code_challenge: CHALLENGE,
						},
					}),
				},
			);

			await enforceOAuthResourceBinding(ctx, signedIn);
		}

		expect(database.saveOAuthAuthorizationResource).not.toHaveBeenCalled();
		expect(
			database.extendOAuthAuthorizationResource,
		).not.toHaveBeenCalled();
		expect(
			database.findLiveOAuthAuthorizationResource,
		).not.toHaveBeenCalled();
	});

	it("rewrites a matching project resource to the static one and keeps the rest of the body", async () => {
		const { ctx } = context(
			{
				path: "/oauth2/token",
				body: {
					grant_type: "authorization_code",
					code: "code-1",
					client_id: "client-1",
					resource: PROJECT,
				},
			},
			{
				verification: JSON.stringify({
					referenceId: "project:mcp:project-example-one",
				}),
			},
		);

		expect(await enforceOAuthResourceBinding(ctx, signedIn)).toEqual({
			context: {
				body: {
					grant_type: "authorization_code",
					code: "code-1",
					client_id: "client-1",
					resource: `${APP_URL}/api/mcp-gateway`,
				},
			},
		});
	});

	it("looks the code up by its digest and never by the code", async () => {
		const { ctx, findVerificationValue } = context({
			path: "/oauth2/token",
			body: {
				grant_type: "authorization_code",
				code: "code-1",
				resource: PROJECT,
			},
		});

		await enforceOAuthResourceBinding(ctx, signedIn);

		const [identifier] = findVerificationValue.mock.calls[0];
		expect(identifier).toMatch(/^[0-9a-f]{64}$/);
		expect(identifier).not.toContain("code-1");
	});

	describe("refuses a live grant that was made for something else with invalid_target", () => {
		const refused = { body: { error: "invalid_target" } };

		it("when the code's grant is an organization's", async () => {
			const { ctx } = context(
				{
					path: "/oauth2/token",
					body: {
						grant_type: "authorization_code",
						code: "code-1",
						resource: PROJECT,
					},
				},
				{
					verification: JSON.stringify({
						referenceId: "org-example-alpha",
					}),
				},
			);

			await expect(
				enforceOAuthResourceBinding(ctx, signedIn),
			).rejects.toMatchObject(refused);
		});

		it.each([
			["another project", "project:mcp:project-example-two"],
			[
				"the other audience of this project",
				"project:api:project-example-one",
			],
		])("when the code's grant is for %s", async (_label, referenceId) => {
			const { ctx } = context(
				{
					path: "/oauth2/token",
					body: {
						grant_type: "authorization_code",
						code: "code-1",
						resource: PROJECT,
					},
				},
				{ verification: JSON.stringify({ referenceId }) },
			);

			await expect(
				enforceOAuthResourceBinding(ctx, signedIn),
			).rejects.toMatchObject(refused);
		});

		it("when the refresh token's grant is for another project", async () => {
			const { ctx } = context(
				{
					path: "/oauth2/token",
					body: {
						grant_type: "refresh_token",
						refresh_token: "frt_secret",
						resource: PROJECT,
					},
				},
				{ refresh: { referenceId: "project:mcp:project-example-two" } },
			);

			await expect(
				enforceOAuthResourceBinding(ctx, signedIn),
			).rejects.toMatchObject(refused);
		});
	});

	describe("leaves a grant it cannot find to the plugin, with the resource swapped for the static one", () => {
		const swapped = {
			context: {
				body: expect.objectContaining({
					resource: `${APP_URL}/api/mcp-gateway`,
				}),
			},
		};

		it("when the code is unknown", async () => {
			const { ctx } = context({
				path: "/oauth2/token",
				body: {
					grant_type: "authorization_code",
					code: "code-1",
					resource: PROJECT,
				},
			});

			expect(await enforceOAuthResourceBinding(ctx, signedIn)).toEqual(
				swapped,
			);
		});

		it("when the code's stored value is not what the plugin writes", async () => {
			for (const verification of [
				"not json",
				"[]",
				'{"referenceId":7}',
				"{}",
			]) {
				const { ctx } = context(
					{
						path: "/oauth2/token",
						body: {
							grant_type: "authorization_code",
							code: "code-1",
							resource: PROJECT,
						},
					},
					{ verification },
				);

				expect(
					await enforceOAuthResourceBinding(ctx, signedIn),
					verification,
				).toEqual(swapped);
			}
		});

		it("for any grant type that carries nothing to match against", async () => {
			const { ctx } = context({
				path: "/oauth2/token",
				body: { grant_type: "client_credentials", resource: PROJECT },
			});

			expect(await enforceOAuthResourceBinding(ctx, signedIn)).toEqual(
				swapped,
			);
		});

		it("when a refresh token lacks the prefix the server issues, without looking it up", async () => {
			const { ctx, findOne } = context({
				path: "/oauth2/token",
				body: {
					grant_type: "refresh_token",
					refresh_token: "no-prefix",
					resource: PROJECT,
				},
			});

			expect(await enforceOAuthResourceBinding(ctx, signedIn)).toEqual(
				swapped,
			);
			expect(findOne).not.toHaveBeenCalled();
		});

		it("when a refresh token is unknown", async () => {
			const { ctx } = context({
				path: "/oauth2/token",
				body: {
					grant_type: "refresh_token",
					refresh_token: "frt_unknown",
					resource: PROJECT,
				},
			});

			expect(await enforceOAuthResourceBinding(ctx, signedIn)).toEqual(
				swapped,
			);
		});

		it("keeps the rest of the body as it was", async () => {
			const { ctx } = context({
				path: "/oauth2/token",
				body: {
					grant_type: "refresh_token",
					refresh_token: "frt_unknown",
					client_id: "client-1",
					resource: PROJECT,
				},
			});

			expect(await enforceOAuthResourceBinding(ctx, signedIn)).toEqual({
				context: {
					body: {
						grant_type: "refresh_token",
						refresh_token: "frt_unknown",
						client_id: "client-1",
						resource: `${APP_URL}/api/mcp-gateway`,
					},
				},
			});
		});
	});

	it("reads a refresh token's reference by its digest", async () => {
		const { ctx, findOne } = context(
			{
				path: "/oauth2/token",
				body: {
					grant_type: "refresh_token",
					refresh_token: "frt_secret",
					resource: PROJECT,
				},
			},
			{ refresh: { referenceId: "project:mcp:project-example-one" } },
		);

		await enforceOAuthResourceBinding(ctx, signedIn);

		const [query] = findOne.mock.calls[0];
		expect(query.model).toBe("oauthRefreshToken");
		expect(query.where[0].field).toBe("token");
		expect(query.where[0].value).toMatch(/^[0-9a-f]{64}$/);
		expect(query.where[0].value).not.toContain("secret");
	});
});

describe("reading what a consent issued", () => {
	const REDIRECT = "http://127.0.0.1:49152/callback";

	function issued(
		referenceId: string | null,
		returned: unknown = {
			redirect: true,
			url: `${REDIRECT}?code=code-1&state=state-example`,
		},
	) {
		return context(
			{ path: "/oauth2/consent", returned },
			{
				verification:
					referenceId === null
						? null
						: JSON.stringify({ referenceId }),
			},
		);
	}

	it("reads an organization grant from the code's own reference", async () => {
		const { ctx, findVerificationValue } = issued("org-example-alpha");

		expect(await issuedGrantOfConsent(ctx, "user-1")).toEqual({
			organizationId: "org-example-alpha",
			projectId: null,
		});

		const [identifier] = findVerificationValue.mock.calls[0];
		expect(identifier).toMatch(/^[0-9a-f]{64}$/);
	});

	it("reads a project grant from the code's own reference, in the organization hosting the project", async () => {
		database.resolveOAuthProjectGrantTarget.mockResolvedValue({
			projectId: "project-example-one",
			organizationId: "org-example-alpha",
		});
		const { ctx } = issued("project:mcp:project-example-one");

		expect(await issuedGrantOfConsent(ctx, "user-1")).toEqual({
			organizationId: "org-example-alpha",
			projectId: "project-example-one",
		});
		expect(database.resolveOAuthProjectGrantTarget).toHaveBeenCalledWith(
			"user-1",
			"project-example-one",
		);
	});

	it("never rereads the binding the grant was decided from", async () => {
		database.findLiveOAuthAuthorizationResource.mockResolvedValue(null);
		database.resolveOAuthProjectGrantTarget.mockResolvedValue({
			projectId: "project-example-one",
			organizationId: "org-example-alpha",
		});
		const { ctx } = issued("project:mcp:project-example-one");

		const grant = await issuedGrantOfConsent(ctx, "user-1");

		expect(grant?.projectId).toBe("project-example-one");
		expect(
			database.findLiveOAuthAuthorizationResource,
		).not.toHaveBeenCalled();
	});

	it("still names the project when its organization can no longer be read", async () => {
		const { ctx } = issued("project:api:project-example-one");

		expect(await issuedGrantOfConsent(ctx, "user-1")).toEqual({
			organizationId: null,
			projectId: "project-example-one",
		});
	});

	it("reads a code in a relative redirect", async () => {
		const { ctx } = issued("org-example-alpha", {
			redirect: true,
			url: "/auth/oauth/consent?code=code-1",
		});

		expect(await issuedGrantOfConsent(ctx, "user-1")).toMatchObject({
			organizationId: "org-example-alpha",
		});
	});

	it.each([
		[
			"a response without a code",
			{ redirect: true, url: `${REDIRECT}?error=access_denied` },
		],
		["a response without a url", { redirect: true }],
		["an error", new Error("refused")],
		["nothing", null],
	])("reads nothing from %s", async (_label, returned) => {
		const { ctx, findVerificationValue } = issued(
			"org-example-alpha",
			returned,
		);

		expect(await issuedGrantOfConsent(ctx, "user-1")).toBeNull();
		expect(findVerificationValue).not.toHaveBeenCalled();
	});

	it("reads nothing from a code the server did not store, or one with a reference it cannot read", async () => {
		for (const referenceId of [
			null,
			"",
			"project:mcp:a/b",
			"project:web:x",
		]) {
			const { ctx } = issued(referenceId);

			expect(await issuedGrantOfConsent(ctx, "user-1")).toBeNull();
		}
	});
});
