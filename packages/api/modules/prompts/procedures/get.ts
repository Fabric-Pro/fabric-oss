import { ORPCError } from "@orpc/server";
import { getPromptById } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const getProcedures = {
	byId: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.PROMPT_READ))
		.route({
			method: "GET",
			path: "/prompts/:id",
			tags: ["Prompts"],
			summary: "Get a prompt with versions",
		})
		.input(
			z.object({
				id: z.string(),
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

			try {
				// Use tenant-filtered query - access control is now handled at query level
				const prompt = await getPromptById(input.id, {
					userId: user.id,
					organizationId: organizationId ?? undefined,
				});

				if (!prompt) {
					throw new ORPCError("NOT_FOUND", {
						message: "Prompt not found",
					});
				}

				return prompt;
			} catch (error) {
				if (error instanceof ORPCError) {
					throw error;
				}
				const message =
					error instanceof Error ? error.message : String(error);
				const stack = error instanceof Error ? error.stack : undefined;
				logger.error("[prompts.get.byId] Error fetching prompt", {
					promptId: input.id,
					userId: user.id,
					error: message,
					stack,
				});
				if (process.env.NODE_ENV === "development") {
					throw new ORPCError("INTERNAL_SERVER_ERROR", {
						message: `Failed to fetch prompt: ${message}`,
					});
				}
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "Failed to fetch prompt",
				});
			}
		}),
};
