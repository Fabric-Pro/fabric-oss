import { ORPCError } from "@orpc/server";
import { getPromptById, updatePromptWithVersion } from "@repo/database";
import type { TemplateFormat } from "@repo/utils";
import { z } from "zod";
import { INPUT_BOUNDS, labelArray } from "../../..//lib/zod-bounds";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { announceDefaultChangeForWinningActions } from "../lib/announce-default-change";
import {
	assertSavablePromptContent,
	assertValidTemplate,
} from "../lib/assert-valid-template";

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
			"Update prompt metadata, optionally saving a new content version in the same request so a rename and a body edit either both land or both fail",
	})
	.input(
		z.object({
			id: z.string(),
			name: z.string().min(1).max(255).optional(),
			description: z.string().max(INPUT_BOUNDS.description).optional(),
			format: PromptFormatSchema.optional(),
			category: z.string().max(INPUT_BOUNDS.name).optional(),
			tags: labelArray().optional(),
			isPublic: z.boolean().optional(),
			content: z.string().max(INPUT_BOUNDS.text).optional(),
			changeNote: z.string().max(500).optional(),
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

		const effectiveFormat = (input.format ??
			existing.format) as TemplateFormat;

		if (input.content !== undefined) {
			// Validate the NEW body against the NEW format. This also fixes the
			// ordering bug a separate format-change check would have: editing the
			// format and the body in the same save must not validate the body
			// being replaced against the format it is leaving.
			assertSavablePromptContent(effectiveFormat, input.content);
		} else if (input.format && input.format !== existing.format) {
			// A format change re-interprets the CURRENT body without touching
			// it, so a working Handlebars prompt can silently become an
			// unrenderable Liquid one. `versions` comes back ordered
			// version-desc, so [0] is the latest.
			const latest = existing.versions?.[0];
			if (latest) {
				assertValidTemplate(effectiveFormat, latest.content);
			}
		}

		const { prompt, version } = await updatePromptWithVersion({
			id: input.id,
			name: input.name,
			description: input.description,
			format: input.format as any,
			category: input.category,
			tags: input.tags,
			isPublic: input.isPublic,
			updatedBy: user.id,
			content: input.content,
			changeNote: input.changeNote,
		});

		// FR6: a new version repoints this prompt's same-scope bindings, so
		// everyone subject to it starts running different text the moment it
		// saves — the same event as a new default being published, from the
		// reader's side. See `version.ts`, which announces the same way.
		if (version) {
			await announceDefaultChangeForWinningActions({
				promptId: input.id,
				scope: existing.scope,
				organizationId: existing.organizationId,
				promptVersionId: version.id,
				actorUserId: user.id,
			});
		}

		return { prompt, version };
	});
