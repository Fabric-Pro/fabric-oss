import { ORPCError } from "@orpc/client";
import {
	getDocumentById,
	hasProjectAccess,
	rejectDocumentRegeneration,
} from "@repo/database";
import { z } from "zod";
import { applyDocumentUpdateSideEffects } from "../../../../lib/document-side-effects";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Reject the most recent regeneration of a document.
 *
 * Atomically deletes the freshly-created `DocumentVersion` row and rewinds
 * `projectDocument.{content, version}` to the prior snapshot, so version
 * history stays consistent with the live document. See
 * `rejectDocumentRegeneration` for the full rationale.
 *
 * If the document has no prior version to revert to (e.g. the rejected
 * regeneration was the first generation), the helper throws
 * `NO_PRIOR_VERSION`; we surface that as 409 so the client can fall back
 * to its old `skipVersionBump` reject path.
 */
export const rejectRegenerationProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/documents/:id/reject-regeneration",
		tags: ["Projects", "Documents"],
		summary: "Reject the most recent document regeneration",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const document = await getDocumentById(input.id);
		if (!document || document.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Document not found",
			});
		}

		try {
			const reverted = await rejectDocumentRegeneration(input.id, {
				userId: user.id,
				organizationId,
			});

			// Re-embed for RAG so the index reflects the reverted content,
			// matching the side effects of an ordinary save.
			await applyDocumentUpdateSideEffects({
				projectId: input.projectId,
				document: {
					id: reverted.id,
					type: document.type,
					title: document.title,
					status: document.status,
				},
				user,
				organizationId: organizationId ?? undefined,
				logScope: "RejectRegeneration",
			});

			return { document: reverted };
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "NO_PRIOR_VERSION"
			) {
				throw new ORPCError("CONFLICT", {
					message:
						"This document has no prior version to revert to. The current content is still in place.",
				});
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					error instanceof Error
						? error.message
						: "Failed to reject regeneration",
			});
		}
	});
