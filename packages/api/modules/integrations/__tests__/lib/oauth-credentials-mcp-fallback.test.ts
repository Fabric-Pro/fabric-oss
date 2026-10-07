/**
 * `getOAuthCredentialsWithDb` falls back to the client a person's GitLab MCP
 * config holds when no app is configured. That client is used only where the
 * MCP connect flow bound it: a binding to the authorization server this
 * provider sends it to (gitlab.com), whose `credentialFingerprint` still
 * matches the stored id and secret, on the catalog's GitLab server, in the
 * caller's own tenant — or, unbound, a public client with no secret at all.
 * Anything else — an unbound row holding a secret, a client bound to another
 * instance, one a legacy writer changed, a custom server reusing the
 * `gitlab` key, a lookup with no user — falls through to the environment.
 */
import {
	buildMcpOAuthBinding,
	withCredentialFingerprint,
} from "@repo/database/prisma/queries/lib/mcp-oauth-binding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Where = {
	userId?: string;
	organizationId?: string | null;
	mcpServer?: { key?: string; isSystemProvided?: boolean };
};
type Row = Record<string, unknown> & {
	userId: string;
	organizationId: string | null;
	mcpServer: { key: string; isSystemProvided: boolean };
};

/** The rows the simulated `mCPConfig.findMany` filters like its WHERE. */
let rows: Row[] = [];
const findManyCalls: Array<{ where: Where }> = [];

vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: { findFirst: vi.fn(async () => null) },
		mCPConfig: {
			findMany: vi.fn(async (args: { where: Where }) => {
				findManyCalls.push(args);
				const { where } = args;
				return rows.filter(
					(row) =>
						(!("userId" in where) || row.userId === where.userId) &&
						(!("organizationId" in where) ||
							row.organizationId === where.organizationId) &&
						(where.mcpServer?.key === undefined ||
							row.mcpServer.key === where.mcpServer.key) &&
						(where.mcpServer?.isSystemProvided === undefined ||
							row.mcpServer.isSystemProvided ===
								where.mcpServer.isSystemProvided),
				);
			}),
		},
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => value.replace(/^enc:/, ""),
	encryptApiKey: (value: string) => `enc:${value}`,
}));

import {
	getOAuthCredentialsWithDb,
	getOAuthProvider,
} from "../../lib/oauth-providers";

const CLIENT = {
	oauthClientId: "dcr-client",
	encryptedOauthClientSecret: "enc:dcr-secret",
	encryptedRefreshToken: null,
};

function bindingAt(authorizationServerUrl: string) {
	return withCredentialFingerprint(
		buildMcpOAuthBinding({
			authorizationServerUrl,
			tokenEndpoint: `${authorizationServerUrl}/oauth/token`,
			source: "discovery",
		}),
		CLIENT,
	);
}

function gitlabRow(overrides: Record<string, unknown> = {}): Row {
	return {
		id: "cfg-gitlab",
		userId: "user-1",
		organizationId: "org-1",
		...CLIENT,
		oauthBinding: bindingAt("https://gitlab.com"),
		mcpServer: { key: "gitlab", isSystemProvided: true },
		...overrides,
	} as Row;
}

function gitlab() {
	const provider = getOAuthProvider("GITLAB");
	if (!provider) {
		throw new Error("GitLab provider missing");
	}
	return provider;
}

const NOTHING = { clientId: "", clientSecret: "" };

beforeEach(() => {
	rows = [];
	findManyCalls.length = 0;
	vi.stubEnv("GITLAB_CLIENT_ID", "");
	vi.stubEnv("GITLAB_CLIENT_SECRET", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("getOAuthCredentialsWithDb — the GitLab MCP config fallback", () => {
	it("uses a catalog client bound to gitlab.com whose credentials match their binding", async () => {
		rows = [gitlabRow()];

		await expect(
			getOAuthCredentialsWithDb(gitlab(), "user-1", "org-1"),
		).resolves.toEqual({
			clientId: "dcr-client",
			clientSecret: "dcr-secret",
		});
		// Exclusive tenant arm and the catalog server only.
		expect(findManyCalls[0]?.where).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			mcpServer: { key: "gitlab", isSystemProvided: true },
		});
	});

	it.each([
		["an unbound row holding a secret", { oauthBinding: null }],
		[
			"a bound public client bound to another GitLab instance",
			{
				encryptedOauthClientSecret: null,
				oauthBinding: withCredentialFingerprint(
					buildMcpOAuthBinding({
						authorizationServerUrl: "https://gitlab.example.com",
						tokenEndpoint: "https://gitlab.example.com/oauth/token",
						source: "discovery",
					}),
					{ ...CLIENT, encryptedOauthClientSecret: null },
				),
			},
		],
		[
			// A public client: only the bearer-only rule refuses it.
			"a bearer-only marker (public client)",
			{
				encryptedOauthClientSecret: null,
				oauthBinding: {
					mode: "bearer-only",
					importedAt: "2026-10-06T00:00:00.000Z",
				},
			},
		],
		[
			"an intact client bound to another GitLab instance",
			{ oauthBinding: bindingAt("https://gitlab.example.com") },
		],
		[
			"an intact client bound to gitlab.com at another token endpoint",
			{
				oauthBinding: withCredentialFingerprint(
					buildMcpOAuthBinding({
						authorizationServerUrl: "https://gitlab.com",
						tokenEndpoint: "https://gitlab.com/elsewhere/token",
						source: "discovery",
					}),
					CLIENT,
				),
			},
		],
		[
			"a client whose secret a legacy writer replaced",
			{ encryptedOauthClientSecret: "enc:secret-from-elsewhere" },
		],
		[
			"a client whose id a legacy writer replaced",
			{ oauthClientId: "client-from-elsewhere" },
		],
		[
			"a custom server reusing the gitlab key",
			{ mcpServer: { key: "gitlab", isSystemProvided: false } },
		],
	])("never uses %s", async (_label, overrides) => {
		rows = [gitlabRow(overrides)];

		await expect(
			getOAuthCredentialsWithDb(gitlab(), "user-1", "org-1"),
		).resolves.toEqual(NOTHING);
	});

	it("uses an UNBOUND public client (no secret): its id alone is nothing secret", async () => {
		rows = [
			gitlabRow({ oauthBinding: null, encryptedOauthClientSecret: null }),
		];

		await expect(
			getOAuthCredentialsWithDb(gitlab(), "user-1", "org-1"),
		).resolves.toEqual({ clientId: "dcr-client", clientSecret: undefined });
	});

	it("picks the person's usable row when an unusable one sorts first", async () => {
		rows = [
			gitlabRow({ id: "cfg-a", oauthBinding: null }),
			gitlabRow({ id: "cfg-b" }),
		];

		await expect(
			getOAuthCredentialsWithDb(gitlab(), "user-1", "org-1"),
		).resolves.toMatchObject({ clientId: "dcr-client" });
	});

	it("never matches another person's or another tenant's row", async () => {
		rows = [
			gitlabRow({ userId: "someone-else" }),
			gitlabRow({ organizationId: null }),
		];

		await expect(
			getOAuthCredentialsWithDb(gitlab(), "user-1", "org-1"),
		).resolves.toEqual(NOTHING);
	});

	it("does not look at all without a user: no unscoped lookup", async () => {
		rows = [gitlabRow()];

		await expect(
			getOAuthCredentialsWithDb(gitlab(), undefined, "org-1"),
		).resolves.toEqual(NOTHING);
		expect(findManyCalls).toHaveLength(0);
	});
});
