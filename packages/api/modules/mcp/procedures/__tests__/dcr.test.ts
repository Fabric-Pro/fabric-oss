/**
 * `mcp.dcr.register` / `mcp.dcr.unregister` replace a config's client
 * registration through the credential module.
 *
 * - register goes through the guarded outbound fetch (never a raw `fetch`),
 *   at the AS the connect flow would use, and binds the new client to it;
 *   the stored registration metadata is allowlisted;
 * - unregister removes the client and with it the tokens and binding.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serverAccess = vi.hoisted(() => ({
	accessible: true,
	calls: [] as unknown[][],
}));

const {
	getMcpConfigByIdInternalMock,
	replaceMcpOAuthRegistrationMock,
	safeFetchOutboundMock,
} = vi.hoisted(() => ({
	getMcpConfigByIdInternalMock: vi.fn(),
	replaceMcpOAuthRegistrationMock: vi.fn(),
	safeFetchOutboundMock: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	// The config's server is one its tenant may use, unless a test says
	// otherwise (`serverAccess.accessible = false`).
	getMcpServerForTenant: async (...args: unknown[]) => {
		serverAccess.calls.push(args);
		return serverAccess.accessible ? { isSystemProvided: true } : null;
	},
	...(await vi.importActual<Record<string, unknown>>(
		"@repo/database/prisma/queries/lib/mcp-oauth-binding",
	)),
	getMcpConfigByIdInternal: (...args: unknown[]) =>
		getMcpConfigByIdInternalMock(...args),
	getOrganizationById: vi.fn(),
	replaceMcpOAuthRegistration: (...args: unknown[]) =>
		replaceMcpOAuthRegistrationMock(...args),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (s: string) => `encrypted:${s}`,
}));
vi.mock("@repo/utils/url-security", () => ({
	assertSafeOutboundUrl: vi.fn(),
	safeFetchOutbound: (...args: unknown[]) => safeFetchOutboundMock(...args),
}));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));
vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		requirePermission: () => () => ({}),
		Permissions: { MCP_CREATE: "mcp:create", MCP_UPDATE: "mcp:update" },
	};
});
vi.mock("@orpc/server", () => ({
	ORPCError: class extends Error {
		readonly code: string;
		constructor(code: string, opts?: { message?: string }) {
			super(opts?.message ?? code);
			this.code = code;
		}
	},
}));

import { dcrProcedures } from "../dcr";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<Record<string, unknown>>;
const register = (dcrProcedures.register as unknown as { _handler: Handler })
	._handler;
const unregister = (
	dcrProcedures.unregister as unknown as { _handler: Handler }
)._handler;

const AS = "https://as.example.com";

function json(body: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
	} as unknown as Response;
}

function config(overrides: Record<string, unknown> = {}) {
	return {
		id: "cfg_1",
		userId: "user_1",
		organizationId: null,
		baseUrl: "https://mcp.example.com/mcp",
		scopes: [],
		oauthGrantGeneration: 3,
		// A registration endpoint left by an earlier flow is not trusted.
		dcrRegistrationEndpoint: "https://stale.example.com/register",
		mcpServer: {
			name: "Example",
			key: "custom",
			defaultUrl: "https://mcp.example.com/mcp",
			dcrRegistrationEndpoint: null,
		},
		...overrides,
	};
}

const globalFetch = vi.fn();
const context = { user: { id: "user_1" } };

beforeEach(() => {
	vi.clearAllMocks();
	serverAccess.accessible = true;
	serverAccess.calls.length = 0;
	vi.stubGlobal("fetch", globalFetch);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	replaceMcpOAuthRegistrationMock.mockResolvedValue({
		written: true,
		generation: 2,
	});
	safeFetchOutboundMock.mockImplementation(async (url: string) => {
		if (url.endsWith("/.well-known/oauth-protected-resource")) {
			return json({ authorization_servers: [AS] });
		}
		if (url.startsWith(`${AS}/.well-known/`)) {
			return json({
				issuer: AS,
				authorization_endpoint: `${AS}/authorize`,
				token_endpoint: `${AS}/token`,
				registration_endpoint: `${AS}/register`,
			});
		}
		if (url === `${AS}/register`) {
			return json(
				{
					client_id: "new-client",
					client_secret: "new-secret",
					token_endpoint_auth_method: "client_secret_post",
					registration_access_token: "rat-value",
					registration_client_uri: `${AS}/register/new-client`,
					issuer: "https://claimed.example.com",
				},
				201,
			);
		}
		return json({}, 404);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("mcp.dcr.register", () => {
	it("registers through the guarded fetch at the resolved AS and binds the client to it", async () => {
		getMcpConfigByIdInternalMock.mockResolvedValue(config());

		const result = await register({
			input: {
				configId: "cfg_1",
				redirectUri: "https://app.example.com/api/mcp/oauth/callback",
			},
			context,
		});

		expect(result).toMatchObject({
			success: true,
			oauthClientId: "new-client",
		});
		expect(globalFetch).not.toHaveBeenCalled();
		const registration = safeFetchOutboundMock.mock.calls.find(
			(call) => call[0] === `${AS}/register`,
		);
		expect(registration?.[1]).toMatchObject({
			method: "POST",
			redirect: "error",
		});
		expect(
			safeFetchOutboundMock.mock.calls.some((call) =>
				String(call[0]).includes("stale.example.com"),
			),
		).toBe(false);

		const write = replaceMcpOAuthRegistrationMock.mock.calls[0]?.[0];
		expect(write).toMatchObject({
			configId: "cfg_1",
			// Derived from the read: fenced on the generation it saw.
			expectedGeneration: 3,
			client: {
				oauthClientId: "new-client",
				encryptedOauthClientSecret: "encrypted:new-secret",
				dcrRegistrationEndpoint: `${AS}/register`,
				dcrClientMetadata: {
					token_endpoint_auth_method: "client_secret_post",
					// Set by Fabric from the AS it registered at.
					issuer: AS,
				},
			},
			binding: {
				authorizationServerUrl: AS,
				tokenEndpoint: `${AS}/token`,
			},
		});
		for (const dropped of [
			"registration_access_token",
			"registration_client_uri",
			"client_secret",
			"client_id",
		]) {
			expect(write.client.dcrClientMetadata).not.toHaveProperty(dropped);
		}
	});

	it("refuses a registration whose config changed since it was read", async () => {
		getMcpConfigByIdInternalMock.mockResolvedValue(config());
		replaceMcpOAuthRegistrationMock.mockResolvedValue({
			written: false,
			generation: null,
			config: null,
		});

		await expect(
			register({
				input: {
					configId: "cfg_1",
					redirectUri:
						"https://app.example.com/api/mcp/oauth/callback",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("never logs or returns a provider error code it does not recognise", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		getMcpConfigByIdInternalMock.mockResolvedValue(config());
		const base = safeFetchOutboundMock.getMockImplementation();
		safeFetchOutboundMock.mockImplementation(async (url: string) =>
			url === `${AS}/register`
				? json({ error: "rt_live_9f8e7d6c5b4a3f2e1d0c" }, 400)
				: base?.(url),
		);

		const result = await register({
			input: {
				configId: "cfg_1",
				redirectUri: "https://app.example.com/api/mcp/oauth/callback",
			},
			context,
		});

		expect(result.success).toBe(false);
		expect(JSON.stringify(result)).not.toContain(
			"rt_live_9f8e7d6c5b4a3f2e1d0c",
		);
		expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
			"rt_live_9f8e7d6c5b4a3f2e1d0c",
		);
		expect(JSON.stringify(errorSpy.mock.calls)).toContain(
			"unrecognized_error",
		);
	});

	it("refuses a config whose server its tenant may not use, contacting nothing", async () => {
		serverAccess.accessible = false;
		getMcpConfigByIdInternalMock.mockResolvedValue(config());

		await expect(
			register({
				input: {
					configId: "cfg_1",
					redirectUri:
						"https://app.example.com/api/mcp/oauth/callback",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(safeFetchOutboundMock).not.toHaveBeenCalled();
		expect(replaceMcpOAuthRegistrationMock).not.toHaveBeenCalled();
	});

	it("reports an AS without a registration endpoint and writes nothing", async () => {
		getMcpConfigByIdInternalMock.mockResolvedValue(config());
		safeFetchOutboundMock.mockResolvedValue(json({}, 404));

		const result = await register({
			input: {
				configId: "cfg_1",
				redirectUri: "https://app.example.com/api/mcp/oauth/callback",
			},
			context,
		});

		expect(result.success).toBe(false);
		expect(replaceMcpOAuthRegistrationMock).not.toHaveBeenCalled();
	});
});

describe("mcp.dcr.unregister", () => {
	it("removes the client together with its tokens and binding", async () => {
		getMcpConfigByIdInternalMock.mockResolvedValue(config());

		await unregister({ input: { configId: "cfg_1" }, context });

		expect(replaceMcpOAuthRegistrationMock).toHaveBeenCalledWith({
			configId: "cfg_1",
			expectedGeneration: 3,
			client: null,
			binding: null,
		});
	});

	it("refuses when the config's credentials changed since it was read", async () => {
		getMcpConfigByIdInternalMock.mockResolvedValue(config());
		replaceMcpOAuthRegistrationMock.mockResolvedValue({
			written: false,
			generation: null,
			config: null,
		});

		await expect(
			unregister({ input: { configId: "cfg_1" }, context }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});
