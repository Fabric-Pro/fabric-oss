import { ORPCError } from "@orpc/server";
import { createPrompt } from "@repo/database";
import type { TemplateFormat } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
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

const PromptScopeSchema = z.enum(["SYSTEM", "ORG", "USER"]);

export const createProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROMPT_CREATE))
	.route({
		method: "POST",
		path: "/prompts",
		tags: ["Prompts"],
		summary: "Create a new prompt",
		description:
			"Create a new prompt (admin for system-level, org admin for org-level, any user for user-level)",
	})
	.input(
		z.object({
			key: z.string().min(1).max(255),
			name: z.string().min(1).max(255),
			description: z.string().optional(),
			scope: PromptScopeSchema,
			organizationId: z.string().nullable().optional(),
			format: PromptFormatSchema.default("PLAIN_TEXT"),
			category: z.string().optional(),
			tags: z.array(z.string()).default([]),
			isPublic: z.boolean().default(false),
			initialContent: z.string().optional(),
			initialVariables: z.record(z.string(), z.any()).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// A body that cannot render under its own format is rejected here rather
		// than at generation time, where it is a log line nobody is watching.
		if (input.initialContent) {
			assertValidTemplate(
				input.format as TemplateFormat,
				input.initialContent,
			);
		}

		// Authorization checks
		if (input.scope === "SYSTEM") {
			// Only admins can create system prompts
			if (user.role !== "admin") {
				throw new ORPCError("FORBIDDEN", {
					message: "Only administrators can create system prompts",
				});
			}
		} else if (input.scope === "ORG") {
			// Verify organization membership and admin role
			if (!organizationId) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Organization ID is required for organization-scoped prompts",
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

			if (membership.role !== "admin" && membership.role !== "owner") {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Only organization admins can create organization prompts",
				});
			}
		}
		// USER scope - any authenticated user can create

		const prompt = await createPrompt({
			key: input.key,
			name: input.name,
			description: input.description,
			scope: input.scope as any,
			userId: input.scope === "USER" ? user.id : undefined,
			organizationId: input.scope === "ORG" ? organizationId : undefined,
			format: input.format as any,
			category: input.category,
			tags: input.tags,
			isPublic: input.isPublic,
			createdBy: user.id,
			initialContent: input.initialContent,
			initialVariables: input.initialVariables,
		});

		return { prompt };
	});
