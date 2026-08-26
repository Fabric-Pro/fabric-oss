import { ORPCError } from "@orpc/server";
import { getPromptById, updatePrompt } from "@repo/database";
import type { TemplateFormat } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { assertValidTemplate } from "../lib/assert-valid-template";

const PromptFormatSchema = z.enum([
	"PLAIN_TEXT",
	"MARKDOWN",
	"HANDLEBARS",
	"MUSTACHE",
	"LIQUID",
	"JINJA2",
]);

export const updateProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROMPT_UPDATE))
	.route({
		method: "PATCH",
		path: "/prompts/:id",
		tags: ["Prompts"],
		summary: "Update a prompt",
		description:
			"Update prompt metadata (not content - use version creation for that)",
	})
	.input(
		z.object({
			id: z.string(),
			name: z.string().min(1).max(255).optional(),
			description: z.string().optional(),
			format: PromptFormatSchema.optional(),
			category: z.string().optional(),
			tags: z.array(z.string()).optional(),
			isPublic: z.boolean().optional(),
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
			// Only admins can update system prompts
			if (user.role !== "admin") {
				throw new ORPCError("FORBIDDEN", {
					message: "Only administrators can update system prompts",
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
						"Only organization admins can update organization prompts",
				});
			}
		} else if (existing.scope === "USER") {
			// Only the owner can update user prompts
			if (existing.userId !== user.id) {
				throw new ORPCError("FORBIDDEN", {
					message: "You can only update your own prompts",
				});
			}
		}

		// A format change re-interprets the CURRENT body without touching it, so
		// a working Handlebars prompt can silently become an unrenderable Liquid
		// one. `versions` comes back ordered version-desc, so [0] is the latest.
		if (input.format && input.format !== existing.format) {
			const latest = existing.versions?.[0];
			if (latest) {
				assertValidTemplate(
					input.format as TemplateFormat,
					latest.content,
				);
			}
		}

		const prompt = await updatePrompt({
			id: input.id,
			name: input.name,
			description: input.description,
			format: input.format as any,
			category: input.category,
			tags: input.tags,
			isPublic: input.isPublic,
			updatedBy: user.id,
		});

		return { prompt };
	});
