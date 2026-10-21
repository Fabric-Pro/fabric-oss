import { ORPCError } from "@orpc/client";
import {
	DocumentGenerationInProgressError,
	DocumentVersionConflictError,
	getDocumentById,
	hasProjectAccess,
	restoreDocumentVersion,
} from "@repo/database";
import { contentIdentity } from "@repo/utils/content-identity";
import { isRunGuardedDocumentType } from "@repo/utils/generation-run-guard";
import { z } from "zod";
import { emitDocumentChange } from "../../../../lib/realtime";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const restoreVersionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/documents/:documentId/versions/:versionNumber/restore",
		tags: ["Projects", "Documents", "Versions"],
		summary: "Restore document version",
		description: "Restore a document to a previous version",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			versionNumber: z.number().int().positive(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Check project access
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

		// Verify document belongs to project
		const document = await getDocumentById(input.documentId);

		if (!document || document.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Document not found",
			});
		}

		// A Proposal's body belongs to its generation run while the run is
		// queued or writing (Fizzy #2946): a restore landing
		// under it would replace the body the run streams into, and the run's
		// own final save would then overwrite the restore or fail against a
		// baseline that moved. Refused here, and again by the write itself
		// (the query's default for a Proposal's content write), so a run
		// queued between this read and the restore is refused by the database
		// too. Decided by type, not by the rollout gate: a run keeps writing
		// when the gate is turned off mid-run.
		const generationInProgress = () =>
			new ORPCError("CONFLICT", {
				message:
					"A generation run is writing this document; try again when it finishes.",
				data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
			});
		if (
			isRunGuardedDocumentType(document.type) &&
			(document.status === "QUEUED" || document.status === "GENERATING")
		) {
			throw generationInProgress();
		}

		// Restore version
		// TENANT ISOLATION: Pass tenant context for proper tenant filtering
		const restoredDocument = await restoreDocumentVersion(
			input.documentId,
			input.versionNumber,
			user.id,
			{
				userId: user.id,
				organizationId,
			},
		).catch((error: unknown) => {
			// A run queued between the read above and the restore's write.
			if (error instanceof DocumentGenerationInProgressError) {
				throw generationInProgress();
			}
			// Reachable only for a guarded restore: the write is conditioned on
			// the version it read, and someone saved in between. Nothing was
			// written.
			if (error instanceof DocumentVersionConflictError) {
				throw new ORPCError("CONFLICT", {
					message:
						"The document changed while the version was being restored, so nothing was restored. Review the latest version and try again.",
				});
			}
			throw error;
		});

		// Open editors refetch on `document_change`, so a collaborative room
		// holding the body this restore replaced brings itself to the
		// restored one instead of saving the older body back (Fizzy #2946).
		// Never throws.
		await emitDocumentChange({
			projectId: input.projectId,
			documentId: input.documentId,
			action: "updated",
			userId: user.id,
			userName: user.name || "Anonymous",
			documentType: restoredDocument.type,
			documentTitle: restoredDocument.title,
		});

		return {
			document: {
				...restoredDocument,
				// The restored body's identity, beside its `version`: the base
				// the next save from it names, as `projects.documents.update`
				// returns it. It shadows the embed-owned `contentHash` column.
				contentHash: contentIdentity(restoredDocument.content),
			},
		};
	});
