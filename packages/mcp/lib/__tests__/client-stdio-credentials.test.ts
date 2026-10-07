/**
 * The Google Drive STDIO server refreshes on its own with the client secret
 * and refresh token the wrapper is handed, so `createMcpClientForConfig`
 * hands them over only for a grant bound to an authorization server and
 * still the credential set that binding was written with
 * (`credentialFingerprint`). A set replaced by a writer outside the
 * credential module sends nothing and flags the config for reconnect; an
 * unbound or bearer-only grant gets the access token alone.
 */
import {
	buildMcpOAuthBinding,
	credentialFingerprintMatches,
	parseMcpOAuthBinding,
	withCredentialFingerprint,
} from "@repo/database/prisma/queries/lib/mcp-oauth-binding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetMcpConfigById = vi.fn();
const mockMarkReconnectRequired = vi.fn();

vi.mock("@repo/database", async () => {
	const binding = await import(
		"@repo/database/prisma/queries/lib/mcp-oauth-binding"
	);
	return {
		isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
			key === "gitlab" || key === "gitlab-official",
		getMcpConfigById: (...args: unknown[]) => mockGetMcpConfigById(...args),
		getValidAccessToken: vi.fn(),
		getMcpOAuthGrantGeneration: vi.fn(),
		markMcpOAuthReconnectRequired: (...args: unknown[]) =>
			mockMarkReconnectRequired(...args),
		parseMcpOAuthBinding: binding.parseMcpOAuthBinding,
		credentialFingerprintMatches: binding.credentialFingerprintMatches,
		sameAuthorizationServer: binding.sameAuthorizationServer,
		canConnectOrganizationMcpConfigs: async () => true,
		canReadOrganizationMcpConfigs: async () => true,
		isOrganizationMember: async () => true,
	};
});

vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => value.replace(/^ENC:/, ""),
	encryptApiKey: (value: string) => `ENC:${value}`,
	hashApiKey: (value: string) => `HASH:${value}`,
}));

import { createMcpClientForConfig } from "../client";

const CREDENTIALS = {
	oauthClientId: "gdrive-client",
	encryptedOauthClientSecret: "ENC:gdrive-secret",
	encryptedRefreshToken: "ENC:gdrive-refresh",
};

const GOOGLE_BINDING = withCredentialFingerprint(
	buildMcpOAuthBinding({
		authorizationServerUrl: "https://accounts.google.com",
		tokenEndpoint: "https://oauth2.googleapis.com/token",
		source: "backfill",
	}),
	CREDENTIALS,
);

function gdriveConfig(overrides: Record<string, unknown> = {}) {
	return {
		id: "config_gd",
		enabled: true,
		needsReauth: false,
		displayName: "Google Drive",
		transport: "STDIO",
		authType: "OAUTH2",
		...CREDENTIALS,
		encryptedAccessToken: "ENC:gdrive-access",
		tokenExpiresAt: new Date(Date.now() + 3_600_000),
		oauthBinding: GOOGLE_BINDING,
		oauthGrantGeneration: 4,
		mcpServer: {
			name: "Google Drive",
			transport: "STDIO",
			command: "npx -y @modelcontextprotocol/server-gdrive",
		},
		...overrides,
	};
}

let wrapperBodies: Array<{ credentials: Record<string, string> }> = [];

beforeEach(() => {
	mockGetMcpConfigById.mockReset();
	mockMarkReconnectRequired.mockReset();
	wrapperBodies = [];
	vi.stubEnv("MCP_STDIO_WRAPPER_URL", "http://localhost:3100");
	vi.spyOn(global, "fetch").mockImplementation(async (_input, init) => {
		wrapperBodies.push(JSON.parse(String(init?.body)));
		return new Response(JSON.stringify({ result: { tools: [] } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function handedCredentials() {
	const { client } = await createMcpClientForConfig({
		configId: "config_gd",
		userId: "user_a",
		organizationId: "org_a",
	});
	await (client as unknown as { tools(): Promise<unknown> })
		.tools()
		.catch(() => {});
	const credentials = wrapperBodies[0]?.credentials ?? {};
	return {
		keys: JSON.parse(credentials.__GDRIVE_OAUTH_KEYS_JSON ?? "{}"),
		tokens: JSON.parse(credentials.__GDRIVE_CREDENTIALS_JSON ?? "{}"),
	};
}

describe("Google Drive STDIO credentials", () => {
	it("hands over the client secret and refresh token of an intact bound grant", async () => {
		mockGetMcpConfigById.mockResolvedValue(gdriveConfig());

		const { keys, tokens } = await handedCredentials();

		expect(keys.web).toMatchObject({
			client_id: "gdrive-client",
			client_secret: "gdrive-secret",
		});
		expect(tokens).toMatchObject({
			access_token: "gdrive-access",
			refresh_token: "gdrive-refresh",
		});
	});

	it.each([
		["the client id", { oauthClientId: "client-from-another-as" }],
		[
			"the client secret",
			{ encryptedOauthClientSecret: "ENC:secret-from-another-as" },
		],
		[
			"the refresh token",
			{ encryptedRefreshToken: "ENC:refresh-from-another-as" },
		],
	])(
		"sends nothing after a legacy write of %s, and flags the config for reconnect",
		async (_label, legacyWrite) => {
			const row = gdriveConfig(legacyWrite);
			// The fixture really is a mismatch.
			const binding = parseMcpOAuthBinding(row.oauthBinding);
			expect(binding && credentialFingerprintMatches(binding, row)).toBe(
				false,
			);
			mockGetMcpConfigById.mockResolvedValue(row);

			await expect(
				createMcpClientForConfig({
					configId: "config_gd",
					userId: "user_a",
					organizationId: "org_a",
				}),
			).rejects.toMatchObject({ code: "OAUTH_AUTH_REQUIRED" });
			expect(fetch).not.toHaveBeenCalled();
			expect(mockMarkReconnectRequired).toHaveBeenCalledWith(
				expect.objectContaining({
					configId: "config_gd",
					expectedGeneration: 4,
				}),
			);
		},
	);

	it.each([
		[
			"an intact grant bound to another authorization server",
			withCredentialFingerprint(
				buildMcpOAuthBinding({
					authorizationServerUrl: "https://as.example.com",
					tokenEndpoint: "https://as.example.com/token",
					source: "discovery",
				}),
				CREDENTIALS,
			),
		],
		[
			"an intact grant bound to Google's AS at another token endpoint",
			withCredentialFingerprint(
				buildMcpOAuthBinding({
					authorizationServerUrl: "https://accounts.google.com",
					tokenEndpoint: "https://as.example.com/token",
					source: "discovery",
				}),
				CREDENTIALS,
			),
		],
		["an unbound grant", null],
		[
			"a bearer-only import",
			{ mode: "bearer-only", importedAt: "2026-10-06T00:00:00.000Z" },
		],
	])("hands %s the access token alone", async (_label, oauthBinding) => {
		mockGetMcpConfigById.mockResolvedValue(gdriveConfig({ oauthBinding }));

		const { keys, tokens } = await handedCredentials();

		expect(keys.web.client_secret).toBe("");
		expect(tokens.access_token).toBe("gdrive-access");
		expect(tokens.refresh_token).toBe("");
		expect(JSON.stringify(wrapperBodies)).not.toContain("gdrive-secret");
		expect(JSON.stringify(wrapperBodies)).not.toContain("gdrive-refresh");
	});
});
