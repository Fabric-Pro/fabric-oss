/**
 * Tests that Atlassian's v2 discovery document URL resolves directly via
 * the catalog-specified discovery document path in resolveAuthorizationServer
 * and rejects mismatched issuers per RFC 8414 §3.3.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAuthorizationServer } from "../oauth-authorization-server";

const { safeFetchOutboundMock } = vi.hoisted(() => ({
	safeFetchOutboundMock: vi.fn(),
}));

vi.mock("@repo/utils/url-security", () => ({
	assertSafeOutboundUrl: vi.fn(),
	safeFetchOutbound: (...args: unknown[]) => safeFetchOutboundMock(...args),
}));

const ATLASSIAN_V2_DISCOVERY_URL =
	"https://auth.atlassian.com/.well-known/oauth-authorization-server/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3";
const EXPECTED_ISSUER =
	"https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3";
const TOKEN_ENDPOINT = "https://auth.atlassian.com/oauth/token";
const REGISTRATION_ENDPOINT =
	"https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/dcr/register";
const AUTHORIZATION_ENDPOINT = "https://auth.atlassian.com/authorize";

const ATLASSIAN_SERVER = {
	id: "srv-atlassian",
	key: "atlassian",
	isSystemProvided: true,
	oauthDiscoveryUrl: ATLASSIAN_V2_DISCOVERY_URL,
	oauthAuthorizationEndpoint: null,
	oauthTokenEndpoint: null,
};

describe("Atlassian v2 direct discovery document resolution", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves the v2 document URL to the expected path-scoped issuer and endpoints", async () => {
		safeFetchOutboundMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: () =>
				Promise.resolve({
					issuer: EXPECTED_ISSUER,
					authorization_endpoint: AUTHORIZATION_ENDPOINT,
					token_endpoint: TOKEN_ENDPOINT,
					registration_endpoint: REGISTRATION_ENDPOINT,
					response_types_supported: ["code"],
				}),
		});

		const result = await resolveAuthorizationServer({
			server: ATLASSIAN_SERVER,
			baseUrl: "https://mcp.atlassian.com/v2/mcp?tools=all",
		});

		expect(safeFetchOutboundMock).toHaveBeenCalledWith(
			ATLASSIAN_V2_DISCOVERY_URL,
			expect.objectContaining({
				headers: { Accept: "application/json" },
			}),
		);
		expect(result).not.toBeNull();
		expect(result?.authorizationEndpoint).toBe(AUTHORIZATION_ENDPOINT);
		expect(result?.registrationEndpoint).toBe(REGISTRATION_ENDPOINT);
		expect(result?.binding).toMatchObject({
			authorizationServerUrl: EXPECTED_ISSUER,
			tokenEndpoint: TOKEN_ENDPOINT,
		});
	});

	it("refuses a metadata document whose issuer does not match the URL (RFC 8414 §3.3)", async () => {
		safeFetchOutboundMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: () =>
				Promise.resolve({
					issuer: "https://auth.atlassian.com", // Root issuer instead of v2 login-server path
					authorization_endpoint: AUTHORIZATION_ENDPOINT,
					token_endpoint: TOKEN_ENDPOINT,
					registration_endpoint: REGISTRATION_ENDPOINT,
				}),
		});

		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		const result = await resolveAuthorizationServer({
			server: ATLASSIAN_SERVER,
			baseUrl: "https://mcp.atlassian.com/v2/mcp?tools=all",
		});

		expect(result).toBeNull();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				"Refused a metadata document whose issuer does not match",
			),
			expect.anything(),
		);
	});
});
