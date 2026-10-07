/** Actual provider issuance and Fabric's bearer verifier must agree on resources. */
import {
	buildProjectResource,
	OAUTH_DISPLAYED_BINDING_FIELD,
} from "@repo/utils/oauth-project-resource";
import { betterAuth } from "better-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyOAuthAccessToken } from "../../../database/prisma/queries/oauth-access-token";
import { createOAuthProviderPlugin } from "../oauth-provider";
import { OAUTH_SCOPES, oauthValidAudiences } from "../oauth-scopes";
import {
	ORGANIZATION_ID,
	oauthFixtures,
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

let active: Harness;
vi.mock("../../../database/prisma/client", () => ({
	db: {
		oauthAccessToken: {
			findUnique: async ({ where }: { where: { token: string } }) => {
				const token = (await rowsOf(active, "oauthAccessToken")).find(
					(row) => row.token === where.token,
				);
				if (!token) {
					return null;
				}
				const client = (await rowsOf(active, "oauthClient")).find(
					(row) => row.clientId === token.clientId,
				);
				const user = (await rowsOf(active, "user")).find(
					(row) => row.id === token.userId,
				);
				return {
					...token,
					confirmation: token.confirmation ?? null,
					client,
					user,
				};
			},
		},
		member: {
			findFirst: async ({
				where,
			}: {
				where: { organizationId: string };
			}) =>
				where.organizationId === ORGANIZATION_ID
					? { id: "member-example" }
					: null,
		},
	},
}));
vi.mock("../../../database/prisma/queries/oauth-project-grant", () => ({
	resolveOAuthProjectGrantTarget: async (
		_userId: string,
		projectId: string,
	) =>
		oauthFixtures.readableProjects.has(projectId)
			? { organizationId: ORGANIZATION_ID, projectId }
			: null,
}));

const API = `${APP_URL}/api/v1`;
const MCP = `${APP_URL}/api/mcp-gateway`;

beforeEach(() => resetOAuthFixtures());

async function start(
	resource: string | string[] | null,
	method: "GET" | "POST" = "GET",
) {
	active = await boot();
	const { body: client } = await register(active.call);
	const path = await authorizeUrl(client.client_id, { resource });
	const authorization =
		method === "GET"
			? await active.call(path, {
					redirect: "manual",
					headers: { accept: "text/html" },
				})
			: await active.call("/oauth2/authorize", {
					method: "POST",
					redirect: "manual",
					headers: {
						accept: "text/html",
						"content-type": "application/x-www-form-urlencoded",
					},
					body: path.split("?")[1],
				});
	const query = (authorization.headers.get("location") ?? "").split("?")[1];
	const signed = new URLSearchParams(query);
	const displayed =
		typeof resource === "string" && resource.includes("/projects/")
			? { projectId: "project-example-one", audience: "api" }
			: null;
	const consent = await active.call("/oauth2/consent", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			accept: true,
			oauth_query: query,
			[OAUTH_DISPLAYED_BINDING_FIELD]: displayed,
		}),
	});
	expect(consent.status).toBe(200);
	const { url } = await consent.json();
	return {
		clientId: client.client_id,
		code: new URL(url).searchParams.get("code") as string,
		signed,
	};
}

async function exchange(
	flow: Awaited<ReturnType<typeof start>>,
	resource?: string,
) {
	const form = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: flow.clientId,
		code: flow.code,
		redirect_uri: REDIRECT_URI,
		code_verifier: VERIFIER,
	});
	if (resource !== undefined) {
		form.set("resource", resource);
	}
	const response = await active.call("/oauth2/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: form.toString(),
	});
	expect(response.status).toBe(200);
	return response.json();
}

async function refresh(
	clientId: string,
	refreshToken: string,
	resource?: string,
) {
	const form = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: clientId,
		refresh_token: refreshToken,
	});
	if (resource !== undefined) {
		form.set("resource", resource);
	}
	return active.call("/oauth2/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: form.toString(),
	});
}

async function verify(token: string, audience: "api" | "mcp") {
	return verifyOAuthAccessToken(token, { appUrl: APP_URL, audience });
}

