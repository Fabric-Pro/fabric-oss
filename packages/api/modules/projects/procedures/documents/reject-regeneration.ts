import { ORPCError } from "@orpc/client";
import {
	DocumentGenerationInProgressError,
	DocumentVersionConflictError,
	getDocumentById,
	hasProjectAccess,
	rejectDocumentRegeneration,
} from "@repo/database";
import { isRunGuardedDocumentType } from "@repo/utils/generation-run-guard";
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
 *
 * A client-document Proposal is refused while a generation run holds it
 * (409 with `data.code` `DOCUMENT_GENERATION_IN_PROGRESS`), which the client
 * must not treat as "no prior version": a review dialog can still be open
 * when a newer run starts (Fizzy #2946).
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

		// A Proposal's body belongs to its generation run while the run is
		// queued or writing (Fizzy #2946). Refused here, and again by the
		// rewind itself, so a run queued between this read and the rewind is
		// refused by the database too. Decided by type, not by the rollout
		// gate: a run keeps writing when the gate is turned off mid-run.
		const refuseWhileGenerating = isRunGuardedDocumentType(document.type);
		const generationInProgress = () =>
			new ORPCError("CONFLICT", {
				message:
					"A generation run is writing this document; try again when it finishes.",
				data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
			});
		if (
			refuseWhileGenerating &&
			(document.status === "QUEUED" || document.status === "GENERATING")
		) {
			throw generationInProgress();
		}

		try {
			const reverted = await rejectDocumentRegeneration(input.id, {
				userId: user.id,
				organizationId,
				...(refuseWhileGenerating
					? { refuseWhileGenerating: true }
					: {}),
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
			if (error instanceof DocumentGenerationInProgressError) {
				throw generationInProgress();
			}
			// Reachable only for a guarded rewind: a write landed between its
			// read and its update, and the transaction rolled back. The client
			// falls back to its guarded save, which names the body it holds.
			if (error instanceof DocumentVersionConflictError) {
				throw new ORPCError("CONFLICT", {
					message:
						"The document changed while the regeneration was being rejected, so nothing was reverted.",
				});
			}
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
