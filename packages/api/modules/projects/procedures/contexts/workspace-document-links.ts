import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { resolveBoundOrganization } from "../../../../lib/authorized-project-binding";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	addWorkspaceLinkSchema,
	readWorkspaceLinkSchema,
	WorkspaceLinkError,
	workspaceDocumentLinkCommands,
	workspaceLinkIdSchema,
	workspaceLinkPageSchema,
} from "../../lib/workspace-document-links";

const scope = {
	projectId: z.string().trim().min(1).max(128),
	organizationId: z.string().trim().min(1).max(128).optional(),
};
function failure(error: unknown): never {
	const errorSafe =
		error instanceof WorkspaceLinkError
			? error
			: new WorkspaceLinkError("UNAVAILABLE");
	throw new ORPCError(
		errorSafe.status === 400
			? "BAD_REQUEST"
			: errorSafe.status === 403
				? "FORBIDDEN"
				: errorSafe.status === 404
					? "NOT_FOUND"
					: errorSafe.status === 409
						? "CONFLICT"
						: "SERVICE_UNAVAILABLE",
		{ message: errorSafe.message, data: { code: errorSafe.code } },
	);
}
const read = tenantProtectedProcedure.use(
	requireProjectPermission(Permissions.CONTEXT_READ),
);
const write = tenantProtectedProcedure.use(
	requireProjectPermission(Permissions.CONTEXT_CREATE),
);
const remove = tenantProtectedProcedure.use(
	requireProjectPermission(Permissions.CONTEXT_DELETE),
);
function actor(
	projectId: string,
	bound: ReturnType<typeof resolveBoundOrganization>,
	userId: string,
) {
	if (!bound.bound) {
		throw new ORPCError("FORBIDDEN", {
			message: "An authorized organization project is required.",
		});
	}
	return {
		userId,
		organizationId: bound.organizationId,
		projectId,
	};
}
export const listWorkspaceDocumentLinksProcedure = read
	.input(workspaceLinkPageSchema.extend(scope))
	.handler(async ({ input, context }) => {
		context.resHeaders?.set("Cache-Control", "private, no-store");
		try {
			return await (await workspaceDocumentLinkCommands()).list(
				actor(
					input.projectId,
					resolveBoundOrganization(input.organizationId),
					context.user.id,
				),
				{ limit: input.limit, offset: input.offset },
			);
		} catch (error) {
			failure(error);
		}
	});
export const addWorkspaceDocumentLinkProcedure = write
	.input(addWorkspaceLinkSchema.extend(scope))
	.handler(async ({ input, context }) => {
		context.resHeaders?.set("Cache-Control", "private, no-store");
		try {
			return await (await workspaceDocumentLinkCommands()).add(
				actor(
					input.projectId,
					resolveBoundOrganization(input.organizationId),
					context.user.id,
				),
				{
					workspaceId: input.workspaceId,
					documentId: input.documentId,
					expectedRevision: input.expectedRevision,
				},
			);
		} catch (error) {
			failure(error);
		}
	});
export const removeWorkspaceDocumentLinkProcedure = remove
	.input(workspaceLinkIdSchema.extend(scope))
	.handler(async ({ input, context }) => {
		context.resHeaders?.set("Cache-Control", "private, no-store");
		try {
			return await (await workspaceDocumentLinkCommands()).remove(
				actor(
					input.projectId,
					resolveBoundOrganization(input.organizationId),
					context.user.id,
				),
				{ linkId: input.linkId },
			);
		} catch (error) {
			failure(error);
		}
	});
export const readWorkspaceDocumentLinkProcedure = read
	.input(readWorkspaceLinkSchema.extend(scope))
	.handler(async ({ input, context }) => {
		context.resHeaders?.set("Cache-Control", "private, no-store");
		try {
			return await (await workspaceDocumentLinkCommands()).read(
				actor(
					input.projectId,
					resolveBoundOrganization(input.organizationId),
					context.user.id,
				),
				{
					linkId: input.linkId,
					offset: input.offset,
					limit: input.limit,
					expectedRevision: input.expectedRevision,
				},
			);
		} catch (error) {
			failure(error);
		}
	});
