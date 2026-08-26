import { ORPCError } from "@orpc/client";
import {
	getDocumentById,
	hasProjectAccess,
	updateDocument,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	ContextUpdateTruncatedError,
	fetchProjectContextSources,
	runContextUpdate,
} from "@repo/temporal";
import { z } from "zod";
import { applyDocumentUpdateSideEffects } from "../../../../lib/document-side-effects";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses hasProjectAccess() — matches the existing update-document
 * procedure.
 *
 * Fetches recent meeting transcripts and Teams/Slack messages for the project
 * (since the document was created), runs the spec-editor AI pass, and returns
 * a preview for the user to accept or reject in the editor.
 *
 * Two-phase flow:
 *  Phase 1 (preview=true):  returns proposed content WITHOUT saving.
 *  Phase 2 (preview=false): applies the pre-computed content and saves it,
 *                           mirroring the realtime + embedding side effects
 *                           of the regular `update-document` procedure so the
 *                           accept path behaves like a normal save.
 */
export const updateDocumentWithContextProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/{id}/update-with-context",
		tags: ["Projects", "Documents"],
		summary: "Update document with latest context",
		description:
			"Reviews recent meeting transcripts and team messages to update the document with new information",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			/**
			 * When true (default), returns the proposed content without saving.
			 * When false, applies the provided pre-computed content.
			 */
			preview: z.boolean().default(true),
			/**
			 * Current editor content sent by the client during preview so the AI
			 * works against what the user sees, not the last-saved DB state.
			 */
			currentContent: z.string().optional(),
			/**
			 * Pre-computed content to apply (only used when preview=false).
			 * This avoids re-running the expensive AI call on confirm.
			 */
			confirmedContent: z.string().optional(),
			/**
			 * Document version at the time the preview was generated. Advisory
			 * today — `updateDocument()` does not yet support `expectedVersion`
			 * optimistic concurrency (unlike stories). Threaded through so we
			 * can add enforcement later without a client API break.
			 */
			documentVersion: z.number().optional(),
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

		// ── Phase 2: Apply pre-confirmed content ────────────────────────────────
		if (!input.preview) {
			if (input.confirmedContent === undefined) {
				throw new ORPCError("BAD_REQUEST", {
					message: "confirmedContent is required when preview=false",
				});
			}
			const confirmedContent = input.confirmedContent;

			const updated = await updateDocument(input.id, {
				content: confirmedContent,
				lastEditedBy: user.id,
				changeDescription: "Updated with latest context",
				userId: user.id,
				organizationId,
			});

			await applyDocumentUpdateSideEffects({
				projectId: input.projectId,
				document: updated,
				user,
				organizationId,
				logScope: "UpdateDocumentWithContext",
			});

			// Backstop: `updateDocument` skips the content write and version bump
			// when the confirmed content is normalized-identical to the current
			// document. Surface that as `applied: false` with an informative
			// summary so the client shows "no changes" instead of a phantom
			// success. Defensive — unreachable once the upstream no-op gates hold.
			const contentUnchanged = updated.version === document.version;
			if (contentUnchanged) {
				logger.info(
					{
						documentId: input.id,
						projectId: input.projectId,
						confirmedContentLength: confirmedContent.length,
						currentContentLength: (document.content ?? "").length,
					},
					"[UpdateDocumentWithContext] Confirm produced no version bump — confirmed content matches current document",
				);
			}

			return {
				applied: !contentUnchanged,
				document: updated,
				hasRelevantContext: true,
				summary: contentUnchanged
					? "No changes were applied — the confirmed content matches the current document."
					: "Context update applied successfully.",
				needsHumanResolution: false,
				proposedContent: null,
				documentVersion: updated.version,
				contextSourcesUsed: {
					transcriptCount: 0,
					teamsCount: 0,
					slackCount: 0,
					huddleNotesCount: 0,
				},
			};
		}

		// ── Phase 1: Fetch context and run AI preview ────────────────────────────

		const documentMarkdown = input.currentContent ?? document.content ?? "";

		const sources = await fetchProjectContextSources({
			projectId: input.projectId,
			userId: user.id,
			organizationId,
			baselineDate: document.createdAt,
			specMarkdown: documentMarkdown,
		});

		let aiResult: Awaited<ReturnType<typeof runContextUpdate>>;
		try {
			aiResult = await runContextUpdate({
				title: document.title,
				baselineDate: document.createdAt,
				documentMarkdown,
				contextItems: sources.contextItems,
				userId: user.id,
				organizationId,
				projectId: input.projectId,
			});
		} catch (error) {
			if (error instanceof ContextUpdateTruncatedError) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message:
						"The document is too large for the configured AI model's output limit — the update was truncated before completion. Try a model with a larger output limit or split the document.",
				});
			}
			throw error;
		}

		if (!aiResult) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"AI provider not configured or update failed. Please check your AI settings.",
			});
		}

		return {
			applied: false,
			document: null,
			documentVersion: document.version,
			hasRelevantContext: aiResult.hasRelevantContext,
			summary: aiResult.summary,
			needsHumanResolution: aiResult.needsHumanResolution,
			proposedContent: aiResult.hasRelevantContext
				? aiResult.updatedDocument
				: null,
			contextSourcesUsed: {
				transcriptCount: sources.transcriptCount,
				teamsCount: sources.teamsCount,
				slackCount: sources.slackCount,
				huddleNotesCount: sources.huddleNotesCount,
			},
		};
	});
