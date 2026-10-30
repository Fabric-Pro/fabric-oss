import { ORPCError } from "@orpc/client";
import {
	buildDocumentLink,
	completeDraftDocument,
	DocumentGenerationInProgressError,
	DocumentVersionConflictError,
	db,
	hasProjectAccess,
	IntegrationContractStatusManagedError,
	isProposalClientDocument,
	updateDocument,
} from "@repo/database";
import { ProjectDocumentStatusSchema } from "@repo/database/prisma/zod";
import {
	FUNCTION_TAG_GROUP_LABELS,
	FUNCTION_TAG_ORDER,
} from "@repo/database/src/function-tags";
import { logger } from "@repo/logs";
import { contentIdentity } from "@repo/utils/content-identity";
import { DOCUMENT_SAVE_BASE_REQUIRED } from "@repo/utils/document-save-base";
import {
	isGenerationRunStillWriting,
	isRunGuardedDocumentType,
} from "@repo/utils/generation-run-guard";
import { z } from "zod";
import { applyDocumentUpdateSideEffects } from "../../../lib/document-side-effects";
import { fanOut } from "../../../lib/notification-service";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { runInBackground } from "../../weave/lib/run-in-background";
import { cancelStalledGenerationRun } from "../lib/cancel-stalled-generation-run";
import {
	documentAiReviewSchema,
	type ReviewedAiSave,
	reviewAiAcceptedSave,
} from "../lib/document-ai-review";
import {
	diffGroupMentions,
	diffMentionIds,
	extractDocumentGroupMentions,
	extractDocumentMentionIds,
	extractMentionContextSnippet,
} from "../lib/document-mentions";
import { assertNotGenerationOwnedStatus } from "../lib/generation-owned-status";
import {
	expandGroupMentionsByTag,
	narrowToCurrentProjectRoster,
} from "../lib/group-mention";
import { isRoomConvergenceOn } from "../lib/room-convergence-enabled";
import { filterAuthorizedMentionRecipients } from "../lib/user-mention";

// All document types are re-embedded when content changes.
// This matches the generation workflow which embeds ALL types so they
// serve as cross-document context (e.g., TECHNICAL_SPEC as context for API_SPEC).

