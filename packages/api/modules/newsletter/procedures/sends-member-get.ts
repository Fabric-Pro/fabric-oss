import { ORPCError } from "@orpc/server";
import { db, getNewsletterSendForMembers } from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

// One Release Notes row for the chat teaser's deep link — the linked note may
// be past the first page of `memberList`. Same gate and projection as memberList.
export const memberGetSendProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			sendId: z.string(),
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
		const send = await getNewsletterSendForMembers(
			input.projectId,
			input.sendId,
		);
		if (!send) {
			throw new ORPCError("NOT_FOUND", {
				message: "Release note not found",
			});
		}
		return send;
	});
