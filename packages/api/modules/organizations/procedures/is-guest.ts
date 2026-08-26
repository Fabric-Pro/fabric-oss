/**
 * Returns whether the authenticated caller is a "guest" in the given
 * organization: they have at least one accepted ProjectMember row on a
 * project in the org but no OrganizationMember row in the org itself.
 *
 * Used by the frontend NavBar to hide org-scoped chrome (settings, billing,
 * integrations, etc.) when the current user is only a project guest.
 *
 * Uses `protectedProcedure` (not tenant/permission-gated) because a guest —
 * by definition — does not have an active org membership in the host org and
 * would fail any permission check against that org. The procedure only
 * reads metadata about the caller's own access and reveals no sensitive data.
 * Exempted from permission-coverage.test via the explicit allowlist.
 */

import { db } from "@repo/database";
import { z } from "zod";
import { protectedProcedure } from "../../../orpc/procedures";

export const isGuestInOrgProcedure = protectedProcedure
	.route({
		method: "GET",
		path: "/organizations/:organizationId/is-guest",
		tags: ["Organizations"],
		summary: "Check whether the caller is a guest in an organization",
	})
	.input(
		z.object({
			organizationId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;

		const [orgMembership, projectMembership] = await Promise.all([
			db.member.findFirst({
				where: {
					organizationId: input.organizationId,
					userId,
				},
				select: { id: true },
			}),
			db.projectMember.findFirst({
				where: {
					userId,
					acceptedAt: { not: null },
					OR: [
						{ expiresAt: null },
						{ expiresAt: { gt: new Date() } },
					],
					project: { organizationId: input.organizationId },
				},
				select: { id: true },
			}),
		]);

		return {
			isGuest: !orgMembership && !!projectMembership,
			isOrgMember: !!orgMembership,
		};
	});
