/**
 * `assertOAuthStartOrganization` — the handler-level rule that no integration
 * OAuth state is minted without an organization (ADR-018: no personal arm).
 */

import { describe, expect, it } from "vitest";
import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../../../lib/missing-organization-context";
import { assertOAuthStartOrganization } from "../../lib/oauth-start-organization";

describe("assertOAuthStartOrganization", () => {
	it.each([undefined, null, ""])(
		"refuses %j as FORBIDDEN with the missing-workspace marker",
		(value) => {
			let refusal: unknown;
			try {
				assertOAuthStartOrganization(value);
			} catch (error) {
				refusal = error;
			}
			expect(refusal).toMatchObject({
				code: "FORBIDDEN",
				status: 403,
				data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
			});
		},
	);

	it("passes a resolved organization through and narrows it", () => {
		const organizationId: string | undefined = "org-1";
		expect(() =>
			assertOAuthStartOrganization(organizationId),
		).not.toThrow();
	});
});
