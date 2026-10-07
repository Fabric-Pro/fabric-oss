/**
 * The external agents API asks two questions of a key, not one.
 *
 * The scope check has always been there: it asks what the key was granted when
 * it was minted. `verifyOrganizationApiKey` added the second half of the tenant
 * question — whether the owner is still a member — but nothing asked what their
 * role had become. So a key minted by a member kept executing agents after its
 * owner was demoted to a read-only role that may list them and not run them
 * (Fizzy #2380, QA round two).
 *
 * These pin the role gate, and just as importantly pin where it does NOT apply:
 * on the reads, whose permissions every role holds, and on a personal key,
 * which names no organization to hold a role in.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findProject: vi.fn(),
	verifyOrganizationApiKey: vi.fn(),
	verifyUserApiKey: vi.fn(),
	verifyOAuthAccessToken: vi.fn(),
	canExecuteOrganizationAgents: vi.fn(),
	canRunOrganizationWorkflows: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: { project: { findUnique: mocks.findProject } },
		verifyOrganizationApiKey: mocks.verifyOrganizationApiKey,
		verifyOAuthAccessToken: mocks.verifyOAuthAccessToken,
		canExecuteOrganizationAgents: mocks.canExecuteOrganizationAgents,
		canRunOrganizationWorkflows: mocks.canRunOrganizationWorkflows,
	};
});

vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://app.example.com" }));

vi.mock("../../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: mocks.verifyUserApiKey,
}));

import type { ExternalApiVariables } from "../../types";
import { requireApiKey, requireScope } from "../api-key-auth";

const ORG_KEY = "org_aaaaaaaa_secret";
const PERSONAL_KEY = "fab_bbbbbbbb_secret";

function appRequiring(scope: string) {
	const app = new Hono<{ Variables: ExternalApiVariables }>();
	app.use("*", requireApiKey());
	app.get("/thing", requireScope(scope), (c) => c.json({ ok: true }));
	return app;
}

function call(app: Hono<{ Variables: ExternalApiVariables }>, key: string) {
	return app.request("/thing", {
		headers: { Authorization: `Bearer ${key}` },
	});
}

function orgKeyWith(scopes: string[]) {
	return {
		id: "key-1",
		organizationId: "org-123",
		createdByUserId: "user-demoted",
		scopes,
	};
}

beforeEach(() => {
	mocks.verifyOrganizationApiKey.mockReset();
	mocks.verifyUserApiKey.mockReset();
	mocks.verifyOAuthAccessToken.mockReset();
	mocks.canExecuteOrganizationAgents.mockReset().mockResolvedValue(true);
	mocks.canRunOrganizationWorkflows.mockReset().mockResolvedValue(true);
});

describe("agents:execute — the owner's current role", () => {
	it("refuses when the owner may no longer execute agents", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			orgKeyWith(["agents:execute"]),
		);
		mocks.canExecuteOrganizationAgents.mockResolvedValue(false);

		const res = await call(appRequiring("agents:execute"), ORG_KEY);

		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error).toContain("no longer holds");
	});

	it("asks about the key's creator in the key's organization", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			orgKeyWith(["agents:execute"]),
		);

		await call(appRequiring("agents:execute"), ORG_KEY);

		expect(mocks.canExecuteOrganizationAgents).toHaveBeenCalledWith(
			"user-demoted",
			"org-123",
		);
	});

	it("refuses a WILDCARD key too", async () => {
		// `hasScope` answers true for `*`. A permission check written inside
		// the concrete-scope branch would never run for the widest keys — the
		// exact shape of the bug this gate exists to close.
		mocks.verifyOrganizationApiKey.mockResolvedValue(orgKeyWith(["*"]));
		mocks.canExecuteOrganizationAgents.mockResolvedValue(false);

		const res = await call(appRequiring("agents:execute"), ORG_KEY);

		expect(res.status).toBe(403);
	});

	it("serves a key whose owner kept the role", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			orgKeyWith(["agents:execute"]),
		);

		const res = await call(appRequiring("agents:execute"), ORG_KEY);

		expect(res.status).toBe(200);
	});

	it("keeps the missing-scope refusal distinct from the lost-role one", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			orgKeyWith(["agents:read"]),
		);

		const res = await call(appRequiring("agents:execute"), ORG_KEY);

		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error).toContain("Missing required scope");
		expect(mocks.canExecuteOrganizationAgents).not.toHaveBeenCalled();
	});
});

describe("workflows:run — the owner's current role", () => {
	// The in-app start requires WORKSPACE_UPDATE, which the viewer role does
	// not hold. Without this gate a key minted by a member kept triggering
	// workflows — runs that execute externally mutating nodes — after its
	// owner was demoted.
	it("refuses when the owner may no longer run workflows", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			orgKeyWith(["workflows:run"]),
		);
		mocks.canRunOrganizationWorkflows.mockResolvedValue(false);

		const res = await call(appRequiring("workflows:run"), ORG_KEY);

		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error).toContain("no longer holds");
	});

	it("asks about the key's creator in the key's organization", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			orgKeyWith(["workflows:run"]),
		);

		await call(appRequiring("workflows:run"), ORG_KEY);

		expect(mocks.canRunOrganizationWorkflows).toHaveBeenCalledWith(
			"user-demoted",
			"org-123",
		);
	});

	it("refuses a WILDCARD key too", async () => {
		// A legacy `*` key minted before the demotion is the widest credential
		// there is; the gate has to run for it, not only for the exact scope.
		mocks.verifyOrganizationApiKey.mockResolvedValue(orgKeyWith(["*"]));
		mocks.canRunOrganizationWorkflows.mockResolvedValue(false);

		const res = await call(appRequiring("workflows:run"), ORG_KEY);

		expect(res.status).toBe(403);
	});

	it("serves a key whose owner kept the role", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			orgKeyWith(["workflows:run"]),
		);

		const res = await call(appRequiring("workflows:run"), ORG_KEY);

		expect(res.status).toBe(200);
	});

	it("keeps the missing-scope refusal distinct from the lost-role one", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			orgKeyWith(["workflows:read"]),
		);

		const res = await call(appRequiring("workflows:run"), ORG_KEY);

		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error).toContain("Missing required scope");
		expect(mocks.canRunOrganizationWorkflows).not.toHaveBeenCalled();
	});
});

describe("where the role gate deliberately does not reach", () => {
	it("does not gate agents:read — every role may list agents", async () => {
		// Not an oversight. `AGENT_READ` sits in the viewer set, so a gate here
		// could refuse nobody, and the org-wide reach of the read is not an
		// escalation: the in-app agents list filters on the organization alone,
		// so a key sees exactly what its owner sees in the browser.
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			orgKeyWith(["agents:read"]),
		);
		mocks.canExecuteOrganizationAgents.mockResolvedValue(false);

		const res = await call(appRequiring("agents:read"), ORG_KEY);

		expect(res.status).toBe(200);
		expect(mocks.canExecuteOrganizationAgents).not.toHaveBeenCalled();
	});

	it("leaves a personal key alone — it names no organization", async () => {
		mocks.verifyUserApiKey.mockResolvedValue({
			valid: true,
			keyId: "key-2",
			userId: "user-99",
			scopes: ["agents:execute"],
		});

		const res = await call(appRequiring("agents:execute"), PERSONAL_KEY);

		expect(res.status).toBe(200);
		expect(mocks.canExecuteOrganizationAgents).not.toHaveBeenCalled();
	});
});

describe("a signed-in agent's access token", () => {
	const ACCESS_TOKEN = "fat_example-access-token";

	function validToken(scopes: string[]) {
		return {
			valid: true,
			tokenId: "token-row-1",
			clientRowId: "client-row-1",
			clientName: "Example Agent",
			userId: "user-signed-in",
			userName: "Dev",
			email: "dev@example.com",
			role: "user",
			organizationId: "org-bound-at-consent",
			projectId: null,
			audience: null,
			scopes,
		};
	}

	function validProjectToken(scopes: string[], audience: "mcp" | "api") {
		return {
			...validToken(scopes),
			projectId: "project-example-one",
			audience,
		};
	}

	function appEchoingContext() {
		const app = new Hono<{ Variables: ExternalApiVariables }>();
		app.use("*", requireApiKey());
		app.get("*", requireScope("instructions:read"), (c) =>
			c.json(c.get("externalApiContext")),
		);
		return app;
	}

	function callAt(
		app: Hono<{ Variables: ExternalApiVariables }>,
		path: string,
	) {
		return app.request(path, {
			headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
		});
	}

	it("is bound to the organization chosen at consent and names the agent, not the token", async () => {
		mocks.verifyOAuthAccessToken.mockResolvedValue(
			validToken(["mcp:read", "instructions:read"]),
		);

		const res = await call(appEchoingContext(), ACCESS_TOKEN);

		expect(res.status).toBe(200);
		expect(mocks.verifyOAuthAccessToken).toHaveBeenCalledWith(
			ACCESS_TOKEN,
			{ appUrl: "https://app.example.com", audience: "api" },
		);
		expect(await res.json()).toEqual({
			keyType: "oauth",
			keyId: "client-row-1",
			keyPrefix: "fat_client-r",
			userId: "user-signed-in",
			organizationId: "org-bound-at-consent",
			scopes: ["mcp:read", "instructions:read"],
		});
		expect(mocks.verifyOrganizationApiKey).not.toHaveBeenCalled();
		expect(mocks.verifyUserApiKey).not.toHaveBeenCalled();
	});

	it("uses the configured API resource rather than a caller's Host", async () => {
		mocks.verifyOAuthAccessToken.mockResolvedValue({
			valid: false,
			reason: "unknown",
		});
		const res = await appEchoingContext().request(
			"https://other.example.com/api/v1/projects",
			{
				headers: {
					Authorization: `Bearer ${ACCESS_TOKEN}`,
					Host: "other.example.com",
				},
			},
		);
		expect(res.status).toBe(401);
		expect(mocks.verifyOAuthAccessToken).toHaveBeenCalledWith(
			ACCESS_TOKEN,
			{ appUrl: "https://app.example.com", audience: "api" },
		);
	});

	it("names no project for an organization-wide token", async () => {
		mocks.verifyOAuthAccessToken.mockResolvedValue(
			validToken(["instructions:read"]),
		);

		const res = await call(appEchoingContext(), ACCESS_TOKEN);

		expect(await res.json()).not.toHaveProperty("boundProjectId");
	});

	it("carries the one project an API token reaches, in the organization hosting it", async () => {
		mocks.verifyOAuthAccessToken.mockResolvedValue(
			validProjectToken(["instructions:read"], "api"),
		);

		const res = await callAt(
			appEchoingContext(),
			"/api/v1/projects/project-example-one/instructions/changes",
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			keyType: "oauth",
			organizationId: "org-bound-at-consent",
			boundProjectId: "project-example-one",
		});
	});

	it("refuses a token issued for a project's MCP gateway, whatever it is asked for", async () => {
		mocks.verifyOAuthAccessToken.mockResolvedValue(
			validProjectToken(["instructions:read"], "mcp"),
		);

		const res = await call(appEchoingContext(), ACCESS_TOKEN);

		expect(res.status).toBe(401);
		expect((await res.json()).error).toContain("MCP gateway");
	});

	it("answers a dead token like any other bad credential", async () => {
		// Expired, revoked, departed member, disabled client: the verifier
		// settles all of them and the caller sees one 401.
		mocks.verifyOAuthAccessToken.mockResolvedValue({
			valid: false,
			reason: "not_a_member",
		});

		const res = await call(appEchoingContext(), ACCESS_TOKEN);

		expect(res.status).toBe(401);
	});

	it("refuses a scope the agent was not granted", async () => {
		mocks.verifyOAuthAccessToken.mockResolvedValue(
			validToken(["mcp:read"]),
		);

		const res = await call(appEchoingContext(), ACCESS_TOKEN);

		expect(res.status).toBe(403);
		expect((await res.json()).error).toBe(
			"Missing required scope: instructions:read",
		);
	});

	it("still asks about the owner's role for a gated scope", async () => {
		mocks.verifyOAuthAccessToken.mockResolvedValue(
			validToken(["agents:execute"]),
		);
		mocks.canExecuteOrganizationAgents.mockResolvedValue(false);

		const res = await call(appRequiring("agents:execute"), ACCESS_TOKEN);

		expect(res.status).toBe(403);
		expect(mocks.canExecuteOrganizationAgents).toHaveBeenCalledWith(
			"user-signed-in",
			"org-bound-at-consent",
		);
	});

	describe("bound to one project, reaches only what the project owns", () => {
		const REFUSAL = {
			error: {
				message: "This sign-in is limited to project Example Project",
			},
		};

		beforeEach(() => {
			mocks.findProject.mockReset().mockResolvedValue({
				name: "Example Project",
			});
			mocks.verifyOAuthAccessToken.mockResolvedValue(
				validProjectToken(["instructions:read"], "api"),
			);
		});

		it.each([
			"/api/v1/auth/whoami",
			"/api/v1/instructions/checkouts/resolve",
			"/api/v1/projects/project-example-one/instructions/changes",
			"/api/v1/projects/project-example-one/contexts/synced-files",
			"/api/v1/projects/project-example-one/features",
		])("reaches %s", async (path) => {
			const res = await callAt(appEchoingContext(), path);

			expect(res.status).toBe(200);
		});

		it.each([
			"/api/v1/orgs",
			"/api/v1/projects",
			"/api/v1/projects/project-example-one",
			"/api/v1/projects/project-example-two/features",
			"/api/v1/projects/project-example-one-2/features",
			"/api/v1/projects/project-example-on/features",
			"/api/v1/projectsproject-example-one/features",
			"/api/v1//projects/project-example-one/features",
			"/api/v1/documents",
			"/api/v1/auth/keys",
			"/api/v1/auth/whoami/",
			"/api/v1/auth/whoami/extra",
			"/api/v1/instructions/checkouts/resolve/extra",
			"/api/v1/instructions/checkouts",
			"/api/v1/mcp/servers",
			"/api/v1/user/mcp-config",
			"/api/v1/workflows",
			"/api/external/agents",
			"/api/v1",
			"/thing",
		])(
			"refuses %s, with one answer, without running the route",
			async (path) => {
				const handler = vi.fn((c) => c.json({ reached: true }));
				const app = new Hono<{ Variables: ExternalApiVariables }>();
				app.use("*", requireApiKey());
				app.all("*", handler);

				const res = await callAt(app, path);

				expect(res.status).toBe(403);
				expect(await res.json()).toEqual(REFUSAL);
				expect(handler).not.toHaveBeenCalled();
			},
		);

		it("refuses before it asks for a scope or about the owner's role", async () => {
			mocks.verifyOAuthAccessToken.mockResolvedValue(
				validProjectToken(["mcp:read"], "api"),
			);
			const app = new Hono<{ Variables: ExternalApiVariables }>();
			app.use("*", requireApiKey("agents:execute"));
			app.get("*", (c) => c.json({ reached: true }));

			const res = await callAt(app, "/api/v1/agents");

			expect(res.status).toBe(403);
			expect(await res.json()).toEqual(REFUSAL);
			expect(mocks.canExecuteOrganizationAgents).not.toHaveBeenCalled();
		});

		it("names the project by its id when it cannot be read", async () => {
			mocks.findProject.mockResolvedValue(null);

			const res = await callAt(appEchoingContext(), "/api/v1/orgs");

			expect(await res.json()).toEqual({
				error: {
					message:
						"This sign-in is limited to project project-example-one",
				},
			});
		});

		it("leaves an organization-wide token alone, on any path", async () => {
			mocks.verifyOAuthAccessToken.mockResolvedValue(
				validToken(["instructions:read"]),
			);

			for (const path of ["/api/v1/orgs", "/api/v1/projects", "/thing"]) {
				const res = await callAt(appEchoingContext(), path);

				expect(res.status, path).toBe(200);
			}
			expect(mocks.findProject).not.toHaveBeenCalled();
		});
	});
});