describe("opaque token resource boundaries", () => {
	it.each([
		[API, "api", "mcp"],
		[MCP, "mcp", "api"],
		[`${MCP}/`, "mcp", "api"],
	] as const)(
		"honors an explicit organization resource %s",
		async (resource, permitted, refused) => {
			const flow = await start(resource);
			const tokens = await exchange(flow);
			expect(
				(await rowsOf(active, "oauthAccessToken"))[0].resources,
			).toEqual([resource]);
			expect((await verify(tokens.access_token, permitted)).valid).toBe(
				true,
			);
			expect(await verify(tokens.access_token, refused)).toMatchObject({
				valid: false,
				reason: "unknown",
			});
		},
	);

	it.each(["GET", "POST"] as const)(
		"puts omitted %s authorization resources into the signed grant and preserves them on refresh",
		async (method) => {
			const flow = await start(null, method);
			expect(flow.signed.getAll("resource")).toEqual(
				oauthValidAudiences(APP_URL),
			);
			expect((await rowsOf(active, "oauthConsent"))[0].resources).toEqual(
				oauthValidAudiences(APP_URL),
			);
			const tokens = await exchange(flow);
			expect((await verify(tokens.access_token, "api")).valid).toBe(true);
			expect((await verify(tokens.access_token, "mcp")).valid).toBe(true);
			const refreshed = await refresh(
				flow.clientId,
				tokens.refresh_token,
			);
			expect(refreshed.status).toBe(200);
			const next = await refreshed.json();
			expect((await verify(next.access_token, "api")).valid).toBe(true);
			expect((await verify(next.access_token, "mcp")).valid).toBe(true);
			const narrowed = await refresh(
				flow.clientId,
				next.refresh_token,
				API,
			);
			expect(narrowed.status).toBe(200);
			const narrowToken = await narrowed.json();
			expect((await verify(narrowToken.access_token, "api")).valid).toBe(
				true,
			);
			expect((await verify(narrowToken.access_token, "mcp")).valid).toBe(
				false,
			);
		},
	);

	it.each([API, MCP])(
		"allows an omitted-resource authorization to exchange for %s",
		async (resource) => {
			const flow = await start(null);
			expect(flow.signed.getAll("resource")).toEqual(
				oauthValidAudiences(APP_URL),
			);
			const tokens = await exchange(flow, resource);
			expect(
				(await rowsOf(active, "oauthAccessToken"))[0].resources,
			).toEqual([resource]);
			expect(
				(await rowsOf(active, "oauthRefreshToken"))[0].resources,
			).toEqual(oauthValidAudiences(APP_URL));
			expect(
				(
					await verify(
						tokens.access_token,
						resource === API ? "api" : "mcp",
					)
				).valid,
			).toBe(true);
		},
	);

	it("does not widen a project grant on omitted exchange or on refresh", async () => {
		oauthFixtures.readableProjects.add("project-example-one");
		const flow = await start(
			buildProjectResource(APP_URL, "api", "project-example-one"),
		);
		expect(flow.signed.getAll("resource")).toEqual([API]);
		const tokens = await exchange(flow);
		expect(tokens.scope.split(" ")).toContain("repositories:read");
		expect(await verify(tokens.access_token, "api")).toMatchObject({
			valid: true,
			projectId: "project-example-one",
			audience: "api",
			scopes: expect.arrayContaining(["repositories:read"]),
		});
		expect((await verify(tokens.access_token, "mcp")).valid).toBe(false);
		const before = await rowsOf(active, "oauthRefreshToken");
		const denied = await refresh(flow.clientId, tokens.refresh_token, MCP);
		expect(denied.status).toBe(400);
		expect(await denied.json()).toMatchObject({ error: "invalid_target" });
		expect(await rowsOf(active, "oauthRefreshToken")).toEqual(before);
		const inherited = await refresh(flow.clientId, tokens.refresh_token);
		expect(inherited.status).toBe(200);
		const refreshed = await inherited.json();
		expect(refreshed.scope.split(" ")).toContain("repositories:read");
		expect(await verify(refreshed.access_token, "api")).toMatchObject({
			valid: true,
			projectId: "project-example-one",
			scopes: expect.arrayContaining(["repositories:read"]),
		});
		expect((await verify(refreshed.access_token, "mcp")).valid).toBe(false);
		expect(
			(await rowsOf(active, "oauthAccessToken")).every(
				(row) =>
					JSON.stringify(row.resources) === JSON.stringify([API]),
			),
		).toBe(true);
	});

	it("allows canonical resources in DCR without changing its scope ceiling", async () => {
		active = await boot();
		const response = await active.call("/oauth2/register", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "Example Agent",
				redirect_uris: [REDIRECT_URI],
				application_type: "native",
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				resources: [API],
				scope: "instructions:read",
			}),
		});
		expect(response.status).toBe(201);
		const scopes = (await rowsOf(active, "oauthClient"))[0].scopes;
		expect(scopes).toEqual(expect.arrayContaining([...OAUTH_SCOPES]));
		expect(scopes).toHaveLength(OAUTH_SCOPES.length);
		expect(await rowsOf(active, "oauthClientResource")).toEqual([
			expect.objectContaining({ resourceId: API }),
		]);
	});
	it("preserves an existing restricted resource policy on provider initialization", async () => {
		active = await boot();
		await active.instance.db.update({
			model: "oauthResource",
			where: [{ field: "identifier", value: API }],
			update: { allowedScopes: ["instructions:read"] },
		});
		const before = await rowsOf(active, "oauthResource");
		expect(before).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					identifier: API,
					allowedScopes: ["instructions:read"],
				}),
			]),
		);
		const restarted = betterAuth({
			...active.auth.options,
			database: () => active.instance.db,
			plugins: [createOAuthProviderPlugin(APP_URL)],
		});
		await restarted.$context;
		expect(await rowsOf(active, "oauthResource")).toEqual(before);
	});

	it("refuses unconfigured DCR resources without creating a client", async () => {
		active = await boot();
		const response = await active.call("/oauth2/register", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "Example Agent",
				redirect_uris: [REDIRECT_URI],
				application_type: "native",
				token_endpoint_auth_method: "none",
				resources: [API, "https://other.example.com/api/v1"],
			}),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: "invalid_target",
		});
		expect(await rowsOf(active, "oauthClient")).toHaveLength(0);
		expect(await rowsOf(active, "oauthClientResource")).toHaveLength(0);
	});
});
