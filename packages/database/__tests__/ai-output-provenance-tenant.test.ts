import { describe, expect, it } from "vitest";
import {
	createOrganizationContext,
	runWithTenantContext,
} from "../src/tenant-context";
import { mergeWithTenantFilter } from "../src/tenant-db";

describe("AI output provenance tenant filtering", () => {
	it.each(["example-org", "example-other-org"])(
		"scopes subject lookups to %s",
		(organizationId) => {
			const identity = {
				organizationId,
				userId: "example-user",
				subjectType: "copilot-message",
				subjectId: "example-message",
			};
			const where = {
				organizationId_userId_subjectType_subjectId: identity,
			};
			const result = runWithTenantContext(
				createOrganizationContext(organizationId, identity.userId),
				() => mergeWithTenantFilter("AiOutputProvenance", where),
			);
			expect(result).toEqual({ AND: [where, { organizationId }] });
		},
	);
});
