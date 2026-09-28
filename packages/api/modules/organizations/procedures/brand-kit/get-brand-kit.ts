import { ORPCError } from "@orpc/server";
import { getBrandKit } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertGlossyEnabledForOrganization } from "../../../projects/lib/glossy-feature";
import { verifyOrganizationMembership } from "../../lib/membership";

export const brandKitOutputSchema = z.object({
	accentColors: z.array(z.string()),
	guidance: z.string().nullable(),
	/** Null until the kit is first saved. */
	updatedAt: z.date().nullable(),
});

/**
 * Get the organization's Brand kit (Fizzy #2589, R31, KTD2): the accent
 * colors and brand guidance its Glossy editions use. The logo and the named
 * brand color are read where they already live; this returns only what the
 * kit adds.
 *
 * Project guests never read it here — they are not members of the
 * organization; the build reads it through `getBrandKitForProject`.
 *
 * AUTHORIZATION: `ORG_READ` against the requested organization, then the
 * Glossy rollout gate for that organization.
 */
export const getBrandKitProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/brand-kit",
		tags: ["Organizations", "Glossy"],
		summary: "Get the organization Brand kit",
		description:
			"The accent colors and brand guidance used to style the organization's Glossy editions.",
	})
	.input(z.object({ organizationId: z.string() }))
	.output(z.object({ brandKit: brandKitOutputSchema }))
	.handler(async ({ context: { user }, input: { organizationId } }) => {
		const membership = await verifyOrganizationMembership(
			organizationId,
			user.id,
		);
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You are not a member of this organization",
			});
		}
		await assertGlossyEnabledForOrganization(organizationId);

		const brandKit = await getBrandKit(organizationId);
		return {
			brandKit: {
				accentColors: brandKit?.accentColors ?? [],
				guidance: brandKit?.guidance ?? null,
				updatedAt: brandKit?.updatedAt ?? null,
			},
		};
	});
