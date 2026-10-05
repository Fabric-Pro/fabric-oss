/**
 * Where `auth.ts` mounts the project binding.
 *
 * The end-to-end suite drives the same hook through a harness that stands in
 * for `auth.ts`, so it proves what the hook does and not that `auth.ts` runs it.
 * `auth.ts` builds the Better Auth instance at module load with dozens of
 * side-effecting dependencies, so this reads its source, in a bounded slice,
 * the way the other wiring suites do.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { sliceBetween } from "./support/auth-source-slice";

let AUTH_SOURCE = "";

beforeAll(() => {
	const here = dirname(fileURLToPath(import.meta.url));
	AUTH_SOURCE = readFileSync(join(here, "..", "..", "auth.ts"), "utf8");
});

describe("auth.ts mounts the project binding", () => {
	it("runs it in the global before-hook for authorize, consent and token, and hands the token endpoint's context back", () => {
		const hook = sliceBetween(
			AUTH_SOURCE,
			"before: createAuthMiddleware(async (ctx) => {",
			"// Server-enforced step-up for the 2FA MANAGEMENT endpoints",
		);

		expect(hook).toContain('ctx.path === "/oauth2/authorize"');
		expect(hook).toContain('ctx.path === "/oauth2/consent"');
		expect(hook).toContain('ctx.path === "/oauth2/token"');
		expect(hook).toContain("enforceOAuthResourceBinding(ctx, {");
		expect(hook).toMatch(/appUrl,/);
		expect(hook).toContain("getSessionFromCtx(ctx)");
		expect(hook).toMatch(
			/if \(resourceContext\) \{\s*return resourceContext;/,
		);
	});

	it("audits a consent with the grant it issued, never with a fresh reading of the binding", () => {
		const audit = sliceBetween(
			AUTH_SOURCE,
			'if (ctx.path === "/oauth2/consent") {',
			"Failed to audit OAuth consent",
		);

		expect(audit).toContain("await auditOAuthConsent(ctx);");
		expect(AUTH_SOURCE).not.toContain("resolveConsentGrant");
		expect(AUTH_SOURCE).not.toContain("liveProjectBinding");
	});
});
