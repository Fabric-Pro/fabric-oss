/**
 * Pre-flight lookup for the invite dialog. Given a projectId + email, returns
 * a status describing what kind of invite will be issued so the UI can show
 * a contextual banner.
 *
 * Authorization is enforced by `requireProjectPermission(PROJECT_MEMBERS_READ)`
 * — only users who can view project members can probe invitation status.
 */

import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const lookupEmailStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/members/lookup-email",
		tags: ["Projects", "Members"],
		summary: "Look up invitation status for an email",
		description:
			"Returns whether an email belongs to an existing Fabric user, and whether inviting them to this project would create a same-org invite, a cross-org guest invite, or a sign-up-on-accept invite.",
	})
	.input(
		z.object({
			projectId: z.string(),
			email: z.string().email(),
		}),
	)
	.handler(async ({ input }) => {
		const normalizedEmail = input.email.trim().toLowerCase();

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { organizationId: true, userId: true },
		});

		const invitee = await db.user.findUnique({
			where: { email: normalizedEmail },
			select: { id: true },
		});

		// Already a project member?
		// Two cases to cover:
		//   - An explicit `ProjectMember` row exists.
		//   - The invitee IS the project's creator (`Project.userId`). The
		//     creator is not stored as a ProjectMember row, so the findFirst
		//     below would miss them.
		if (invitee) {
			if (project?.userId === invitee.id) {
				return { status: "already_member" as const, role: "OWNER" };
			}
			const existing = await db.projectMember.findFirst({
				where: {
					projectId: input.projectId,
					userId: invitee.id,
				},
				select: { role: true },
			});
			if (existing) {
				return {
					status: "already_member" as const,
					role: existing.role,
				};
			}
		}

		// Already has a pending invite?
		const pending = await db.projectInvitation.findFirst({
			where: {
				projectId: input.projectId,
				email: normalizedEmail,
				status: "PENDING",
				expiresAt: { gt: new Date() },
			},
			select: { role: true },
		});
		if (pending) {
			return { status: "already_invited" as const, role: pending.role };
		}

		// No Fabric account at all → sign-up-on-accept flow.
		if (!invitee) {
			return { status: "no_account" as const };
		}

		// User exists — are they a member of the host org?
		if (project?.organizationId) {
			const hostMembership = await db.member.findFirst({
				where: {
					organizationId: project.organizationId,
					userId: invitee.id,
				},
				select: { id: true },
			});
			if (hostMembership) {
				return { status: "org_member" as const };
			}
		}

		// User exists but is not in the host org → external guest invite.
		return { status: "other_org" as const };
	});
