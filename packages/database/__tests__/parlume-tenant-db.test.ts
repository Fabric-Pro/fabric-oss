import { describe, expect, it } from "vitest";
import {
	createOrganizationContext,
	grantProjectAccess,
	runWithTenantContext,
} from "../src/tenant-context";
import { mergeWithTenantFilter } from "../src/tenant-db";

describe("Parlume action tenant boundaries", () => {
	it("adds the active organization to unscoped action queries", () => {
		const filter = runWithTenantContext(
			createOrganizationContext("example-org", "example-user"),
			() => mergeWithTenantFilter("ParlumeAction", undefined),
		);
		expect(filter).toEqual({ organizationId: "example-org" });
	});
	it("preserves explicit project scoping within the tenant filter", () => {
		const filter = runWithTenantContext(
			createOrganizationContext("example-org", "example-user"),
			() =>
				mergeWithTenantFilter("ParlumeAction", {
					projectId: "example-project",
				}),
		);
		expect(filter).toEqual({
			AND: [
				{ projectId: "example-project" },
				{ organizationId: "example-org" },
			],
		});
	});
	it("includes only explicitly granted projects for project guests", () => {
		const filter = runWithTenantContext(
			createOrganizationContext("example-org", "example-user"),
			() => {
				grantProjectAccess("example-project");
				return mergeWithTenantFilter("ParlumeAction", undefined);
			},
		);
		expect(filter).toEqual({
			OR: [
				{ organizationId: "example-org" },
				{ projectId: { in: ["example-project"] } },
			],
		});
	});
});
