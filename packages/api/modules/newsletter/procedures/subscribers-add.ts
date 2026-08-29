import { ORPCError } from "@orpc/server";
import { addNewsletterSubscriber, db } from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const addSubscribersProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			emails: z.array(z.string().email()).min(1).max(200),
			name: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// `requireProjectPermission` above has already authorized this caller for
		// THIS project — as owner, active ProjectMember, or via an org role. Load
		// the project by id and take the tenant from the loaded row;
		// `input.organizationId` is a guard, never a scoping key.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, organizationId: true, userId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		assertInputOrgMatchesProject(input.organizationId, project);

		const unique = Array.from(
			new Set(input.emails.map((e) => e.trim().toLowerCase())),
		);
		let added = 0;
		for (const email of unique) {
			await addNewsletterSubscriber({
				projectId: input.projectId,
				email,
				name: input.name ?? null,
				userId: project.organizationId ? null : project.userId,
				organizationId: project.organizationId ?? null,
				createdByUserId: context.user.id,
			});
			added += 1;
		}
		return { added };
	});
