import { ORPCError, os } from "@orpc/server";
import { db, getWorkspaceAccessContext } from "@repo/database";
import { resolveOrganizationId } from "../../../orpc/procedures";

/** Every resource named by the document API must belong to the authorized organization. */
export async function assertWorkspaceBoundary(
	input: unknown,
	userId: string,
	organizationId: string | undefined,
): Promise<void> {
	if (!organizationId)
		throw new ORPCError("NOT_FOUND", {
			message: "Workspace not found or access denied",
		});
	const args =
		input && typeof input === "object"
			? (input as Record<string, unknown>)
			: {};
	const workspaceIds = new Set<string>();
	if (typeof args.workspaceId === "string")
		workspaceIds.add(args.workspaceId);
	if (typeof args.documentId === "string") {
		const document = await db.workspaceDocument.findUnique({
			where: { id: args.documentId },
			select: { workspaceId: true },
		});
		if (!document)
			throw new ORPCError("NOT_FOUND", {
				message: "Document not found or access denied",
			});
		workspaceIds.add(document.workspaceId);
	}
	if (typeof args.conversationId === "string") {
		const conversation = await db.agentConversation.findFirst({
			where: { id: args.conversationId, userId, organizationId },
			select: { id: true },
		});
		if (!conversation)
			throw new ORPCError("NOT_FOUND", {
				message: "Conversation not found or access denied",
			});
	}
	if (workspaceIds.size === 0 && typeof args.conversationId !== "string")
		throw new ORPCError("BAD_REQUEST", {
			message:
				"A workspace, document, or conversation identifier is required",
		});
	for (const workspaceId of workspaceIds) {
		const access = await getWorkspaceAccessContext(workspaceId, userId);
		if (!access || access.organizationId !== organizationId)
			throw new ORPCError("NOT_FOUND", {
				message: "Workspace not found or access denied",
			});
	}
}

export const workspaceBoundaryMiddleware = os
	.$context<{
		user: { id: string };
		session: { activeOrganizationId?: string | null };
	}>()
	.middleware(async ({ context, next }, input: unknown) => {
		const organizationId = resolveOrganizationId(
			(input as { organizationId?: string | null } | undefined)
				?.organizationId,
			context.session,
		);
		await assertWorkspaceBoundary(input, context.user.id, organizationId);
		return next();
	});
