import { describe, expect, it } from "vitest";
import {
	createOrganizationContext,
	runWithTenantContext,
} from "../src/tenant-context";
import { mergeWithTenantFilter } from "../src/tenant-db";
import { matchesWhere } from "./_helpers/in-memory-rows";

describe("private capture tenant extension", () => {
	it.each([
		"DeliverySignalWatch",
		"DeliverySignalSourceGrant",
		"DeliverySignalObservation",
		"DeliverySignalSourceCommand",
		"DeliverySignalCapturePage",
	])(
		"%s preserves the owner within its exact organization without a project-guest carve-out",
		(model) => {
			const context = createOrganizationContext(
				"example-org",
				"example-owner",
			);
			context.allowedProjectIds.push("example-project");
			for (const access of ["read", "write"] as const) {
				const where = runWithTenantContext(context, () =>
					mergeWithTenantFilter(
						model,
						{ projectId: "example-project" },
						access,
					),
				);
				expect(
					matchesWhere(
						{
							projectId: "example-project",
							organizationId: "example-org",
							userId: "example-owner",
						},
						where,
					),
				).toBe(true);
				for (const row of [
					{
						projectId: "example-project",
						organizationId: "example-org",
						userId: "example-member",
					},
					{
						projectId: "example-project",
						organizationId: "example-other-org",
						userId: "example-owner",
					},
					{
						projectId: "example-project",
						organizationId: null,
						userId: "example-owner",
					},
					{
						projectId: "example-other-project",
						organizationId: "example-org",
						userId: "example-owner",
					},
				]) {
					expect(matchesWhere(row, where)).toBe(false);
				}
			}
		},
	);
});
