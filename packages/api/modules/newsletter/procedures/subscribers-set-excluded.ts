import { ORPCError } from "@orpc/server";
import { db, setOrganizationSubscriberExcluded } from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const setSubscriberExcludedProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			id: z.string(),
			excluded: z.boolean(),
		}),
	)
	.handler(async ({ input }) => {
		// `requireProjectPermission` above has already authorized this caller for
		// THIS project; `input.organizationId` is a guard, never a scoping key.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		assertInputOrgMatchesProject(input.organizationId, project);
		const { count } = await setOrganizationSubscriberExcluded(
			input.projectId,
			input.id,
			input.excluded,
		);
		if (count === 0) {
			throw new ORPCError("NOT_FOUND", {
				message: "Organization subscriber not found",
			});
		}
		return { success: true };
	});
