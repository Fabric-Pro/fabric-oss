import { ORPCError } from "@orpc/client";
import {
	db,
	hasProjectAccess,
	mergeDuplicateStories,
	updateStory,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { copyStoryAssetsToStory } from "../../lib/copy-story-assets-to-story";
import { enqueuePmSync } from "../../lib/enqueue-pm-sync";
import { reconcileMergedDescriptionAttachments } from "../../lib/reconcile-merged-attachments";

export const mergeDuplicateProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/merge-duplicate",
		tags: ["Projects", "Stories"],
		summary: "Merge a duplicate story",
		description:
			"Merge a genuine duplicate: carry the duplicate's tasks to the survivor and move the duplicate to the Declined ('Removed or duplicate') stage. The kanban column is left untouched. PM linkage is resolved per `pmLink` — `keep-survivor` (default) leaves the survivor's link untouched and clears the discarded item's link; `transfer-from-duplicate` moves the discarded item's PM link (and its sync state) onto the survivor — applied atomically with the merge. When `mergedDescription` and/or `mergedAcceptanceCriteria` are supplied (an AI-combined, user-reviewed 'true merge'), they replace the survivor's description / acceptance criteria before the duplicate is retired. The duplicate's uploaded attachments are copied into the survivor's keyspace and re-parented onto it; on the AI-combined path its inline images are copied too and referenced from the merged body.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			survivorId: z.string(),
			duplicateId: z.string(),
			// How to resolve the external PM-tool link across the pair. The
			// dialog computes this from each side's link state (its UC
			// classification) and only sends a non-default value when the user
			// has chosen to migrate / select a link. Omitted ⇒ `keep-survivor`.
			pmLink: z
				.enum(["keep-survivor", "transfer-from-duplicate"])
				.optional(),
			// Optional "true merge": the combined description / acceptance
			// criteria (from proposeDuplicateMerge, then reviewed/edited by the
			// user) to write onto the survivor. Bounded per `global/validation.md`.
			// Omitted (or whitespace-only) for a plain merge, which leaves the
			// survivor's content untouched.
			mergedDescription: z.string().max(50_000).optional(),
			mergedAcceptanceCriteria: z.string().max(50_000).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}
		if (input.survivorId === input.duplicateId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Cannot merge a story into itself",
			});
		}

		try {
			// "True merge": apply the AI-combined, user-reviewed content to the
			// survivor BEFORE retiring the duplicate. Ordered first so a failure
			// here aborts the merge (the duplicate stays active and nothing is
			// lost). updateStory snapshots a FeatureVersion; the trimmed-empty
			// guard keeps a blank textarea from wiping a real value. Each field
			// is applied independently — a combine can fill one and leave the
			// other untouched.
			const mergedDescriptionInput = input.mergedDescription?.trim();
			const mergedAcceptanceCriteria =
				input.mergedAcceptanceCriteria?.trim();

			// Carry the duplicate's assets into the survivor's keyspace BEFORE
			// anything references them (Fizzy #2048). Both keyspaces are
			// prefix-gated against the owning item, so the objects have to be
			// COPIED, not re-pointed; the copy runs first so the merged body and
			// the re-parented attachment rows can only ever name an object that
			// demonstrably exists. A copy failure is not fatal — the helper never
			// throws, logs every key it could not carry, and reports only what
			// succeeded.
			//
			// Inline images are carried on the AI-combined path only: a plain
			// merge writes no survivor body, so there is nowhere for the
			// duplicate's image markdown to land. Its uploaded attachments still
			// move, through the re-parented rows.
			const [priorDuplicate, duplicateAttachments] = await Promise.all([
				mergedDescriptionInput
					? db.userStory.findFirst({
							where: {
								id: input.duplicateId,
								projectId: input.projectId,
							},
							select: { description: true },
						})
					: Promise.resolve(null),
				// Soft-deleted rows stay with the duplicate: they are already
				// hidden and pending retention purge, so moving them would
				// resurrect nothing and copy bytes for no reader.
				db.storyAttachment.findMany({
					// Scoped through the story's project, not by id alone. The
					// caller supplies `duplicateId`, and the two checks that would
					// otherwise catch a foreign one — the copy helper's prefix
					// filter and the merge query's same-project assertion — both
					// run AFTER this read.
					where: {
						storyId: input.duplicateId,
						story: { projectId: input.projectId },
						deletedAt: null,
					},
					orderBy: { createdAt: "asc" },
					select: { id: true, storageKey: true },
				}),
			]);
			const carried = await copyStoryAssetsToStory({
				projectId: input.projectId,
				sourceStoryId: input.duplicateId,
				targetStoryId: input.survivorId,
				sourceDescription: priorDuplicate?.description ?? null,
				sourceAttachments: duplicateAttachments,
			});

			const data: { description?: string; acceptanceCriteria?: string } =
				{};
			if (mergedDescriptionInput) {
				// Preserve BOTH items' images through the AI-combine. Story media
				// is story-scoped, so the combined text can neither be trusted to
				// keep the survivor's keys (the model may drop them, and the
				// per-field input cap can truncate them before it ever sees them)
				// nor carry the duplicate's ORIGINAL keys (they'd 404 on the
				// survivor). Reconcile against the survivor's prior description
				// plus the keys just copied out of the duplicate.
				const priorSurvivor = await db.userStory.findFirst({
					where: {
						id: input.survivorId,
						projectId: input.projectId,
					},
					select: { description: true },
				});
				const reconciled = reconcileMergedDescriptionAttachments({
					mergedDescription: mergedDescriptionInput,
					survivorPriorDescription:
						priorSurvivor?.description ?? null,
					projectId: input.projectId,
					survivorId: input.survivorId,
					carriedMediaKeys: carried.media.map((m) => m.targetKey),
				});
				// Non-empty guard (mirrors the blank-textarea guard): a reconcile
				// that nets to empty must never wipe a real description.
				if (reconciled.trim().length > 0) {
					data.description = reconciled;
				}
			}
			if (mergedAcceptanceCriteria) {
				data.acceptanceCriteria = mergedAcceptanceCriteria;
			}
			if (Object.keys(data).length > 0) {
				const survivor = await updateStory(
					input.survivorId,
					input.projectId,
					data,
					{
						userId: context.user.id,
						organizationId: organizationId ?? undefined,
						changedBy: context.user.id,
						lastEditedSource: "AI_BACKLOG_UPDATE",
						lastEditedByName: context.user.name ?? null,
						// "ai-combined" marker → the version-history viewer shows the
						// AI (sparkles) icon for this entry, so the survivor's history
						// reads raw → AI-combined merge. A plain (non-AI) merge does
						// not reach updateStory, so it adds no version here.
						changeDescription:
							"AI-combined merge — kept this item and retired a duplicate",
					},
				);

				// Reapply the per-story PM-sync gate: description + acceptance
				// criteria are both PM-tool content, so when auto-sync is on for
				// the survivor, push the combined text (mirrors update-story.ts).
				// Best-effort — a sync failure must not roll back the merge.
				if (survivor.pmAutoSyncEnabled) {
					enqueuePmSync({
						itemId: input.survivorId,
						itemType: "story",
						projectId: input.projectId,
						userId: context.user.id,
						triggerSource: "manual-edit",
					}).catch((err) => {
						logger.warn("enqueuePmSync failed after true-merge", {
							storyId: input.survivorId,
							err:
								err instanceof Error
									? err.message
									: String(err),
						});
					});
				}
			}

			const result = await mergeDuplicateStories({
				projectId: input.projectId,
				survivorId: input.survivorId,
				duplicateId: input.duplicateId,
				userId: context.user.id,
				lastEditedByName: context.user.name ?? null,
				// Default (undefined) ⇒ keep-survivor in the query.
				pmLink: input.pmLink,
				// Only the rows whose object was actually copied move; the rest
				// stay on the duplicate rather than becoming dead entries on the
				// survivor. Left undefined when nothing was carried.
				attachmentKeyUpdates: carried.attachments.length
					? carried.attachments.map((a) => ({
							attachmentId: a.attachmentId,
							storageKey: a.targetKey,
						}))
					: undefined,
			});
			logger.info("[Duplicate Merge] merged duplicate into survivor", {
				projectId: input.projectId,
				...result,
				carriedMediaCount: carried.media.length,
				carriedAttachmentCount: carried.attachments.length,
				skippedAssetCount: carried.skipped.length,
			});
			return result;
		} catch (err) {
			throw new ORPCError("BAD_REQUEST", {
				message: err instanceof Error ? err.message : "Failed to merge",
			});
		}
	});
