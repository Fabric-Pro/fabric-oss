/**
 * Every authenticated oRPC call counts as the caller's own interactive work:
 * the session middleware sets `runWithAiInteractiveContext`, so the AI work
 * of any procedure may run on the caller's own ChatGPT plan (Fizzy #2939).
 * That is safe only because an oRPC session is a browser cookie session — an
 * API key, an organization key or a signed-in agent's bearer token never
 * becomes one, so an automation can never spend a person's plan through a
 * procedure.
 *
 * That property comes from the auth configuration, not from the procedures —
 * including the OAuth provider that issues bearer tokens to MCP clients.
 * If someone registers better-auth's `bearer` or `apiKey` plugin (or enables
 * sessions for API keys), this test fails, and the session middleware must
 * then set the marker only for a cookie session.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const authDir = join(__dirname, "../../auth");
const authSource = readFileSync(join(authDir, "auth.ts"), "utf8");

/** The calls in `auth.ts`'s `plugins: [ ... ]` list, by name. */
function registeredPlugins(): string[] {
	const start = authSource.indexOf("\tplugins: [");
	const end = authSource.indexOf("\n\t],", start);
	const list = authSource.slice(start, end);
	return [...list.matchAll(/^\t\t([A-Za-z]+)\(/gm)].map((match) => match[1]);
}

describe("oRPC sessions come from browser cookies only", () => {
	it("registers no plugin that turns a bearer token or an API key into a session", () => {
		expect(authSource).not.toMatch(/\bbearer\s*\(/);
		expect(authSource).not.toMatch(/\bapiKey\s*\(/);
		expect(authSource).not.toMatch(/enableSessionForAPIKeys/);
	});

	// A new plugin is the other way a bearer token could become a session.
	// Adding one fails here until someone checks that it does not.
	it("registers only the reviewed plugins", () => {
		expect(registeredPlugins()).toEqual([
			"username",
			"admin",
			"createPasskeyPlugin",
			"magicLink",
			"organization",
			"openAPI",
			"invitationOnlyPlugin",
			"createTwoFactorPlugin",
			"createOAuthProviderPlugin",
		]);
	});

	// The OAuth provider issues bearer access tokens for MCP clients. They are
	// verified by the resource routes, never by `getSession`: the plugin hooks
	// no session read, and its only session lookup follows a session cookie
	// it just set. An upgrade that hooks `/get-session` fails here.
	it("installs an OAuth provider that never turns its access tokens into a session", () => {
		const requireFromAuth = createRequire(join(authDir, "package.json"));
		const dist = dirname(
			requireFromAuth.resolve("@better-auth/oauth-provider"),
		);
		const code = readdirSync(dist)
			.filter((file) => file.endsWith(".mjs"))
			.map((file) => readFileSync(join(dist, file), "utf8"))
			.join("\n");
		expect(code).not.toContain("/get-session");
		expect(code).not.toMatch(/getSession\s*:/);
	});
});
