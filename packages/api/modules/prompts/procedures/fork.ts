import { ORPCError } from "@orpc/client";
import { forkPrompt, getPromptById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const forkProcedures = {
	fork: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.PROMPT_UPDATE))
		.route({
			method: "POST",
			path: "/prompts/fork",
			tags: ["Prompts"],
			summary: "Fork a system prompt to USER or ORG scope",
		})
		.input(
			z.object({
				sourcePromptId: z.string(),
				targetScope: z.enum(["USER", "ORG"]),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const user = context.user;
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			// TENANT ISOLATION (SOC 2 CC6.1): forkPrompt loads the source by id
			// with no tenant scope. Verify the caller may actually read it
			// (SYSTEM, their own USER prompt, or an org they belong to) before
			// copying its content into a new prompt.
			const source = await getPromptById(input.sourcePromptId, {
				userId: user.id,
				organizationId,
			});
			if (!source) {
				throw new ORPCError("NOT_FOUND", {
					message: "Source prompt not found",
				});
			}

			// Forking to ORG scope creates organization-owned content, which is
			// the same act `create` gates on org admin — reading a system prompt
			// and copying it is not authority to publish into the organization.
			// Being able to READ the source says nothing about that: every
			// member can read a SYSTEM prompt, which is the usual source here.
			if (input.targetScope === "ORG") {
				if (!organizationId) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Organization ID is required to fork a prompt to organization scope",
					});
				}

				const membership = await verifyOrganizationMembership(
					organizationId,
					user.id,
				);

				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}

				if (
					membership.role !== "admin" &&
					membership.role !== "owner"
				) {
					throw new ORPCError("FORBIDDEN", {
						message:
							"Only organization admins can fork a prompt to organization scope",
					});
				}
			}

			const prompt = await forkPrompt({
				sourcePromptId: input.sourcePromptId,
				targetScope: input.targetScope,
				userId: user.id,
				organizationId:
					input.targetScope === "ORG" ? organizationId : undefined,
			});
			return prompt;
		}),
};
