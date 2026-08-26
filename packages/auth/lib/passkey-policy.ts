/**
 * Passkey ↔ 2FA policy (GitHub issue #2802).
 *
 * DECISION: passkey sign-in satisfies 2FA in this product. A user with
 * `twoFactorEnabled` who signs in via `/passkey/verify-authentication` is
 * deliberately NOT routed through the TOTP challenge — which is why that
 * path is listed in `TWO_FACTOR_GATE_EXEMPT_PATHS`
 * (./two-factor-gate.ts), the exemption set the deny-by-default gate in
 * `auth.ts` consults. A discoverable credential asserted with user
 * verification is genuinely two factors: possession of the authenticator
 * plus the local PIN/biometric that unlocks it. This mirrors better-auth
 * upstream, whose own `twoFactor()` plugin intercepts only
 * `/sign-in/{email,username,phone-number}` and leaves passkey sign-in
 * alone, and matches industry practice (e.g. GitHub treats a
 * user-verified passkey as 2FA on its own).
 *
 * That decision is only sound if user verification actually happened.
 * `@better-auth/passkey` (exact-pinned — see `packages/auth/package.json`)
 * does NOT guarantee that on its own:
 *
 *  - `/passkey/generate-authenticate-options` hardcodes the client hint
 *    `userVerification: "preferred"`, under which an authenticator may
 *    assert on possession alone (no PIN, no biometric) — one factor;
 *  - `/passkey/verify-authentication` and `/passkey/verify-registration`
 *    both call simplewebauthn with `requireUserVerification: false`, so
 *    the server would accept such a possession-only assertion.
 *
 * This module therefore enforces user verification at every layer the
 *  plugin exposes:
 *
 *  1. registration options: `authenticatorSelection.userVerification:
 *     "required"` (the one knob the plugin does expose);
 *  2. sign-in, server-side (the actual security boundary):
 *     `authentication.afterVerification` throws when the authenticator
 *     data's UV flag is false. The plugin's own try/catch converts the
 *     throw into AUTHENTICATION_FAILED — the session is never created,
 *     so this fails closed;
 *  3. registration, server-side: same check on the registration response,
 *     so a credential that could never sign in under (2) is rejected at
 *     add-time instead of stranding the user at login;
 *  4. authentication options: `patchPasskeyAuthOptionsUserVerification`
 *     (wired in `auth.ts`'s `hooks.after`) rewrites the hardcoded
 *     "preferred" hint to "required" in the
 *     `/passkey/generate-authenticate-options` response, so browsers
 *     prompt for PIN/biometric up front (a PIN-less security key gets a
 *     PIN-enrollment prompt) instead of producing an assertion that (2)
 *     rejects with a generic failure.
 *
 * `__tests__/passkey-policy.test.ts` pins the option wiring and endpoint
 * paths, and `__tests__/passkey-policy-wiring.test.ts` pins that auth.ts
 * installs this configured plugin. What no test here can prove is that
 * the plugin still INVOKES `afterVerification` — and does so before
 * session creation, inside a failure-converting try/catch. That control
 * flow was verified by hand against the exact-pinned 1.6.2 dist; any
 * upgrade of `@better-auth/passkey` must re-verify the callback's
 * ordering and error handling in `verifyPasskeyAuthentication` /
 * `verifyPasskeyRegistration` before bumping the pin.
 */

import { passkey } from "@better-auth/passkey";
import { APIError } from "better-auth/api";

export const PASSKEY_AUTHENTICATOR_SELECTION = {
	// Registration-time hint: require PIN/biometric when creating the
	// credential. The plugin spreads this over its own defaults, so
	// `residentKey: "preferred"` is preserved.
	userVerification: "required",
} as const satisfies AuthenticatorSelectionCriteria;

/**
 * Server-side UV enforcement for `/passkey/verify-authentication`.
 * Throws unless the assertion's authenticator-data UV flag is set —
 * possession alone must never mint a session, because passkey sign-in
 * bypasses the TOTP challenge (see module doc).
 */
export function assertPasskeyAuthenticationUserVerified(verification: {
	authenticationInfo: { userVerified: boolean };
}): void {
	if (!verification.authenticationInfo.userVerified) {
		throw new APIError("UNAUTHORIZED", {
			message:
				"Passkey sign-in requires user verification (PIN or biometric)",
		});
	}
}

/**
 * Server-side UV enforcement for `/passkey/verify-registration`. A
 * credential registered without UV would be unusable for sign-in under
 * `assertPasskeyAuthenticationUserVerified`; reject it at add-time
 * instead. `registrationInfo` is optional on simplewebauthn's response
 * type — absence means "not verified" and is treated as such.
 */
export function assertPasskeyRegistrationUserVerified(verification: {
	registrationInfo?: { userVerified: boolean } | undefined;
}): void {
	if (!verification.registrationInfo?.userVerified) {
		throw new APIError("BAD_REQUEST", {
			message:
				"Passkey registration requires user verification (PIN or biometric)",
		});
	}
}

/**
 * Rewrites the `userVerification` hint in a
 * `/passkey/generate-authenticate-options` response body from the
 * plugin's hardcoded "preferred" to "required". Purely a UX layer — the
 * server-side check above is the actual boundary — but without it a
 * possession-only authenticator produces an assertion the server then
 * rejects with a generic failure, instead of the browser prompting for
 * PIN/biometric up front.
 *
 * Called from `auth.ts`'s `hooks.after` with `ctx.context.returned`,
 * which at that point is the endpoint's plain JSON body (better-call's
 * `ctx.json` returns the raw object on the internal path) — mutated in
 * place before serialization. Tolerates every other `returned` shape
 * (APIError, undefined, a wrapped `_flag: "json"` object) by mutating
 * only something that structurally looks like WebAuthn authentication
 * options.
 */
export function patchPasskeyAuthOptionsUserVerification(
	returned: unknown,
): void {
	if (!returned || typeof returned !== "object") {
		return;
	}
	// Unwrap better-call's `asResponse` json envelope if present.
	const body =
		"_flag" in returned &&
		(returned as { _flag?: unknown })._flag === "json"
			? (returned as { body?: unknown }).body
			: returned;
	// Keyed on `challenge` alone — the field is set even when a future
	// plugin version stops emitting a `userVerification` hint entirely,
	// since WebAuthn's default ("preferred") would silently reopen the
	// browser/server mismatch.
	if (body && typeof body === "object" && "challenge" in body) {
		(body as { userVerification?: string }).userVerification = "required";
	}
}

/**
 * The passkey plugin, configured to enforce the policy above. Use this
 * instead of a bare `passkey()`.
 */
export function createPasskeyPlugin() {
	return passkey({
		authenticatorSelection: PASSKEY_AUTHENTICATOR_SELECTION,
		authentication: {
			afterVerification: async ({ verification }) => {
				assertPasskeyAuthenticationUserVerified(verification);
			},
		},
		registration: {
			afterVerification: async ({ verification }) => {
				assertPasskeyRegistrationUserVerified(verification);
			},
		},
	});
}
