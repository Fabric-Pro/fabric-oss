import { ORPCError } from "@orpc/client";
import {
	DocumentGenerationInProgressError,
	DocumentVersionConflictError,
	getDocumentById,
	hasProjectAccess,
	isProposalClientDocument,
	updateDocument,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	ContextUpdateFailedError,
	ContextUpdateTruncatedError,
	fetchProjectContextSources,
	runContextUpdate,
} from "@repo/temporal";
import { DOCUMENT_SAVE_BASE_REQUIRED } from "@repo/utils/document-save-base";
import { preserveVisualSlots } from "@repo/utils/glossy/visual-slots";
import { normalizeQuoteArtifacts } from "@repo/utils/quote-artifacts";
import { z } from "zod";
import { applyDocumentUpdateSideEffects } from "../../../../lib/document-side-effects";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { isRoomConvergenceOn } from "../../lib/room-convergence-enabled";

/**
 * `data.code` of the preview failures (Fizzy #2946), so the editor says them
 * in the reader's language rather than showing this procedure's English: no
 * AI provider, a response cut off at the model's output limit, and a model
 * call that failed. The provider one is the code background jobs already
 * record for the same condition. The web keeps its own copies of the
 * strings, since its bundle takes no runtime values from this package.
 */
const AI_PROVIDER_NOT_CONFIGURED = "AI_PROVIDER_NOT_CONFIGURED";
const CONTEXT_UPDATE_TRUNCATED = "CONTEXT_UPDATE_TRUNCATED";
const CONTEXT_UPDATE_FAILED = "CONTEXT_UPDATE_FAILED";

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
			 * only; the base below is what guards the confirm.
			 */
			documentVersion: z.number().optional(),
			/**
			 * The base of the body the preview was drafted from (Fizzy #2946),
			 * sent with the confirm: the version and `contentHash` of the saved
			 * body the editor's content descended from when the preview
			 * started, both or neither. A confirm that names it is refused with
			 * CONFLICT, and writes nothing, when the document no longer holds
			 * that body, so an edit or a generated body saved between preview
			 * and confirm is never overwritten. Without it the confirm is
			 * guarded by the version it reads itself, except where the base is
			 * required (a client-document Proposal while the collaborative room
			 * flag is on), as for `projects.documents.update`.
			 */
			expectedVersion: z.number().int().nonnegative().optional(),
			expectedContentHash: z.string().min(1).max(128).optional(),
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

			// Half a base cannot name a body: a version alone misses a body
			// saved at the same version.
			if (
				(input.expectedVersion === undefined) !==
				(input.expectedContentHash === undefined)
			) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Send both expectedVersion and expectedContentHash, or neither",
				});
			}
			const hasBase =
				input.expectedVersion !== undefined &&
				input.expectedContentHash !== undefined;

			// A Proposal's body is written by generation runs as well as by
			// people (Fizzy #2946). A client document's confirm names the body
			// its preview was drafted from (judged by the project's OWNING
			// organization). Any Proposal's confirm is refused while a run is
			// queued or writing, by `updateDocument` itself (its default for a
			// Proposal's content writes), decided by type, not by the rollout
			// gate: a run keeps writing when the gate is turned off mid-run.
			const owningOrganizationId =
				document.project?.organizationId ?? null;
			const clientProposal = await isProposalClientDocument({
				organizationId: owningOrganizationId,
				documentType: document.type,
			});
			if (
				clientProposal &&
				!hasBase &&
				(await isRoomConvergenceOn(owningOrganizationId))
			) {
				// A client from before the confirm named its base: it would
				// write over a run's body at the same version.
				throw new ORPCError("PRECONDITION_FAILED", {
					message:
						"This editor is out of date, so your changes were not saved. Reload the page to keep editing.",
					data: { code: DOCUMENT_SAVE_BASE_REQUIRED },
				});
			}

			// Visual slots (KTD17) come from the CURRENT stored body, not from the
			// confirmed text: the preview was drafted minutes earlier, so a slot a
			// person deleted in between must not come back, and one the confirmed
			// text lost must. With no slot on either side the confirmed text is
			// saved unchanged.
			// Guard the write with the caller's base, or else with the version
			// just read: the slots were lifted from that body, so a slot saved
			// between this read and the write would otherwise be lost. With a
			// base, the read body is the base's body or the write is refused. A
			// conflict writes nothing.
			let updated: Awaited<ReturnType<typeof updateDocument>>;
			try {
				updated = await updateDocument(input.id, {
					content: normalizeQuoteArtifacts(
						preserveVisualSlots(document.content, confirmedContent),
					),
					lastEditedBy: user.id,
					changeDescription: "Updated with latest context",
					userId: user.id,
					organizationId,
					...(hasBase
						? {
								expectedVersion: input.expectedVersion,
								expectedContentHash: input.expectedContentHash,
							}
						: { expectedVersion: document.version }),
				});
			} catch (error) {
				if (error instanceof DocumentGenerationInProgressError) {
					throw new ORPCError("CONFLICT", {
						message:
							"A generation run is writing this document; try again when it finishes.",
						data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
					});
				}
				if (error instanceof DocumentVersionConflictError) {
					throw new ORPCError("CONFLICT", {
						message:
							"The document changed while the update was being applied. Try again.",
					});
				}
				throw error;
			}

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
			// The baseline stays at `createdAt` here on purpose — a person pressing
			// this button wants everything considered, and narrowing it would make
			// the button quietly find nothing right after any manual edit. What it
			// could not do before is SEE anything new: ranking is similarity-only,
			// and on a project with months of meetings the ones the document was
			// written from out-rank the ones it has never read. This reserves slots
			// for the latter without taking the wide net away.
			unseenSince: document.updatedAt ?? document.createdAt,
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
					data: { code: CONTEXT_UPDATE_TRUNCATED },
				});
			}
			if (error instanceof ContextUpdateFailedError) {
				// The model call failed. Deliberately NOT the settings message
				// below — sending someone to a settings page that is already
				// correct is how a transient provider blip becomes an afternoon.
				// Coded apart from it, so the editor can say so too.
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: error.message,
					data: { code: CONTEXT_UPDATE_FAILED },
				});
			}
			throw error;
		}

		if (!aiResult) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"No AI provider is configured for this organization. Add one in AI settings, then try again.",
				data: { code: AI_PROVIDER_NOT_CONFIGURED },
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
