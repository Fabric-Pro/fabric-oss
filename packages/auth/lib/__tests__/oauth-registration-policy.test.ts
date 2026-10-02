import { describe, expect, it } from "vitest";
import {
	applyRegistrationPolicy,
	assertAllowedRedirectUri,
	OAuthRegistrationError,
} from "../oauth-registration-policy";

/** Escaped rather than typed: literal bidi characters in source are a hazard. */
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

function register(overrides: Record<string, unknown> = {}) {
	const body: Record<string, unknown> = {
		redirect_uris: ["http://127.0.0.1:49152/callback"],
		token_endpoint_auth_method: "none",
		client_name: "Example Agent",
		...overrides,
	};
	applyRegistrationPolicy(body);
	return body;
}

describe("redirect URIs an anonymous client may register", () => {
	it.each([
		"https://agent.example/callback",
		"http://127.0.0.1:5050/callback",
		"http://127.0.0.1/callback",
		"http://localhost:5050/callback",
		"http://[::1]:5050/callback",
		"vscode://example.agent/callback",
		"cursor://example.agent/callback",
		"com.example.agent:/callback",
	])("accepts %s", (uri) => {
		expect(() => assertAllowedRedirectUri(uri)).not.toThrow();
	});

	it.each([
		"javascript:alert(1)",
		"data:text/html,x",
		"file:///etc/passwd",
		"vbscript:x",
		"blob:https://example.com/x",
		"http://attacker.example/callback",
		"http://127.0.0.1.attacker.example/callback",
		"ftp://example.com/x",
		"https://user:secret@agent.example/callback",
		"https://agent.example/callback#fragment",
		"not a url",
		"",
	])("refuses %s", (uri) => {
		expect(() => assertAllowedRedirectUri(uri)).toThrow(
			OAuthRegistrationError,
		);
	});

	it("refuses an unreasonably long redirect", () => {
		expect(() =>
			assertAllowedRedirectUri(
				`https://agent.example/${"a".repeat(3000)}`,
			),
		).toThrow("too long");
	});
});

describe("the registration request as a whole", () => {
	it("passes a plain public client through", () => {
		const body = register();

		expect(body.token_endpoint_auth_method).toBe("none");
		expect(body.client_name).toBe("Example Agent");
	});

	it("forces the public method when none was asked for", () => {
		const body = register({ token_endpoint_auth_method: undefined });

		expect(body.token_endpoint_auth_method).toBe("none");
	});

	it("refuses a confidential client", () => {
		expect(() =>
			register({ token_endpoint_auth_method: "client_secret_basic" }),
		).toThrow("public clients");
	});

	it("refuses more than five redirects and none at all", () => {
		const uris = Array.from(
			{ length: 6 },
			(_, i) => `https://agent.example/${i}`,
		);
		expect(() => register({ redirect_uris: uris })).toThrow(
			OAuthRegistrationError,
		);
		expect(() => register({ redirect_uris: [] })).toThrow(
			OAuthRegistrationError,
		);
		expect(() =>
			register({ redirect_uris: "https://agent.example" }),
		).toThrow(OAuthRegistrationError);
	});

	it("refuses grants other than authorization_code and refresh_token", () => {
		expect(() => register({ grant_types: ["client_credentials"] })).toThrow(
			"grant_types",
		);
		expect(() =>
			register({ grant_types: ["authorization_code", "refresh_token"] }),
		).not.toThrow();
	});

	it("strips control and direction characters and bounds the name", () => {
		const body = register({
			client_name: `${RIGHT_TO_LEFT_OVERRIDE}Example\u0000 Agent\n${"x".repeat(300)}`,
		});

		const name = String(body.client_name);
		for (const removed of [RIGHT_TO_LEFT_OVERRIDE, "\u0000", "\n"]) {
			expect(name.includes(removed), JSON.stringify(removed)).toBe(false);
		}
		expect(name.startsWith("Example Agent")).toBe(true);
		expect(name.length).toBeLessThanOrEqual(100);
	});

	it("drops a name that is nothing but invisible characters", () => {
		expect(
			register({
				client_name: `${ZERO_WIDTH_SPACE}${RIGHT_TO_LEFT_OVERRIDE}`,
			}).client_name,
		).toBeUndefined();
	});

	it("drops every link and contact the client supplied, so none can reach a person", () => {
		const body = register({
			client_uri: "https://phish.example",
			logo_uri: "https://phish.example/logo.png",
			tos_uri: "https://phish.example/tos",
			policy_uri: "https://phish.example/policy",
			software_statement: "eyJ",
			contacts: ["a@example.com"],
			post_logout_redirect_uris: ["https://phish.example/out"],
		});

		for (const field of [
			"client_uri",
			"logo_uri",
			"tos_uri",
			"policy_uri",
			"software_statement",
			"contacts",
			"post_logout_redirect_uris",
		]) {
			expect(body, field).not.toHaveProperty(field);
		}
	});
});
