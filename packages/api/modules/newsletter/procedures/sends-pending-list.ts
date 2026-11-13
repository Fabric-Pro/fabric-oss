import { ORPCError } from "@orpc/server";
import {
	db,
	listPendingApprovalSends,
	releaseStaleNewsletterCaptures,
} from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { presentReviewImage } from "../lib/review-images";

export const listPendingSendsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	// A read the review panel polls while a send is in flight; its name does
	// not look like one, so without this every poll lands in the activity log.
	.meta({ auditActivity: "never" })
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
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
		// A capture that stopped without a result shows as failed, not as
		// capturing forever.
		await releaseStaleNewsletterCaptures({ projectId: project.id });
		const sends = await listPendingApprovalSends(input.projectId);
		// One call gives the review panel everything: each image's object key is
		// swapped for a short-lived signed read URL.
		return {
			sends: await Promise.all(
				sends.map(async ({ images, ...send }) => ({
					...send,
					images: await Promise.all(images.map(presentReviewImage)),
				})),
			),
		};
	});
