/**
 * `memory:write` is the one deliberate exception to propose-only (ADR-022): it
 * writes files into Living Memory folders and, on a direct-push folder, lands
 * a commit with no review. It must be asked for by name, so it is a scope the
 * authorization server understands and never one a client gets by default.
 */
import { describe, expect, it } from "vitest";
import {
	isOAuthScope,
	OAUTH_DEFAULT_SCOPES,
	OAUTH_SCOPES,
} from "../oauth-scopes";

describe("the memory:write scope", () => {
	it("is a scope the authorization server understands", () => {
		expect(OAUTH_SCOPES).toContain("memory:write");
		expect(isOAuthScope("memory:write")).toBe(true);
	});

	it("is not granted by default", () => {
		expect(OAUTH_DEFAULT_SCOPES as readonly string[]).not.toContain(
			"memory:write",
		);
	});

	it("keeps the defaults a subset of the scopes", () => {
		for (const scope of OAUTH_DEFAULT_SCOPES) {
			expect(OAUTH_SCOPES).toContain(scope);
		}
	});
});
