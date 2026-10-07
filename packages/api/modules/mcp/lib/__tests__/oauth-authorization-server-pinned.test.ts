/**
 * Fabric's pinned-provider table is a trust anchor: the authorization server
 * it names may receive a stored client secret or an imported refresh token.
 * A SYSTEM catalog row is identified by its key or its URL's exact host; a
 * CUSTOM row only by its URL's host — its key is free-form text its owner
 * chose, so a custom row keyed `github-remote` is not GitHub.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	enteredClientBindingFor,
	getEnvOAuthCredentials,
	independentBindingFor,
	resolveIndependentAuthorizationServer,
} from "../oauth-authorization-server";

const GITHUB_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("pinned providers: identified by key only on a system row", () => {
	it("a CUSTOM row keyed like a pinned provider gets nothing pinned", () => {
		const custom = { key: "github-remote", isSystemProvided: false };

		expect(
			resolveIndependentAuthorizationServer(
				custom,
				"https://mcp.example.com/mcp",
			),
		).toBeNull();
		expect(independentBindingFor(custom, null)).toBeNull();
	});

	it("a CUSTOM row whose URL really is a pinned host still resolves by host", () => {
		const custom = { key: "my-copilot", isSystemProvided: false };

		expect(
			independentBindingFor(custom, "https://api.githubcopilot.com/mcp/"),
		).toMatchObject({ tokenEndpoint: GITHUB_TOKEN_ENDPOINT });
	});

	it("a CUSTOM row keyed like a pinned provider binds an entered client only to its own endpoints", () => {
		expect(
			enteredClientBindingFor(
				{
					key: "github-remote",
					isSystemProvided: false,
					oauthTokenEndpoint: "https://as.example.com/token",
					oauthAuthorizationEndpoint:
						"https://as.example.com/authorize",
				},
				"https://mcp.example.com/mcp",
			),
		).toMatchObject({ tokenEndpoint: "https://as.example.com/token" });
	});

	it("a SYSTEM row is still identified by its key", () => {
		expect(
			independentBindingFor(
				{ key: "github-remote", isSystemProvided: true },
				null,
			),
		).toMatchObject({ tokenEndpoint: GITHUB_TOKEN_ENDPOINT });
	});

	it("Fabric's own client is never offered to a custom row, whatever its key", () => {
		vi.stubEnv("FABRIC_GITHUB_CLIENT_ID", "fabric-github-client");
		vi.stubEnv("FABRIC_GITHUB_CLIENT_SECRET", "fabric-github-secret");

		expect(
			getEnvOAuthCredentials("https://mcp.example.com/mcp", {
				key: "github-remote",
				isSystemProvided: false,
			}),
		).toBeNull();
		expect(
			getEnvOAuthCredentials(null, {
				key: "github-remote",
				isSystemProvided: true,
			}),
		).toMatchObject({ kind: "client", clientId: "fabric-github-client" });
	});
});