export const updateDocumentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/documents/:id",
		tags: ["Projects", "Documents"],
		summary: "Update document",
		description: "Update a document and create a new version",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			title: z.string().min(1).max(255).optional(),
			content: z.string().optional(),
			status: ProjectDocumentStatusSchema.optional(),
			changeDescription: z.string().optional(),
			/** Skip version bump when reverting a rejected regeneration */
			skipVersionBump: z.boolean().optional(),
			/**
			 * Optimistic-concurrency guard (Fizzy #2589, KTD17). The in-editor
			 * assistant accept sends it when a visual slot is involved: the
			 * accepted body carries the editor's slots, which are right only for
			 * the version the editor last synced with. When present, a document
			 * no longer at this version is left untouched and the save fails
			 * with CONFLICT. A save from a collaborative editor room sends it
			 * with `expectedContentHash`, both from the room's stamp. Saves
			 * without a base stay last-write-wins, except where the base is
			 * required (below).
			 */
			expectedVersion: z.number().int().nonnegative().optional(),
			/**
			 * The body half of the base (Fizzy #2946): the `contentHash` this
			 * procedure or `projects.documents.get` returned for the body the
			 * save's content descends from. When present, a document whose
			 * body no longer has this identity is left untouched and the save
			 * fails with CONFLICT, even at the same version: a Proposal run's
			 * final save writes its body at the old version, and a rejected
			 * regeneration rewinds the version.
			 */
			expectedContentHash: z.string().min(1).max(128).optional(),
			/**
			 * The author is finishing the document: complete it if it is still
			 * a draft and has content. The editor sends it with an explicit
			 * Save, and the Documents tab with Mark as complete. An autosave
			 * omits it, so a document is not completed while it is still being
			 * typed. Unlike `status: "COMPLETE"` it does nothing to a document
			 * that is no longer a draft; the response's `draftCompleted` says
			 * whether this request completed it.
			 */
			completeDraft: z.boolean().optional(),
			/**
			 * The save is the accept of an AI change (Fizzy #2946): a chat
			 * proposal (`CHAT`, with the section keys it patched) or a
			 * finding-driven revision (`FINDING`, with the token the revision
			 * returned). Honoured only on a client-document Proposal, where it
			 * needs the base and `content`: the change is checked as it would
			 * be saved, a refusal answers PRECONDITION_FAILED with a
			 * `SCOPED_REVISION_REFUSAL` code, and a `FINDING` accept records
			 * the finding as Resolved with the save. Ignored on any other
			 * document.
			 */
			aiReview: documentAiReviewSchema.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		// QUEUED and GENERATING belong to generation runs: a status write may
		// never start a hold no run backs.
		assertNotGenerationOwnedStatus(input.status);
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

		// Pre-load existing content so we can diff mentions after the save.
		// `status` + `version` also let us detect a real change for subscriber
		// notifications: `updateDocument` bumps `version` only on a normalized
		// content change, so a version delta is the precise "content changed"
		// signal (title-only saves leave it untouched).
		const prior = await db.projectDocument.findUnique({
			where: { id: input.id },
			select: {
				projectId: true,
				content: true,
				title: true,
				status: true,
				type: true,
				version: true,
				// The run's clock, to tell a live run from a stalled one.
				generationStartedAt: true,
				updatedAt: true,
				// The run's workflow, stopped when this save ends a stalled run.
				workflowId: true,
				// The owning organization, for the base requirement below:
				// never the session's.
				project: { select: { organizationId: true } },
			},
		});

		// TENANT ISOLATION (SOC 2 CC6.1/CC6.3): the permission gate above only
		// authorizes `input.projectId`, but the document is loaded/written by
		// `input.id` alone. Without binding the record to the authorized
		// project, a caller with UPDATE on their own project could overwrite
		// ANY tenant's document by id. Reject when the document is missing or
		// belongs to a different project (NOT_FOUND to avoid a cross-tenant
		// existence oracle).
		if (!prior || prior.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", { message: "Document not found" });
		}
		// Integration contracts (Discovery runs, plan Slice 4) change status only
		// through `projects.discovery.markContractComplete`, which completes the
		// owning run in the same transaction. Letting the generic update set
		// COMPLETE would satisfy the readiness gate while the run stayed active
		// under the one-active-run index (review sprint3 #4). Content and title
		// edits remain allowed here.
		if (
			prior.type === "INTEGRATION_CONTRACT" &&
			input.status !== undefined &&
			input.status !== prior.status
		) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"Integration contract status is managed by the discovery run. Use Mark contract complete (projects.discovery.markContractComplete).",
				data: { code: "INTEGRATION_CONTRACT_STATUS_MANAGED" },
			});
		}

		// A Proposal's body and status belong to its generation run while the
		// run is queued or writing (Fizzy #2946), and `updateDocument` refuses
		// every content or status write under a run by default, at its read
		// and again in its WHERE. The editor's plain content save is the one
		// exemption (`allowDuringLiveRun`, below), and only over a run that
		// has stalled: a run the server still lists as generating but that
		// has not written for the silence ceiling must not block the editor's
		// save. Nothing tells the editor's request apart from any other
		// caller's, so the row decides, by the rule the editor itself stops
		// treating a run as writing by (`isGenerationRunStillWriting`), and a
		// content save under a live run is refused for every caller.
		// Everything else is refused here first, so it is answered before any
		// work: a status change (moving it on would end the run's hold on the
		// body, and the run's own final save would land on a status it did not
		// expect; no editor save sends a status, since an explicit Save and
		// Mark as complete send `completeDraft`, which touches only a draft),
		// and the Reject fallback (`skipVersionBump`), which rewinds the body
		// to the one from before the last run, which a newer run queued since
		// owns. Decided by type, not by the rollout gate: a run keeps writing
		// when the gate is turned off mid-run.
		const editorContentSave =
			input.content !== undefined &&
			input.status === undefined &&
			input.skipVersionBump !== true;
		const refuseUnderRun =
			(input.content !== undefined || input.status !== undefined) &&
			!(editorContentSave && !isGenerationRunStillWriting(prior)) &&
			isRunGuardedDocumentType(prior.type);
		const generationInProgress = () =>
			new ORPCError("CONFLICT", {
				message:
					"A generation run is writing this document; try again when it finishes.",
				data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
			});
		if (
			refuseUnderRun &&
			(prior.status === "QUEUED" || prior.status === "GENERATING")
		) {
			throw generationInProgress();
		}

		// A content-bearing save names the body it was based on, so a save
		// based on an older body than the last server write is refused
		// rather than written over it (Fizzy #2946). Title-only and
		// status-only saves carry no body and never need one.
		const contentBearing = input.content !== undefined;
		const hasBase =
			input.expectedVersion !== undefined &&
			input.expectedContentHash !== undefined;
		if (contentBearing && !hasBase) {
			const owningOrganizationId = prior.project?.organizationId ?? null;
			const roomSavesNameBase =
				await isRoomConvergenceOn(owningOrganizationId);
			if (
				roomSavesNameBase &&
				(await isProposalClientDocument({
					organizationId: owningOrganizationId,
					documentType: prior.type,
				}))
			) {
				// An editor bundle from before saves named their base: it would
				// write last-wins over a run's body. The web maps the code to
				// "reload to keep editing".
				throw new ORPCError("PRECONDITION_FAILED", {
					message:
						"This editor is out of date, so your changes were not saved. Reload the page to keep editing.",
					data: { code: DOCUMENT_SAVE_BASE_REQUIRED },
				});
			}
			// Accepted as before. While the room flag is on, editor saves name
			// their base, so a save without one is logged, split by what it
			// carried, to tell when the base can be required for other types.
			// Ids only, never content. With the flag off nothing sends a base,
			// so nothing is logged.
			if (roomSavesNameBase) {
				logger.info(
					{
						documentId: input.id,
						projectId: input.projectId,
						organizationId: owningOrganizationId,
						documentType: prior.type,
						surface: "projects.documents.update",
						hasExpectedVersion: input.expectedVersion !== undefined,
						hasExpectedContentHash:
							input.expectedContentHash !== undefined,
						skipVersionBump: input.skipVersionBump === true,
						completeDraft: input.completeDraft === true,
					},
					"[update-document] content-bearing save without a base",
				);
			}
		}

		// An AI accept on a client-document Proposal is checked as it would
		// be saved, and refused before anything is written (Fizzy #2946).
		const reviewed = await reviewAiAcceptIfApplicable({
			// Only the fields the check reads: never the input organization,
			// which the owning organization on `prior` replaces.
			input: {
				projectId: input.projectId,
				id: input.id,
				content: input.content,
				status: input.status,
				skipVersionBump: input.skipVersionBump,
				expectedVersion: input.expectedVersion,
				expectedContentHash: input.expectedContentHash,
				aiReview: input.aiReview,
			},
			prior,
			hasBase,
			context,
		});

		// Update document
		// TENANT ISOLATION: Pass userId and organizationId for DocumentVersion tenant filtering
		const saved = await updateDocument(input.id, {
			title: input.title,
			content: reviewed ? reviewed.content : input.content,
			status: input.status,
			lastEditedBy: user.id,
			// A checked AI accept the client did not describe gets a generic
			// description rather than none.
			changeDescription:
				reviewed && !input.changeDescription?.trim()
					? reviewed.changeDescription
					: input.changeDescription,
			userId: user.id,
			organizationId,
			skipVersionBump: input.skipVersionBump,
			// Only a caller that asked for the guard gets it; without it the
			// call is exactly the unguarded one every other save makes.
			...(input.expectedVersion !== undefined
				? { expectedVersion: input.expectedVersion }
				: {}),
			...(input.expectedContentHash !== undefined
				? { expectedContentHash: input.expectedContentHash }
				: {}),
			// The editor's plain content save may write over a stalled run;
			// the write judges the run again at its own read. Every other
			// content or status write keeps the live-run refusal.
			...(editorContentSave
				? { allowDuringLiveRun: "editor-content-save" as const }
				: {}),
			...(reviewed?.inTransaction
				? { inTransaction: reviewed.inTransaction }
				: {}),
		}).catch((error: unknown) => {
			// The query layer is the last line of defence for contract status
			// (a completion may land between the pre-read above and its own
			// read); map it to the same documented error.
			if (error instanceof IntegrationContractStatusManagedError) {
				throw new ORPCError("PRECONDITION_FAILED", {
					message: error.message,
					data: { code: error.code },
				});
			}
			// A run queued between the read above and this write.
			if (error instanceof DocumentGenerationInProgressError) {
				throw generationInProgress();
			}
			// Reachable only with a base, or for a Proposal's status write or
			// rewind, which is guarded against a run: someone saved between the
			// caller's read and this write, and nothing was written.
			if (error instanceof DocumentVersionConflictError) {
				throw new ORPCError("CONFLICT", {
					message:
						"The document changed while your changes were being saved, so nothing was saved. Review the latest version and apply your changes again.",
				});
			}
			throw error;
		});

		// This save ended a stalled Proposal run (Fizzy #2946). The editor's
		// content save sends no status, so a row that was GENERATING comes
		// back COMPLETE because the write ended the run, and cleared the run's
		// token with it: nothing the run guards by that token can land any
		// more. Stopping the run's generation child as well keeps it from
		// waking at all. Only the child, never a parent that runs other
		// documents too, and best effort after the response
		// (`cancelStalledGenerationRun` says why). The one other way here,
		// which this cannot tell apart, is a run that finished by itself
		// between the read above and the write's own: its child has then
		// finished or is finishing, and cancelling a child that is gone does
		// nothing.
		if (
			editorContentSave &&
			isRunGuardedDocumentType(prior.type) &&
			prior.status === "GENERATING" &&
			saved.status === "COMPLETE" &&
			prior.workflowId
		) {
			runInBackground(
				cancelStalledGenerationRun({
					documentId: input.id,
					workflowId: prior.workflowId,
				}),
			);
		}

		// The author asked to finish the document (`completeDraft`). Only a
		// draft with content qualifies; an explicit status wins, and a revert
		// that skips the version bump is not the author finishing anything.
		// The completion itself is a separate guarded write: it holds only if
		// the document is still a draft when it lands, so a generation that
		// has picked the document up since is not overwritten, and its result
		// says whether THIS request completed the document.
		const mayCompleteDraft =
			input.completeDraft === true &&
			input.status === undefined &&
			!input.skipVersionBump &&
			saved.status === "DRAFT" &&
			saved.type !== "INTEGRATION_CONTRACT" &&
			saved.content.trim() !== "";
		const draftCompleted = mayCompleteDraft
			? await completeDraftDocument(input.id)
			: false;
		const document = draftCompleted
			? { ...saved, status: "COMPLETE" as const }
			: saved;

		// This request moved the document into COMPLETE: it completed the
		// draft, or it set the status explicitly on one that was not complete.
		const becameComplete =
			draftCompleted ||
			(input.status === "COMPLETE" && prior.status !== "COMPLETE");

		// Only embed when the save actually changed content — update-document
		// is the only procedure that may skip the embed on metadata-only saves.
		// A document that has just become COMPLETE is the exception: nothing
		// embeds a draft, so this is the first point at which the embed can
		// run for it, and skipping it would leave a document of an embedded
		// type finished but absent from retrieval until its next content
		// change.
		await applyDocumentUpdateSideEffects({
			projectId: input.projectId,
			document,
			user,
			organizationId,
			logScope: "UpdateDocument",
			skipEmbed: !input.content && !becameComplete,
		});

		// Mention fan-out — fire and forget, must never break the save.
		void dispatchDocumentMentions({
			projectId: input.projectId,
			documentId: input.id,
			documentTitle: input.title ?? prior?.title ?? "Untitled",
			organizationId: organizationId ?? null,
			actorUserId: user.id,
			actorName: (user as { name?: string }).name ?? "A teammate",
			prevContent: prior?.content ?? "",
			nextContent: input.content ?? prior?.content ?? "",
		}).catch((err) => {
			// fanOut.documentMention already swallows per-recipient errors; this
			// catches whole-dispatch failures (e.g., org row missing for the
			// link builder, db hiccup in the authz filter) so the save still
			// succeeds and the failure surfaces in logs.
			logger.warn(
				{ err, documentId: input.id, projectId: input.projectId },
				"[update-document] mention dispatch failed",
			);
		});

		// Subscriber fan-out — notify watchers on a real content change (version
		// bumped) or a status change. Title-only / metadata-only saves do NOT
		// notify. Fire-and-forget; must never break the save.
		const contentChanged =
			prior != null && document.version !== prior.version;
		const statusChanged =
			becameComplete ||
			(input.status !== undefined &&
				prior != null &&
				input.status !== prior.status);
		if (contentChanged || statusChanged) {
			void fanOut
				.subscriptionUpdate({
					subjectType: "DOCUMENT",
					subjectId: input.id,
					projectId: input.projectId,
					organizationId: organizationId ?? null,
					actorUserId: user.id,
					actorName: (user as { name?: string }).name ?? "A teammate",
					title: document.title,
					link: buildDocumentLink({
						projectId: input.projectId,
						documentId: input.id,
					}),
					changeKind: contentChanged ? "content" : "status",
				})
				.catch((err) => {
					logger.warn(
						"[update-document] subscription dispatch failed",
						{
							err,
							documentId: input.id,
							projectId: input.projectId,
						},
					);
				});
		}

		// Backstop signal for save callers: `updateDocument` bumps `version` only
		// on a normalized content change, so a content-bearing save that left the
		// version untouched was a no-op. Surface it additively so the confirm-save
		// path can show "no changes" instead of a phantom success (never content).
		const contentUnchanged = input.content !== undefined && !contentChanged;
		if (contentUnchanged) {
			logger.info(
				{
					documentId: input.id,
					projectId: input.projectId,
					newContentLength: input.content?.length ?? 0,
					priorContentLength: prior.content?.length ?? 0,
				},
				"[update-document] content-bearing save produced no version bump — content matches current document",
			);
		}

		return {
			document: {
				...document,
				// The saved body's identity, beside its `version`: together the
				// base the next save from this body names. It shadows the
				// embed-owned `contentHash` column, which no reader of this
				// response uses and which can lag the body.
				contentHash: contentIdentity(document.content),
			},
			contentUnchanged,
			draftCompleted,
		};
	});

