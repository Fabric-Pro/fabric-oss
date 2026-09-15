import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	activityUserName,
	buildGovernanceActivityCreate,
} from "../../lib/governance";

/**
 * AUTHORIZATION: `requireProjectPermission(PROJECT_GOVERNANCE_MANAGE)` —
 * project OWNER, org owner/admin. Editors and project admins cannot change
 * who approves stage transitions.
 *
 * Replaces the approver set. Every userId must be the project owner or an
 * accepted, non-expired ProjectMember; anything else is rejected as a whole
 * (no partial writes). The replacement and its governance audit row run in
 * one batch transaction.
 */
export const setStageApproversProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_GOVERNANCE_MANAGE))
	.route({
		method: "PUT",
		path: "/projects/:projectId/governance/stage-approvers",
		tags: ["Projects", "Governance"],
		summary: "Set stage approvers",
		description:
			"Replace the set of users who approve drafting-stage transitions",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			userIds: z.array(z.string().min(1)).max(50),
		}),
	)
	.handler(async ({ input, context }) => {
		const userIds = Array.from(new Set(input.userIds));

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { userId: true, organizationId: true, name: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		// Eligibility: owner or active member. Pending/expired rows do not count.
		const eligible = new Set<string>([project.userId]);
		if (userIds.length > 0) {
			const members = await db.projectMember.findMany({
				where: {
					projectId: input.projectId,
					userId: { in: userIds },
					acceptedAt: { not: null },
					OR: [
						{ expiresAt: null },
						{ expiresAt: { gt: new Date() } },
					],
				},
				select: { userId: true },
			});
			for (const member of members) {
				eligible.add(member.userId);
			}
		}
		const ineligible = userIds.filter((id) => !eligible.has(id));
		if (ineligible.length > 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: `${ineligible.length} selected user${ineligible.length === 1 ? " is" : "s are"} not the project owner or an accepted project member`,
			});
		}

		const existing = await db.projectStageApprover.findMany({
			where: { projectId: input.projectId },
			select: { userId: true },
		});
		const before = existing.map((row) => row.userId).sort();
		const after = [...userIds].sort();
		const changed =
			before.length !== after.length ||
			before.some((id, index) => id !== after[index]);

		if (changed) {
			await db.$transaction([
				db.projectStageApprover.deleteMany({
					where: {
						projectId: input.projectId,
						userId: { notIn: userIds },
					},
				}),
				...(userIds.length > 0
					? [
							db.projectStageApprover.createMany({
								data: userIds.map((userId) => ({
									projectId: input.projectId,
									userId,
								})),
								skipDuplicates: true,
							}),
						]
					: []),
				buildGovernanceActivityCreate({
					projectId: input.projectId,
					organizationId: project.organizationId ?? null,
					userId: context.user.id,
					userName: activityUserName(context.user),
					projectName: project.name,
					changed: { stageApprovers: { before, after } },
				}),
			]);
		}

		const approvers = await db.projectStageApprover.findMany({
			where: { projectId: input.projectId },
			orderBy: { createdAt: "asc" },
			select: {
				userId: true,
				createdAt: true,
				user: {
					select: { id: true, name: true, email: true, image: true },
				},
			},
		});

		return { approvers, changed };
	});
