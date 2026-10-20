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
import { isRunGuardedDocumentType } from "@repo/utils/generation-run-guard";
import { z } from "zod";
import { applyDocumentUpdateSideEffects } from "../../../lib/document-side-effects";
import { fanOut } from "../../../lib/notification-service";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
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

		// A Proposal's status belongs to its generation run while the run is
		// queued or writing (Fizzy #2946): moving it on would
		// end the run's hold on the body, so a later write from any surface
		// would pass, and the run's own final save would land on a status it
		// did not expect. No editor save sends a status (an explicit Save and
		// Mark as complete send `completeDraft`, which touches only a draft),
		// so a status change under a run is refused, here and again by the
		// write itself. Content saves keep their own rules below: a run the
		// server still lists as generating but that stopped writing must not
		// block the editor's save. The one content save that is refused is the
		// Reject fallback (`skipVersionBump`): it rewinds the body to the one
		// from before the last run, which a newer run queued since owns.
		// Decided by type, not by the rollout gate: a run keeps writing when
		// the gate is turned off mid-run.
		const refuseUnderRun =
			(input.status !== undefined ||
				(input.skipVersionBump === true &&
					input.content !== undefined)) &&
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

		// Update document
		// TENANT ISOLATION: Pass userId and organizationId for DocumentVersion tenant filtering
		const saved = await updateDocument(input.id, {
			title: input.title,
			content: input.content,
			status: input.status,
			lastEditedBy: user.id,
			changeDescription: input.changeDescription,
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
			...(refuseUnderRun ? { refuseWhileGenerating: true } : {}),
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
			// Reachable only with a base, or for a status write guarded
			// against a run: someone saved between the caller's read and this
			// write, and nothing was written.
			if (error instanceof DocumentVersionConflictError) {
				throw new ORPCError("CONFLICT", {
					message:
						"The document changed while your changes were being saved, so nothing was saved. Review the latest version and apply your changes again.",
				});
			}
			throw error;
		});

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
