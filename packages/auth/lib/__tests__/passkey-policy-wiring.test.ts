/**
 * Wiring tests for the passkey ↔ 2FA policy (../passkey-policy.ts,
 * GitHub issue #2802).
 *
 * The behavioral contract (UV assertions throw, the options patch
 * rewrites the hint) is locked by `passkey-policy.test.ts`; this file
 * locks that production actually USES it. Like
 * `invite-reconciliation-wiring.test.ts`, the wiring is verified
 * statically — `auth.ts` constructs the Better Auth instance at
 * module-load time with dozens of side-effecting dependencies, so booting
 * it inside a Vitest worker is fragile and slow by precedent. Asserted
 * here:
 *
 *  (a) `auth.ts` installs `createPasskeyPlugin()` and has no path back to
 *      a bare, unenforced `passkey()`;
 *  (b) `hooks.after` applies the auth-options hint patch, gated on the
 *      generate-authenticate-options path;
 *  (c) `/passkey/verify-authentication` is still exempt from the 2FA
 *      challenge gate — the policy is "passkey IS 2FA", so challenging it
 *      would double-challenge passkey users, while quietly losing (a)
 *      would un-enforce the user verification that makes the exemption
 *      sound in the first place.
 *
 * This catches the most common regression mode — a refactor that swaps
 * the configured plugin back to the bare one, or drops the hook call —
 * without coupling to `@better-auth/passkey` internals.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { TWO_FACTOR_GATE_EXEMPT_PATHS } from "../two-factor-gate";

let AUTH_SOURCE = "";

beforeAll(() => {
	// `auth.ts` lives at packages/auth/auth.ts — two levels up from this
	// file in packages/auth/lib/__tests__/.
	const here = dirname(fileURLToPath(import.meta.url));
	AUTH_SOURCE = readFileSync(join(here, "..", "..", "auth.ts"), "utf8");
});

describe("auth.ts wiring — passkey policy", () => {
	it("imports the configured plugin and the options patch from ./lib/passkey-policy", () => {
		expect(AUTH_SOURCE).toMatch(
			/import\s+\{[^}]*createPasskeyPlugin[^}]*\}\s+from\s+["']\.\/lib\/passkey-policy["']/,
		);
		expect(AUTH_SOURCE).toMatch(
			/import\s+\{[^}]*patchPasskeyAuthOptionsUserVerification[^}]*\}\s+from\s+["']\.\/lib\/passkey-policy["']/,
		);
	});

	it("installs createPasskeyPlugin() and never a bare passkey()", () => {
		expect(AUTH_SOURCE).toMatch(/createPasskeyPlugin\(\)/);
		// A bare `passkey()` would reintroduce the unenforced defaults
		// (client hint "preferred", requireUserVerification false).
		expect(AUTH_SOURCE).not.toMatch(/\bpasskey\(/);
		expect(AUTH_SOURCE).not.toMatch(
			/import\s+\{[^}]*\bpasskey\b[^}]*\}\s+from\s+["']@better-auth\/passkey["']/,
		);
	});

	it("applies the auth-options hint patch in hooks.after, gated on the options path", () => {
		expect(AUTH_SOURCE).toMatch(
			/ctx\.path\s*===\s*"\/passkey\/generate-authenticate-options"[\s\S]{0,400}?patchPasskeyAuthOptionsUserVerification\(/,
		);
	});

	it("keeps /passkey/verify-authentication exempt from the 2FA challenge gate", () => {
		// Policy #2802 used to be expressed as an absence — the path was
		// simply missing from an allowlist of paths to challenge. Under the
		// deny-by-default gate (issue #2825) the same policy is an explicit
		// exemption, so it is asserted against the exemption set itself
		// instead of against the shape of an expression in auth.ts.
		expect(
			TWO_FACTOR_GATE_EXEMPT_PATHS.has("/passkey/verify-authentication"),
		).toBe(true);
		// Losing the exemption would double-challenge passkey users; losing
		// the UV enforcement above would make the exemption unsound.
	});
});
