import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../lib/membership";

/**
 * Search organization members for @mentions autocomplete.
 *
 * AUTHORIZATION: Uses verifyOrganizationMembership() — verifies org membership.
 * Returns empty array when called in personal context (no organizationId).
 */
export const searchMembersProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_MEMBERS_READ))
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/search-members",
		tags: ["Organizations"],
		summary: "Search organization members",
		description: "Search organization members for @mentions autocomplete",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			query: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { organizationId, query } = input;
		const user = context.user;

		if (!organizationId) {
			return { members: [] };
		}

		const membership = await verifyOrganizationMembership(
			organizationId,
			user.id,
		);
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You are not a member of this organization",
			});
		}

		const normalizedQuery = query.toLowerCase();

		const members = await db.member.findMany({
			where: {
				organizationId,
				OR: [
					{
						user: {
							name: {
								contains: normalizedQuery,
								mode: "insensitive",
							},
						},
					},
					{
						user: {
							email: {
								contains: normalizedQuery,
								mode: "insensitive",
							},
						},
					},
				],
			},
			take: 10,
			include: {
				user: {
					select: {
						id: true,
						name: true,
						email: true,
						image: true,
					},
				},
			},
		});

		return {
			members: members.map((member) => ({
				id: member.user.id,
				name: member.user.name,
				email: member.user.email,
				avatarUrl: member.user.image,
				role: member.role,
			})),
		};
	});
