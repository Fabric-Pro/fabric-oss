import { ORPCError } from "@orpc/server";
import {
	BRAND_KIT_MAX_ACCENTS,
	BRAND_KIT_MAX_GUIDANCE_LENGTH,
	BrandKitValidationError,
	upsertBrandKit,
} from "@repo/database";
import { HEX_COLOR_PATTERN } from "@repo/utils/brand-colors";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertGlossyEnabledForOrganization } from "../../../projects/lib/glossy-feature";
import { requireOrgMembership } from "../../lib/membership";
import { brandKitOutputSchema } from "./get-brand-kit";

/**
 * Update the organization's Brand kit (Fizzy #2589, R31, KTD2).
 *
 * Writes `OrganizationBrandKit` only. The named brand color and the logo stay
 * in organization metadata and are not touched: the auth library writes that
 * metadata wholesale, so nothing here reads or writes it.
 *
 * AUTHORIZATION: `ORG_UPDATE` against the requested organization, then admin
 * or owner membership of it, then the Glossy rollout gate.
 */
export const updateBrandKitProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "PUT",
		path: "/organizations/{organizationId}/brand-kit",
		tags: ["Organizations", "Glossy"],
		summary: "Update the organization Brand kit",
		description:
			"Set the accent colors and brand guidance used to style the organization's Glossy editions.",
	})
	.input(
		z.object({
			organizationId: z.string(),
			accentColors: z
				.array(z.string().regex(HEX_COLOR_PATTERN))
				.max(BRAND_KIT_MAX_ACCENTS),
			guidance: z.string().max(BRAND_KIT_MAX_GUIDANCE_LENGTH).nullable(),
		}),
	)
	.output(z.object({ brandKit: brandKitOutputSchema }))
	.handler(async ({ context, input }) => {
		const { organizationId } = input;

		const membership = await requireOrgMembership(
			context.user.id,
			organizationId,
			["admin", "owner"],
		);
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You must be an admin or owner of this organization",
			});
		}
		await assertGlossyEnabledForOrganization(organizationId);

		let saved: Awaited<ReturnType<typeof upsertBrandKit>>;
		try {
			saved = await upsertBrandKit({
				organizationId,
				accentColors: input.accentColors,
				guidance: input.guidance,
				updatedById: context.user.id,
			});
		} catch (error) {
			if (error instanceof BrandKitValidationError) {
				throw new ORPCError("BAD_REQUEST", {
					message: "The Brand kit is not valid",
					data: { code: error.code },
				});
			}
			throw error;
		}

		// Field names only — guidance is free text an audit reader does not
		// need, and colors are visible on the settings page itself.
		recordAuditFromRequest(context, {
			action: "org.brand_kit.updated",
			category: "org",
			organizationId,
			resource: { type: "organization", id: organizationId, name: null },
			metadata: { changedFields: saved.changedFields },
		});

		return {
			brandKit: {
				accentColors: saved.brandKit.accentColors,
				guidance: saved.brandKit.guidance,
				updatedAt: saved.brandKit.updatedAt,
			},
		};
	});
