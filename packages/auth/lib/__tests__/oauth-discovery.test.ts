import { describe, expect, it } from "vitest";
import { buildGatewayProtectedResourceMetadata } from "../oauth-protected-resource";
import {
	gatewayAuthenticateHeader,
	isOAuthScope,
	OAUTH_SCOPES,
	oauthGatewayMetadataUrl,
	oauthIssuer,
	oauthProjectGatewayMetadataUrl,
	oauthValidAudiences,
} from "../oauth-scopes";

const APP_URL = "https://app.example.com";

describe("protected-resource metadata", () => {
	it("names the gateway, the scopes an agent may hold and the issuer exactly as given", () => {
		const issuer = oauthIssuer(APP_URL);

		const metadata = buildGatewayProtectedResourceMetadata({
			appUrl: `${APP_URL}/`,
			issuer,
		});

		expect(metadata).toEqual({
			resource: "https://app.example.com/api/mcp-gateway",
			authorization_servers: [issuer],
			scopes_supported: [
				"mcp:read",
				"instructions:read",
				"instructions:write",
				"offline_access",
			],
			bearer_methods_supported: ["header"],
			resource_name: "Fabric",
		});
		expect(metadata.authorization_servers[0]).toBe(
			"https://app.example.com/api/auth",
		);
	});

	it("names a project's URL, and only that URL, as the resource of a project's gateway", () => {
		const issuer = oauthIssuer(APP_URL);

		const metadata = buildGatewayProtectedResourceMetadata({
			appUrl: `${APP_URL}/`,
			issuer,
			projectId: "project-example-one",
		});

		expect(metadata.resource).toBe(
			"https://app.example.com/api/mcp-gateway/projects/project-example-one",
		);
		expect(metadata.authorization_servers).toEqual([issuer]);
		expect(metadata.scopes_supported).toEqual([...OAUTH_SCOPES]);
	});
});

describe("the 401 challenge", () => {
	it("points at the path-inserted metadata and lists the scopes", () => {
		expect(gatewayAuthenticateHeader(APP_URL)).toBe(
			'Bearer resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/api/mcp-gateway", scope="mcp:read instructions:read instructions:write offline_access"',
		);
		expect(oauthGatewayMetadataUrl(`${APP_URL}/`)).toBe(
			"https://app.example.com/.well-known/oauth-protected-resource/api/mcp-gateway",
		);
	});

	it("points a project's URL at that project's own metadata", () => {
		expect(
			gatewayAuthenticateHeader(APP_URL, {
				projectId: "project-example-one",
			}),
		).toBe(
			'Bearer resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/api/mcp-gateway/projects/project-example-one", scope="mcp:read instructions:read instructions:write offline_access"',
		);
		expect(
			oauthProjectGatewayMetadataUrl(
				`${APP_URL}/`,
				"project-example-one",
			),
		).toBe(
			"https://app.example.com/.well-known/oauth-protected-resource/api/mcp-gateway/projects/project-example-one",
		);
	});

	it("marks a credential that was presented and does not fit as an invalid token", () => {
		expect(
			gatewayAuthenticateHeader(APP_URL, {
				projectId: "project-example-one",
				invalidToken: true,
			}),
		).toBe(
			'Bearer error="invalid_token", resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/api/mcp-gateway/projects/project-example-one", scope="mcp:read instructions:read instructions:write offline_access"',
		);
	});
});

describe("scopes and audiences", () => {
	it("never offers a scope that writes MCP tools, publishes or acts as a wildcard", () => {
		for (const refused of [
			"mcp:write",
			"instructions:publish",
			"*",
			"openid",
		]) {
			expect(isOAuthScope(refused), refused).toBe(false);
			expect(OAUTH_SCOPES as readonly string[]).not.toContain(refused);
		}
	});

	it("accepts the gateway with and without a trailing slash, and the API", () => {
		expect(oauthValidAudiences(`${APP_URL}/`)).toEqual([
			"https://app.example.com/api/mcp-gateway",
			"https://app.example.com/api/mcp-gateway/",
			"https://app.example.com/api/v1",
		]);
	});
});
