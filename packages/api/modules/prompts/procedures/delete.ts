import { ORPCError } from "@orpc/server";
import { deletePrompt, getPromptById } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const deleteProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROMPT_DELETE))
	.route({
		method: "DELETE",
		path: "/prompts/:id",
		tags: ["Prompts"],
		summary: "Delete a prompt",
		description: "Delete a prompt (with authorization checks)",
	})
	.input(
		z.object({
			id: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// Get existing prompt
		const existing = await getPromptById(input.id);

		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "Prompt not found",
			});
		}

		// Authorization checks
		if (existing.scope === "SYSTEM") {
			// Only admins can delete system prompts
			if (user.role !== "admin") {
				throw new ORPCError("FORBIDDEN", {
					message: "Only administrators can delete system prompts",
				});
			}
		} else if (existing.scope === "ORG") {
			// Verify organization membership and admin role
			if (!existing.organizationId) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "Organization prompt missing organization ID",
				});
			}

			const membership = await verifyOrganizationMembership(
				existing.organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}

			if (membership.role !== "admin" && membership.role !== "owner") {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Only organization admins can delete organization prompts",
				});
			}
		} else if (existing.scope === "USER") {
			// Only the owner can delete user prompts
			if (existing.userId !== user.id) {
				throw new ORPCError("FORBIDDEN", {
					message: "You can only delete your own prompts",
				});
			}
		}

		try {
			await deletePrompt(input.id);
			return { success: true };
		} catch (error) {
			if (error instanceof ORPCError) {
				throw error;
			}
			const message =
				error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : undefined;
			logger.error("[prompts.delete] Error deleting prompt", {
				promptId: input.id,
				userId: user.id,
				error: message,
				stack,
			});
			if (process.env.NODE_ENV === "development") {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: `Failed to delete prompt: ${message}`,
				});
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to delete prompt",
			});
		}
	});