const DOCUMENT_CHANGED_MESSAGE =
	"The document changed while your changes were being saved, so nothing was saved. Review the latest version and apply your changes again.";

/**
 * The `aiReview` descriptor's checks, when it applies: on a client-document
 * Proposal, judged by the project's OWNING organization. Returns null when
 * there is no descriptor or it does not apply, and the save goes ahead as
 * any other.
 *
 * Where it applies it needs a content save that names its whole base, and
 * the body it checks against is the base's: a base the stored body no
 * longer matches is answered CONFLICT here, as the guarded write would,
 * rather than as a change outside the target.
 */
async function reviewAiAcceptIfApplicable(args: {
	input: {
		projectId: string;
		id: string;
		content?: string;
		status?: unknown;
		skipVersionBump?: boolean;
		expectedVersion?: number;
		expectedContentHash?: string;
		aiReview?: z.infer<typeof documentAiReviewSchema>;
	};
	prior: {
		content: string;
		type: string;
		version: number;
		project: { organizationId: string | null } | null;
	};
	hasBase: boolean;
	context: Parameters<typeof reviewAiAcceptedSave>[0]["context"];
}): Promise<ReviewedAiSave | null> {
	const { input, prior } = args;
	const review = input.aiReview;
	if (!review) {
		return null;
	}
	const owningOrganizationId = prior.project?.organizationId ?? null;
	if (
		!owningOrganizationId ||
		!(await isProposalClientDocument({
			organizationId: owningOrganizationId,
			documentType: prior.type,
		}))
	) {
		return null;
	}
	if (
		input.content === undefined ||
		input.status !== undefined ||
		input.skipVersionBump === true
	) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"An AI accept saves content only, without a status or a version rewind.",
		});
	}
	if (
		!args.hasBase ||
		input.expectedVersion === undefined ||
		input.expectedContentHash === undefined
	) {
		throw new ORPCError("PRECONDITION_FAILED", {
			message:
				"This editor is out of date, so your changes were not saved. Reload the page to keep editing.",
			data: { code: DOCUMENT_SAVE_BASE_REQUIRED },
		});
	}
	if (
		prior.version !== input.expectedVersion ||
		contentIdentity(prior.content) !== input.expectedContentHash
	) {
		throw new ORPCError("CONFLICT", { message: DOCUMENT_CHANGED_MESSAGE });
	}
	return await reviewAiAcceptedSave({
		review,
		projectId: input.projectId,
		documentId: input.id,
		owningOrganizationId,
		stored: { content: prior.content, version: prior.version },
		content: input.content,
		expectedVersion: input.expectedVersion,
		context: args.context,
	});
}

