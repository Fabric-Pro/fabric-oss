/**
 * Project-Conversation Attachment Procedures
 *
 * API procedures for attaching/detaching projects to orchestrator conversations.
 * AUTHORIZATION: Uses hasProjectAccess() for attach, conversation ownership verified in DB layer.
 */

import { ORPCError } from "@orpc/client";
import {
	attachProjectToConversation,
	detachProjectFromConversation,
	getConversationProject,
	hasProjectAccess,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Attach a project to a conversation.
 * AUTHORIZATION: Uses hasProjectAccess() - verifies org membership + project access
 */
export const attachProjectProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/conversations/attach",
		tags: ["Projects"],
		summary: "Attach project to conversation",
		description:
			"Attach a project to an orchestrator conversation for context",
	})
	.input(
		z.object({
			projectId: z.string(),
			conversationId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify project access
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			orgId ?? undefined,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "No access to this project",
			});
		}

		const result = await attachProjectToConversation({
			projectId: input.projectId,
			conversationId: input.conversationId,
			userId: context.user.id,
		});

		return { project: result.project };
	});

/**
 * Detach the project from a conversation.
 * AUTHORIZATION: Conversation ownership verified in DB layer
 */
export const detachProjectProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/conversations/detach",
		tags: ["Projects"],
		summary: "Detach project from conversation",
		description: "Remove the project attachment from a conversation",
	})
	.input(
		z.object({
			conversationId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		await detachProjectFromConversation({
			conversationId: input.conversationId,
			userId: context.user.id,
		});

		return { success: true };
	});

/**
 * Get the project attached to a conversation.
 * AUTHORIZATION: Returns project info for the conversation (no tenant filter needed - public project metadata)
 */
export const getConversationProjectProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/conversations/project",
		tags: ["Projects"],
		summary: "Get conversation project",
		description:
			"Get the project attached to a conversation, or null if none",
	})
	.input(
		z.object({
			conversationId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const result = await getConversationProject(input.conversationId);
		if (!result?.project) {
			return { project: null };
		}
		// Verify the user still has access to the attached project
		const canAccess = await hasProjectAccess(
			result.project.id,
			context.user.id,
			resolveOrganizationId(input.organizationId, context.session) ??
				undefined,
		);
		return { project: canAccess ? result.project : null };
	});
