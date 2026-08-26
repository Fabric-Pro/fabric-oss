/**
 * Contract ("policy pin") tests for the passkey ↔ 2FA policy
 * (../passkey-policy.ts, GitHub issue #2802).
 *
 * The policy — passkey sign-in satisfies 2FA, so it is exempt from the
 * post-sign-in TOTP challenge in auth.ts — is only sound while user
 * verification is enforced. These tests pin the pieces that enforcement
 * hangs on: the registration hint, both server-side UV assertions, the
 * auth-options hint rewrite, and the endpoint paths the auth.ts wiring
 * refers to. An `@better-auth/passkey` upgrade that moves an endpoint or
 * drops the options passthrough fails here rather than silently
 * un-enforcing the control. What this suite CANNOT catch is an upgrade
 * that keeps the public `options` surface but stops invoking
 * `afterVerification` (or invokes it after session creation) — that
 * control flow is guaranteed only by the exact version pin and must be
 * re-verified by hand on every `@better-auth/passkey` bump (see the
 * module doc in ../passkey-policy.ts).
 *
 * Deliberately asserted only against the plugin's PUBLIC surface — never
 * `@better-auth/passkey/dist/**` internals.
 *
 * Run with: pnpm --filter @repo/auth test lib/__tests__/passkey-policy.test.ts
 */

import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";
import {
	assertPasskeyAuthenticationUserVerified,
	assertPasskeyRegistrationUserVerified,
	createPasskeyPlugin,
	PASSKEY_AUTHENTICATOR_SELECTION,
	patchPasskeyAuthOptionsUserVerification,
} from "../passkey-policy";

describe("PASSKEY_AUTHENTICATOR_SELECTION", () => {
	it("pins required user verification for registration", () => {
		expect(PASSKEY_AUTHENTICATOR_SELECTION).toEqual({
			userVerification: "required",
		});
	});
});

describe("assertPasskeyAuthenticationUserVerified()", () => {
	it("throws UNAUTHORIZED when the assertion was possession-only", () => {
		expect(() =>
			assertPasskeyAuthenticationUserVerified({
				authenticationInfo: { userVerified: false },
			}),
		).toThrowError(APIError);
	});

	it("passes when the authenticator performed user verification", () => {
		expect(() =>
			assertPasskeyAuthenticationUserVerified({
				authenticationInfo: { userVerified: true },
			}),
		).not.toThrow();
	});
});

describe("assertPasskeyRegistrationUserVerified()", () => {
	it("throws when registration happened without user verification", () => {
		expect(() =>
			assertPasskeyRegistrationUserVerified({
				registrationInfo: { userVerified: false },
			}),
		).toThrowError(APIError);
	});

	it("treats a missing registrationInfo as not verified", () => {
		expect(() => assertPasskeyRegistrationUserVerified({})).toThrowError(
			APIError,
		);
	});

	it("passes when the authenticator performed user verification", () => {
		expect(() =>
			assertPasskeyRegistrationUserVerified({
				registrationInfo: { userVerified: true },
			}),
		).not.toThrow();
	});
});

describe("patchPasskeyAuthOptionsUserVerification()", () => {
	it('rewrites the hint on a plain WebAuthn options body ("preferred" → "required")', () => {
		const body = {
			challenge: "abc",
			rpId: "example.com",
			userVerification: "preferred",
		};
		patchPasskeyAuthOptionsUserVerification(body);
		expect(body.userVerification).toBe("required");
	});

	it("adds the hint when a future plugin version omits the field entirely", () => {
		// WebAuthn defaults an absent hint to "preferred" — the patch must
		// not depend on the current plugin emitting the field.
		const body: Record<string, unknown> = { challenge: "abc" };
		patchPasskeyAuthOptionsUserVerification(body);
		expect(body.userVerification).toBe("required");
	});

	it('unwraps better-call\'s `_flag: "json"` envelope', () => {
		const envelope = {
			_flag: "json",
			body: { challenge: "abc", userVerification: "preferred" },
		};
		patchPasskeyAuthOptionsUserVerification(envelope);
		expect(envelope.body.userVerification).toBe("required");
	});

	it("leaves non-options shapes untouched", () => {
		const error = new APIError("BAD_REQUEST", { message: "nope" });
		expect(() =>
			patchPasskeyAuthOptionsUserVerification(error),
		).not.toThrow();

		// No `challenge` → not an options body; must not be mutated.
		const other: Record<string, unknown> = {
			userVerification: "preferred",
		};
		patchPasskeyAuthOptionsUserVerification(other);
		expect(other.userVerification).toBe("preferred");

		expect(() =>
			patchPasskeyAuthOptionsUserVerification(undefined),
		).not.toThrow();
		expect(() =>
			patchPasskeyAuthOptionsUserVerification(null),
		).not.toThrow();
		expect(() =>
			patchPasskeyAuthOptionsUserVerification("challenge"),
		).not.toThrow();
	});
});

describe("createPasskeyPlugin()", () => {
	const plugin = createPasskeyPlugin();

	it('has plugin id "passkey"', () => {
		expect(plugin.id).toBe("passkey");
	});

	it("passes the required-UV authenticatorSelection through to the plugin", () => {
		expect(plugin.options?.authenticatorSelection).toEqual({
			userVerification: "required",
		});
	});

	it("wires UV enforcement into both afterVerification hooks", async () => {
		const authHook = plugin.options?.authentication?.afterVerification;
		const regHook = plugin.options?.registration?.afterVerification;
		expect(authHook).toBeTypeOf("function");
		expect(regHook).toBeTypeOf("function");

		// Structural stand-ins for the plugin's verification payloads.
		const authArgs: any = {
			verification: { authenticationInfo: { userVerified: false } },
		};
		await expect(authHook?.(authArgs)).rejects.toThrowError(APIError);
		authArgs.verification.authenticationInfo.userVerified = true;
		await expect(authHook?.(authArgs)).resolves.toBeUndefined();

		const regArgs: any = {
			verification: { registrationInfo: { userVerified: false } },
		};
		await expect(regHook?.(regArgs)).rejects.toThrowError(APIError);
		regArgs.verification.registrationInfo.userVerified = true;
		await expect(regHook?.(regArgs)).resolves.toBeUndefined();
	});

	it("still exposes the endpoints the auth.ts wiring depends on, at their expected paths", () => {
		// The 2FA challenge hook's matcher deliberately EXCLUDES the
		// verify-authentication path (policy #2802), and hooks.after
		// rewrites the generate-authenticate-options response — both
		// reference these literal paths.
		expect(plugin.endpoints.verifyPasskeyAuthentication.path).toBe(
			"/passkey/verify-authentication",
		);
		expect(plugin.endpoints.generatePasskeyAuthenticationOptions.path).toBe(
			"/passkey/generate-authenticate-options",
		);
		expect(plugin.endpoints.verifyPasskeyRegistration.path).toBe(
			"/passkey/verify-registration",
		);
	});
});
