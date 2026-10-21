import { ORPCError } from "@orpc/client";
import {
	DocumentGenerationInProgressError,
	DocumentRegenerationReviewStaleError,
	DocumentVersionConflictError,
	getDocumentById,
	hasProjectAccess,
	rejectDocumentRegeneration,
} from "@repo/database";
import { contentIdentity } from "@repo/utils/content-identity";
import {
	isRunGuardedDocumentType,
	REJECT_REVIEW_STALE,
} from "@repo/utils/generation-run-guard";
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
 *
 * The caller names the regeneration it reviewed: `expectedVersion`, the
 * version that run produced, and `expectedContentHash`, the identity of its
 * body that `projects.documents.get` returned with it. A document that has
 * moved on since the review opened — a newer run completed, a version was
 * restored, a colleague saved — is refused with 409 and `data.code`
 * `REJECT_REVIEW_STALE`, so a stale review can never revert a newer write or
 * delete its version row (Fizzy #2946). `expectedGenerationStartedAt`, the
 * document's `generationStartedAt` when the review opened, names the reviewed
 * run itself: a newer run can produce the very same body. Required: a bundle from before this
 * check gets a 400, never an unguarded rewind.
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
			/** The version the reviewed regeneration produced. */
			expectedVersion: z.number().int().nonnegative(),
			/** `contentHash` of the reviewed body, as `documents.get` returned it. */
			expectedContentHash: z.string().min(1).optional(),
			/**
			 * The reviewed run's `generationStartedAt` (ISO), as `documents.get`
			 * returned it when the review opened.
			 */
			expectedGenerationStartedAt: z
				.string()
				.datetime({ offset: true })
				.optional(),
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
		// rewind itself (the query's default for a Proposal), so a run queued
		// between this read and the rewind is refused by the database too.
		// Decided by type, not by the rollout gate: a run keeps writing when
		// the gate is turned off mid-run.
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

		try {
			const reverted = await rejectDocumentRegeneration(input.id, {
				userId: user.id,
				organizationId,
				expectedVersion: input.expectedVersion,
				expectedContentHash: input.expectedContentHash,
				expectedGenerationStartedAt:
					input.expectedGenerationStartedAt !== undefined
						? new Date(input.expectedGenerationStartedAt)
						: undefined,
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

			return {
				document: {
					...reverted,
					// The rewound body's identity, beside its `version`: the
					// editor puts that body into its room under this stamp and
					// names it as the base of its next save (Fizzy #2946).
					contentHash: contentIdentity(reverted.content),
				},
			};
		} catch (error) {
			if (error instanceof DocumentGenerationInProgressError) {
				throw generationInProgress();
			}
			// The document is no longer the reviewed regeneration: it had
			// moved on when the rewind read it, or a write landed between that
			// read and the rewind and the transaction rolled back. Nothing was
			// reverted or deleted either way, and the client's fallback save
			// must not run: it would write the pre-review body over the newer
			// one.
			if (
				error instanceof DocumentRegenerationReviewStaleError ||
				error instanceof DocumentVersionConflictError
			) {
				throw new ORPCError("CONFLICT", {
					message:
						"The document changed after this regeneration was reviewed, so nothing was reverted.",
					data: { code: REJECT_REVIEW_STALE },
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
