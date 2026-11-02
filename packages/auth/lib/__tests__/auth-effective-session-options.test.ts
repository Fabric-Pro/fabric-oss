import type { BetterAuthOptions } from "better-auth";
import { describe, expect, it } from "vitest";
import { authOptions } from "../../auth";

const effectiveOptions: BetterAuthOptions = authOptions;

describe("effective Fabric session options", () => {
	it("disables the signed session cookie cache", () => {
		expect(effectiveOptions.session?.cookieCache?.enabled).toBe(false);
	});

	it("revokes existing sessions during password reset", () => {
		expect(
			effectiveOptions.emailAndPassword?.revokeSessionsOnPasswordReset,
		).toBe(true);
	});
});
