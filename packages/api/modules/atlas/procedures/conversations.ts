/**
 * Persistent chat conversations for the Atlas feature
 * (list / create / get / update / delete). Every procedure is a thin delegate
 * to `AtlasService`; the SHARED-vs-PRIVATE visibility floor and
 * owner-only mutation rules are enforced inside the facade/queries layer. The
 * procedure layer only adds tenant resolution + project-membership scoping
 * (`requireProjectPermission`) + the feature gate.
 */
import {
	AtlasService,
	createConversationInputSchema,
	deleteConversationInputSchema,
	getConversationInputSchema,
	listConversationsInputSchema,
	updateConversationInputSchema,
} from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/** Conversations the caller may see (own + SHARED) for a project's repo. */
export const listConversationsProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/projects/:projectId/atlas/conversations",
		tags: ["Atlas"],
		summary: "List codebase-chat conversations (own + shared)",
	})
	.input(listConversationsInputSchema)
	.handler(async ({ input, context }) => {
		assertAtlasEnabled();
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;
		const service = new AtlasService({
			userId: context.user.id,
			organizationId,
		});
		try {
			// Returns { conversations, total } — total drives the history view's
			// "X conversations" label and the "Show more" affordance.
			return await service.listConversations({
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId ?? null,
				limit: input.limit,
				offset: input.offset,
				isSystemScope: input.isSystemScope,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});

/** Create a new (empty) conversation. */
export const createConversationProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/conversations",
		tags: ["Atlas"],
		summary: "Create a codebase-chat conversation",
	})
	.input(createConversationInputSchema)
	.handler(async ({ input, context }) => {
		assertAtlasEnabled();
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;
		const service = new AtlasService({
			userId: context.user.id,
			organizationId,
		});
		try {
			return await service.createConversation({
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId ?? null,
				title: input.title,
				visibility: input.visibility,
				isSystemScope: input.isSystemScope,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});

/** Get a single conversation incl. messages (owner OR shared). */
export const getConversationProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/projects/:projectId/atlas/conversations/:conversationId",
		tags: ["Atlas"],
		summary: "Get a codebase-chat conversation with its messages",
	})
	.input(getConversationInputSchema)
	.handler(async ({ input, context }) => {
		assertAtlasEnabled();
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;
		const service = new AtlasService({
			userId: context.user.id,
			organizationId,
		});
		try {
			return await service.getConversation({
				conversationId: input.conversationId,
				projectId: input.projectId,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});

/** Rename / re-scope a conversation (owner only). */
export const updateConversationProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "PATCH",
		path: "/projects/:projectId/atlas/conversations/:conversationId",
		tags: ["Atlas"],
		summary: "Update a conversation's title or visibility (owner only)",
	})
	.input(updateConversationInputSchema)
	.handler(async ({ input, context }) => {
		assertAtlasEnabled();
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;
		const service = new AtlasService({
			userId: context.user.id,
			organizationId,
		});
		try {
			return await service.updateConversation({
				conversationId: input.conversationId,
				projectId: input.projectId,
				title: input.title,
				visibility: input.visibility,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});

/** Delete a conversation (owner only). */
export const deleteConversationProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "DELETE",
		path: "/projects/:projectId/atlas/conversations/:conversationId",
		tags: ["Atlas"],
		summary: "Delete a conversation (owner only)",
	})
	.input(deleteConversationInputSchema)
	.handler(async ({ input, context }) => {
		assertAtlasEnabled();
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;
		const service = new AtlasService({
			userId: context.user.id,
			organizationId,
		});
		try {
			return await service.deleteConversation({
				conversationId: input.conversationId,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
