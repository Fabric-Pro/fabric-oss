import { ORPCError } from "@orpc/server";
import {
	findInstructionTemplateCandidate,
	updateOrganizationInstructionTemplate,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../lib/membership";

/**
 * Name (or clear) the project an organization offers as its template for
 * coding instructions.
 *
 * The designation is the authority every copy rests on: a project that starts
 * from the template does not need access to the template project, so naming
 * one is an admin/owner decision. The project has to be a live project of this
 * organization whose instructions are uploaded to Fabric — a repository-backed
 * project's files belong to its repository, and nothing about copying them
 * would follow later commits.
 *
 * AUTHORIZATION: Requires organization admin or owner role.
 */
export const updateOrganizationInstructionTemplateProcedure =
	tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_UPDATE))
		.route({
			method: "PUT",
			path: "/organizations/{organizationId}/instruction-template",
			tags: ["Organizations"],
			summary: "Set the organization template for coding instructions",
			description:
				"Name one of the organization's projects as the template its other projects can start from. null clears it.",
		})
		.input(
			z.object({
				organizationId: z.string(),
				projectId: z.string().min(1).nullable(),
			}),
		)
		.output(
			z.object({
				success: z.boolean(),
				projectId: z.string().nullable(),
			}),
		)
		.handler(async ({ context, input: { organizationId, projectId } }) => {
			const membership = await requireOrgMembership(
				context.user.id,
				organizationId,
				["admin", "owner"],
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"You must be an admin or owner of this organization",
				});
			}

			if (projectId !== null) {
				const candidate = await findInstructionTemplateCandidate(
					projectId,
					organizationId,
				);
				if (!candidate) {
					throw new ORPCError("NOT_FOUND", {
						message: "That project is not in this organization",
					});
				}
				if (!candidate.eligible) {
					throw new ORPCError("PRECONDITION_FAILED", {
						message:
							"That project's coding instructions come from its repository. Choose a project whose instructions are uploaded to Fabric.",
					});
				}
			}

			const result = await updateOrganizationInstructionTemplate({
				organizationId,
				projectId,
			});

			recordAuditFromRequest(context, {
				action: "org.settings.updated",
				category: "org",
				organizationId,
				resource: {
					type: "organization",
					id: organizationId,
					name: null,
				},
				metadata: {
					setting: "instructionTemplateProjectId",
					value: result.projectId,
				},
			});

			return { success: true, projectId: result.projectId };
		});
