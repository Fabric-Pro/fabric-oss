import { ORPCError } from "@orpc/server";
import {
	getOrganizationInstructionTemplate,
	listInstructionTemplateCandidates,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../lib/membership";

/**
 * Get the project an organization offers as its template for coding
 * instructions, and the projects that may be named instead.
 *
 * Admin/owner only, like the write: the answer names a project, and a member
 * without access to that project has no reason to learn its name. A project's
 * own Coding Instructions tab asks `templateStatus` instead, which says only
 * whether a template is available.
 *
 * AUTHORIZATION: Requires organization admin or owner role.
 */
export const getOrganizationInstructionTemplateProcedure =
	tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_READ))
		.route({
			method: "GET",
			path: "/organizations/{organizationId}/instruction-template",
			tags: ["Organizations"],
			summary: "Get the organization template for coding instructions",
			description:
				"The project whose published coding instructions the organization's other projects can start from, or null, and every project whose instructions are uploaded to Fabric and so may be named instead.",
		})
		.input(
			z.object({
				organizationId: z.string(),
			}),
		)
		.output(
			z.object({
				projectId: z.string().nullable(),
				projectName: z.string().nullable(),
				/** The projects that may be named: upload mode, no move open. */
				candidates: z.array(
					z.object({
						id: z.string(),
						name: z.string(),
						published: z.boolean(),
					}),
				),
			}),
		)
		.handler(async ({ context: { user }, input: { organizationId } }) => {
			const membership = await requireOrgMembership(
				user.id,
				organizationId,
				["admin", "owner"],
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"You must be an admin or owner of this organization",
				});
			}

			const [template, candidates] = await Promise.all([
				getOrganizationInstructionTemplate(organizationId),
				listInstructionTemplateCandidates(organizationId),
			]);
			return {
				projectId: template?.projectId ?? null,
				projectName: template?.projectName ?? null,
				candidates,
			};
		});
