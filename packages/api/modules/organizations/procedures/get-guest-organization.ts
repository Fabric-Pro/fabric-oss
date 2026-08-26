/**
 * Returns a minimal organization record by slug for a signed-in user who
 * is a project-scoped guest in that organization. Better Auth's
 * `getFullOrganization` requires an OrganizationMember row, so guests
 * cannot use that endpoint. The frontend's ActiveOrganizationProvider
 * falls back to this procedure when the Better Auth call fails, so the
 * NavBar's guest hook can detect host-org context and render the
 * trimmed nav.
 *
 * Exempted from permission-coverage.test via the explicit allowlist —
 * there is no meaningful permission check here beyond "caller is a
 * guest in this org", and the response carries no tenant data.
 */

import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import { protectedProcedure } from "../../../orpc/procedures";

export const getGuestOrganizationProcedure = protectedProcedure
	.route({
		method: "GET",
		path: "/organizations/guest-org/:slug",
		tags: ["Organizations"],
		summary:
			"Get a thin organization record for a signed-in project-scoped guest",
	})
	.input(
		z.object({
			slug: z.string().min(1).max(255),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		// Do NOT select `metadata` — it is free-form JSON and may hold
		// internal org flags that should not leak to guests. The NavBar
		// and guest landing experience only need identification fields.
		const org = await db.organization.findUnique({
			where: { slug: input.slug },
			select: {
				id: true,
				slug: true,
				name: true,
				logo: true,
				createdAt: true,
			},
		});
		if (!org) {
			throw new ORPCError("NOT_FOUND");
		}

		const [orgMembership, projectMembership] = await Promise.all([
			db.member.findFirst({
				where: { organizationId: org.id, userId },
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
					project: { organizationId: org.id },
				},
				select: { id: true },
			}),
		]);

		// Full org members should use the Better Auth endpoint — reject here
		// so the client's fallback only activates for real guest cases.
		if (orgMembership || !projectMembership) {
			throw new ORPCError("NOT_FOUND");
		}

		return {
			...org,
			// Shim the shape expected by consumers of `getFullOrganization`
			// so the ActiveOrganizationContext can accept it without further
			// adaptation.
			members: [] as Array<{
				id: string;
				userId: string;
				role: string;
				createdAt: Date;
				user: { email: string; name: string; image?: string };
			}>,
			invitations: [] as Array<{
				id: string;
				email: string;
				role: string;
				status: string;
				expiresAt: Date;
				organizationId: string;
				inviterId: string;
				createdAt: Date;
			}>,
		};
	});
