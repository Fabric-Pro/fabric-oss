import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	buildCustomerOutcomes,
	buildOutcomesShareUrl,
} from "../../../outcomes/lib/customer-outcomes";

/**
 * AUTHORIZATION: `requireProjectPermission(PROJECT_READ)`. In-app preview of
 * exactly what the customer would see, plus publish state. The share URL is
 * returned to any reader because the link is already visible in the
 * project's share dialog; creating or revoking it stays governance-only.
 */
export const getOutcomesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/outcomes",
		tags: ["Projects", "Outcomes"],
		summary: "Preview customer outcomes page",
		description:
			"The restricted customer outcomes DTO for this project and whether it is published",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { outcomesShareToken: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		const preview = await buildCustomerOutcomes(input.projectId);
		if (!preview) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		const token = project.outcomesShareToken;
		return {
			published: token !== null,
			shareUrl: token ? buildOutcomesShareUrl(token) : null,
			preview,
		};
	});
