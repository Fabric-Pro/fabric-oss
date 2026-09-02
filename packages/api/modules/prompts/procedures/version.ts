import { ORPCError } from "@orpc/server";
import { createPromptVersion, getPromptById } from "@repo/database";
import type { TemplateFormat } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { announceDefaultChangeForWinningActions } from "../lib/announce-default-change";
import { assertValidTemplate } from "../lib/assert-valid-template";

export const versionProcedures = {
	create: tenantProtectedProcedure
		.use(requirePermission(Permissions.PROMPT_CREATE))
		.route({
			method: "POST",
			path: "/prompts/:id/versions",
			tags: ["Prompts"],
			summary: "Create a new prompt version",
		})
		.input(
			z.object({
				id: z.string(),
				content: z.string().min(1),
				variables: z.record(z.string(), z.any()).optional(),
				changeNote: z.string().max(500).optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const user = context.user;

			const prompt = await getPromptById(input.id);
			if (!prompt) {
				throw new ORPCError("NOT_FOUND", {
					message: "Prompt not found",
				});
			}

			// Authorization: same rules as updating the prompt itself, because
			// a new version replaces the latest rendered content.
			if (prompt.scope === "SYSTEM") {
				if (user.role !== "admin") {
					throw new ORPCError("FORBIDDEN", {
						message:
							"Only administrators can create versions of system prompts",
					});
				}
			} else if (prompt.scope === "ORG") {
				if (!prompt.organizationId) {
					throw new ORPCError("INTERNAL_SERVER_ERROR", {
						message: "Organization prompt missing organization ID",
					});
				}
				const membership = await verifyOrganizationMembership(
					prompt.organizationId,
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
							"Only organization admins can create versions of organization prompts",
					});
				}
			} else if (prompt.scope === "USER") {
				if (prompt.userId !== user.id) {
					throw new ORPCError("FORBIDDEN", {
						message: "You can only version your own prompts",
					});
				}
			}

			// The body must render under the format the prompt row declares —
			// content and format live on different rows, so they can drift apart.
			assertValidTemplate(prompt.format as TemplateFormat, input.content);

			const version = await createPromptVersion({
				promptId: input.id,
				content: input.content,
				variables: input.variables,
				changeNote: input.changeNote,
				createdBy: user.id,
			});

			// FR6, the half that binding alone does not cover: `createPromptVersion`
			// repoints this prompt's same-scope bindings at the new version, so
			// everyone subject to it starts running different text the moment it
			// saves. Publishing a prompt and editing a published one are the same
			// event from the reader's side, and both have to announce.
			await announceDefaultChangeForWinningActions({
				promptId: input.id,
				scope: prompt.scope,
				organizationId: prompt.organizationId,
				promptVersionId: version.id,
				actorUserId: user.id,
			});

			return version;
		}),
};
