import { getBoundPromptVersion } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const testProcedures = {
	render: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.PROMPT_UPDATE))
		.route({
			method: "POST",
			path: "/prompts/test/render",
			tags: ["Prompts"],
			summary: "Resolve and return bound prompt for preview",
		})
		.input(
			z.object({
				targetType: z.enum(["AGENT", "FEATURE"]),
				targetKey: z.string(),
				documentType: z.string().min(1, "Document type is required"), // Required
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

			const version = await getBoundPromptVersion({
				targetType: input.targetType,
				targetKey: input.targetKey,
				documentType: input.documentType, // Pass document type
				userId: user.id,
				organizationId,
			});
			return version ?? null;
		}),
};