export async function dispatchDocumentMentions(args: {
	projectId: string;
	documentId: string;
	documentTitle: string;
	organizationId: string | null;
	actorUserId: string;
	actorName: string;
	prevContent: string;
	nextContent: string;
}): Promise<void> {
	const newlyMentioned = diffMentionIds(
		extractDocumentMentionIds(args.prevContent),
		extractDocumentMentionIds(args.nextContent),
	);
	const newGroups = diffGroupMentions(
		extractDocumentGroupMentions(args.prevContent),
		extractDocumentGroupMentions(args.nextContent),
	);
	if (newlyMentioned.length === 0 && newGroups.length === 0) {
		return;
	}

	const link = buildDocumentLink({
		projectId: args.projectId,
		documentId: args.documentId,
	});
	// Track everyone already notified so a group never double-notifies an
	// individually-mentioned recipient (individual "mentioned you" wins).
	const dispatched = new Set<string>();

	// --- Individual mentions (existing behavior, existing org-soft filter) ---
	if (newlyMentioned.length > 0) {
		const allowedUserIds = await filterAuthorizedMentionRecipients(
			newlyMentioned.map((m) => m.userId),
			args.projectId,
			args.organizationId,
		);
		const allowedSet = new Set(allowedUserIds);
		const recipients = newlyMentioned.filter((m) =>
			allowedSet.has(m.userId),
		);
		if (recipients.length > 0) {
			for (const r of recipients) {
				dispatched.add(r.userId);
			}
			const snippetByAnchor = Object.fromEntries(
				recipients.map((m) => [
					m.anchorId,
					extractMentionContextSnippet(args.nextContent, m.anchorId),
				]),
			);
			// Authoritative actor for document mentions is the session caller.
			// The binding `actorUserId: user.id` is set at the call site to
			// dispatchDocumentMentions (see above in this file). If/when an
			// AI-on-behalf-of-human surface is added, it must impersonate at
			// the session layer — this dispatch trusts `user.id` as the human
			// who authored the change.
			await fanOut.documentMention({
				recipients,
				documentId: args.documentId,
				projectId: args.projectId,
				organizationId: args.organizationId,
				actorUserId: args.actorUserId,
				actorName: args.actorName,
				documentTitle: args.documentTitle,
				link,
				snippetByAnchor,
			});
		}
	}

	// --- Group mentions (project-scoped narrow, group-only, per-group label) ---
	// Dispatch in FUNCTION_TAG_ORDER (NOT document order) so an overlapping
	// member gets a deterministic group label, matching the comment surface
	// (Codex plan review #2).
	const orderedGroups = [...newGroups].sort(
		(a, b) =>
			FUNCTION_TAG_ORDER.indexOf(a.tag) -
			FUNCTION_TAG_ORDER.indexOf(b.tag),
	);
	if (orderedGroups.length > 0) {
		// Resolve the roster ONCE for every mentioned tag, then narrow the
		// union of holders a single time. Per-tag holders intersected with the
		// narrowed union equal the per-tag narrow (narrow is a membership
		// filter), so this preserves the recipients, precedence, and per-group
		// labels of the old per-tag resolve while dropping the redundant reads.
		const holdersByTag = await expandGroupMentionsByTag({
			projectId: args.projectId,
			groupTags: [...new Set(orderedGroups.map((g) => g.tag))],
		});
		const narrowedGroupRoster = new Set(
			await narrowToCurrentProjectRoster(
				[...new Set([...holdersByTag.values()].flat())],
				args.projectId,
			),
		);
		for (const group of orderedGroups) {
			// A group never notifies the acting author (`id !== actorUserId`);
			// the individual "mentioned you" path already claimed anyone reached
			// both ways (`dispatched`).
			const fresh = (holdersByTag.get(group.tag) ?? []).filter(
				(id) =>
					narrowedGroupRoster.has(id) &&
					!dispatched.has(id) &&
					id !== args.actorUserId,
			);
			if (fresh.length === 0) {
				continue;
			}
			for (const id of fresh) {
				dispatched.add(id);
			}
			await fanOut.documentMention({
				recipients: fresh.map((userId) => ({
					userId,
					anchorId: group.anchorId,
				})),
				documentId: args.documentId,
				projectId: args.projectId,
				organizationId: args.organizationId,
				actorUserId: args.actorUserId,
				actorName: args.actorName,
				documentTitle: args.documentTitle,
				link,
				snippetByAnchor: {
					[group.anchorId]: extractMentionContextSnippet(
						args.nextContent,
						group.anchorId,
					),
				},
				groupLabel: FUNCTION_TAG_GROUP_LABELS[group.tag],
			});
		}
	}
}
