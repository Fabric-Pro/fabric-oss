import { ORPCError } from "@orpc/client";
import { db, listPromptCatalog } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const catalogProcedures = {
	/**
	 * Every action the caller can see, with the prompts bound to each and which
	 * tier is in force.
	 *
	 * Precedence is resolved server-side rather than returning raw rows for the
	 * client to rank. The ranking rule already exists in two places that must
	 * agree with the runtime resolver; a third copy in the browser is how a
	 * catalog ends up confidently naming a prompt the agent does not run.
	 */
	list: tenantProtectedProcedure
		.use(requirePermission(Permissions.PROMPT_READ))
		.route({
			method: "GET",
			path: "/prompts/catalog",
			tags: ["Prompts"],
			summary:
				"List every prompt action with its bound prompts and effective tier",
		})
		.input(
			z.object({
				organizationId: z.string().nullable().optional(),
				/** Include PROJECT-tier bindings for this project, which can then be
				 *  the tier in force. Must belong to the organization. */
				projectId: z.string().nullable().optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const user = context.user;
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			let projectId: string | null = null;
			if (input.projectId) {
				if (!organizationId) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"A project scope applies only inside an organization",
					});
				}
				const project = await db.project.findFirst({
					where: { id: input.projectId, deletedAt: null },
					select: { id: true, organizationId: true },
				});
				if (!project || project.organizationId !== organizationId) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"That project does not belong to this organization",
					});
				}
				projectId = project.id;
			}

			if (organizationId) {
				const membership = await verifyOrganizationMembership(
					organizationId,
					user.id,
				);

				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}
			}

			const entries = await listPromptCatalog({
				userId: user.id,
				organizationId: organizationId ?? undefined,
				projectId,
			});

			return { entries };
		}),
};
