/**
 * Resolve a work item's context-only attachments into rag-context entries for
 * the AI Feature Assistant.
 *
 * RESPONSIBILITY:
 *   The web client (StoryWorkspace) calls this with the story identity and
 *   merges the returned strings into the agent's `ragContexts`, alongside the
 *   image entries from `resolve-story-media-for-agent`. The extraction,
 *   budgeting, and envelope construction all happen in the shared resolver at
 *   `../../lib/story-attachment-ai-context`; this procedure is authorization
 *   plus transport.
 *
 * WHY A PROCEDURE (not an agent-direct call):
 *   Same reason as its sibling `resolve-story-media-for-agent`. Agents are
 *   stateless — `agents/langchain/project-document-generator`'s package.json
 *   deliberately omits `@repo/database`, `@repo/storage`, and `@repo/config` so
 *   an agent cannot bypass tenant boundaries. Reaching the attachment rows from
 *   inside the agent would cross that line and break its tsup build besides.
 *   The web tier already holds authenticated session context, so it does the
 *   fetching and hands the agent finished strings.
 *
 * AUTHORIZATION:
 *   `requireInputOrgPermission(STORY_UPDATE)` and
 *   `requireProjectPermission(STORY_UPDATE)`, then the same three body-level
 *   layers the media resolver applies — and for the same reasons, since this
 *   returns document text rather than image bytes and is therefore no less
 *   sensitive:
 *     1. `hasProjectAccess` — user/org membership in the project.
 *     2. `getStoryById(storyId, projectId)` — XOR tenant gate confirming the
 *        story actually belongs to the project.
 *     3. Explicit org-context check — `hasProjectAccess` ignores its
 *        organizationId argument, so without this a user could chat under org B
 *        with a forged project id from org A (where they are also a member) and
 *        exfiltrate org A's attachment text.
 *
 *   `requireInputOrgPermission` is the layer the media resolver predates and
 *   the SOC 2 input-org ratchet now requires. It closes the remaining gap in
 *   the three above: they prove the project belongs to the claimed org, but not
 *   that the CALLER holds the permission IN that org. `resolveOrganizationId`
 *   hands back the client's string unexamined, so without this middleware a
 *   caller with project access could name an organization they do not belong
 *   to. Every layer here is load-bearing; none is defensive duplication.
 *
 * WHAT IT WILL NOT RETURN:
 *   LOCKED attachments, soft-deleted rows, and anything whose type carries no
 *   extractable text. Those gates live in the shared resolver so this surface
 *   and the maturation surface cannot disagree about them.
 */

import { ORPCError } from "@orpc/client";
import { db, getStoryById, hasProjectAccess } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { resolveStoryAttachmentAiContexts } from "../../lib/story-attachment-ai-context";

export const resolveStoryAttachmentContextForAgentProcedure =
	tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.STORY_UPDATE))
		.use(requireProjectPermission(Permissions.STORY_UPDATE))
		.route({
			method: "POST",
			path: "/projects/:projectId/stories/:storyId/attachments/resolve-for-agent",
			tags: ["Projects", "Stories", "Attachments"],
			summary:
				"Resolve context-only attachment text for the AI Assistant",
			description:
				"Resolve a work item's context-only (UNLOCKED) text attachments into rag-context entries for injection via ragContexts.",
		})
		.input(
			z.object({
				projectId: z.string(),
				userStoryId: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const { projectId, userStoryId } = input;
			const user = context.user;

			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			// 1. user → project membership.
			const hasAccess = await hasProjectAccess(
				projectId,
				user.id,
				organizationId ?? undefined,
			);
			if (!hasAccess) {
				logger.warn({
					event: "feature_assistant_attachment_context_authz_denied",
					reason: "no_project_access",
				});
				throw new ORPCError("FORBIDDEN", {
					message: "You don't have access to this project",
				});
			}

			// 2. Story exists in this project (XOR tenant gate).
			const story = await getStoryById(userStoryId, projectId);
			if (!story) {
				logger.warn({
					event: "feature_assistant_attachment_context_authz_denied",
					reason: "story_not_in_project",
				});
				throw new ORPCError("NOT_FOUND", {
					message: "Story not found in this project",
				});
			}

			// 3. Org-context match — see the AUTHORIZATION note above.
			const resolvedOrg = organizationId ?? null;
			const project = await db.project.findUnique({
				where: { id: projectId },
				select: { organizationId: true },
			});
			if (!project || project.organizationId !== resolvedOrg) {
				logger.warn({
					event: "feature_assistant_attachment_context_authz_denied",
					reason: "org_context_mismatch",
				});
				throw new ORPCError("FORBIDDEN", {
					message: "You don't have access to this project",
				});
			}

			const contexts = await resolveStoryAttachmentAiContexts(
				userStoryId,
				{
					userId: user.id,
					organizationId: resolvedOrg,
				},
			);

			return { contexts };
		});
