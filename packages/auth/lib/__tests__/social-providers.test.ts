import { describe, expect, it } from "vitest";
import { socialProviders } from "../social-providers";

describe("socialProviders config", () => {
	it("forces Google's account chooser so invited users can pick the right account", () => {
		expect(socialProviders.google.prompt).toBe("select_account");
	});

	it("leaves GitHub without a prompt override (no select_account equivalent)", () => {
		expect(
			(socialProviders.github as { prompt?: string }).prompt,
		).toBeUndefined();
	});

	it("disables Google's idToken sign-in branch, which bypasses 2FA", () => {
		// `POST /sign-in/social` with an `idToken` body mints a session
		// directly and is matched by neither Better Auth's own 2FA hook nor
		// auth.ts's magic-link/OAuth replica — see social-providers.ts for
		// the full explanation.
		expect(socialProviders.google.disableIdTokenSignIn).toBe(true);
	});
});
