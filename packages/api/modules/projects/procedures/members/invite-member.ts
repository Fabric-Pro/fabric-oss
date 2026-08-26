import { ORPCError } from "@orpc/client";
import {
	canInviteUser,
	createProjectInvitation,
	db,
	getProjectMemberRole,
	ProjectMemberRole,
} from "@repo/database";
import { ProjectMemberRoleSchema } from "@repo/database/prisma/zod";
import { sendEmail } from "@repo/mail";
import { getBaseUrl } from "@repo/utils";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const inviteMemberProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE))
	.route({
		method: "POST",
		path: "/projects/:projectId/members/invite",
		tags: ["Projects", "Members"],
		summary: "Invite member to project",
		description: "Invite a user to collaborate on a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			email: z.string().email(),
			role: ProjectMemberRoleSchema.default("VIEWER"),
			message: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		// Authorization is already enforced by the permission middleware above.
		// We still need to verify the project exists and run invite-specific
		// checks (already-member, already-invited).

		// Only OWNERs may invite a new member directly as OWNER. Mirrors the
		// guard in update-member-role.ts so a PROJECT_ADMIN cannot bypass the
		// UI gating by calling this procedure with role=OWNER.
		if (input.role === ProjectMemberRole.OWNER) {
			const actorRole = await getProjectMemberRole(
				input.projectId,
				user.id,
			);
			if (actorRole !== ProjectMemberRole.OWNER) {
				throw new ORPCError("FORBIDDEN", {
					message: "Only project owners can invite members as OWNER",
				});
			}
		}

		const canInvite = await canInviteUser(
			input.projectId,
			user.id,
			input.email,
		);

		if (!canInvite.canInvite) {
			throw new ORPCError("BAD_REQUEST", {
				message: canInvite.reason || "Cannot invite this user",
			});
		}

		// Get project name for the email body.
		const projectDetails = await db.project.findUnique({
			where: { id: input.projectId },
			select: { name: true },
		});

		// Create invitation
		const invitation = await createProjectInvitation({
			projectId: input.projectId,
			email: input.email,
			role: input.role,
			invitedBy: user.id,
			message: input.message,
		});

		// Public acceptance URL — works for external guests (no account yet,
		// or account in a different organization). The page handles sign-in /
		// sign-up with the invited email pre-filled.
		const baseUrl = getBaseUrl();
		const invitationUrl = `${baseUrl}/project-invitation/${invitation.id}`;

		await sendEmail({
			to: input.email,
			templateId: "projectInvitation",
			context: {
				url: invitationUrl,
				projectName: projectDetails?.name || "Unknown Project",
				inviterName: user.name || user.email,
				role: input.role.charAt(0) + input.role.slice(1).toLowerCase(),
				message: input.message,
			},
		});

		// Audit-log emission. The invitee may not yet have a User
		// row (external email invite), so `resourceId` is the invitation id
		// and `resourceName` is the invited email — the actual user link is
		// resolved later when they accept.
		const auditOrgId = resolveOrganizationId(undefined, context.session);
		recordAuditFromRequest(context, {
			action: "project.member.invited",
			category: "project",
			organizationId: auditOrgId,
			projectId: input.projectId,
			resource: {
				type: "invitation",
				id: invitation.id,
				name: input.email,
			},
			metadata: {
				role: input.role,
			},
		});

		return { invitation };
	});
