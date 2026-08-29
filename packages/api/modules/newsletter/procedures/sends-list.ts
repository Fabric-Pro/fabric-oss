import { ORPCError } from "@orpc/server";
import { countNewsletterSends, db, listNewsletterSends } from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const listSendsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			limit: z
				.union([z.literal(15), z.literal(50), z.literal(100)])
				.default(15),
			offset: z.number().int().min(0).default(0),
			status: z.enum(["all", "sent", "failed", "skipped"]).default("all"),
		}),
	)
	.handler(async ({ input }) => {
		// `requireProjectPermission` above has already authorized this caller for
		// THIS project — as owner, active ProjectMember, or via an org role. Load
		// the project by id and take the tenant from the loaded row;
		// `input.organizationId` is a guard, never a scoping key.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		assertInputOrgMatchesProject(input.organizationId, project);
		const [sends, total] = await Promise.all([
			listNewsletterSends(input.projectId, {
				limit: input.limit,
				offset: input.offset,
				status: input.status,
			}),
			countNewsletterSends(input.projectId, input.status),
		]);
		return { sends, total };
	});
