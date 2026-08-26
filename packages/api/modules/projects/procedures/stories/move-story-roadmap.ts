import { ORPCError } from "@orpc/client";
import { db, type Prisma, recordPriorityMove } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const moveStoryRoadmapProcedure = tenantProtectedProcedure
	// The audit row this procedure writes is tagged with the caller-supplied
	// organizationId, and requireProjectPermission validates only (projectId,
	// userId) — so without this a caller could inject a `story.updated` row
	// into an org they don't belong to. Asserts membership of the target org,
	// bringing this to parity with the priority procedures added alongside it.
	.use(requireInputOrgPermission(Permissions.STORY_UPDATE))
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/move-roadmap",
		tags: ["Projects", "Stories"],
		summary: "Move a story to a new Roadmap priority bucket",
		description:
			"Atomically writes the moved story's new priority + roadmapOrder and compacts the target bucket. The server reads the full target bucket (including hidden CLOSED peers) and rewrites roadmapOrder for every story in the bucket; the client only sends an insertion-point hint. A drag that crosses lanes also records a priority-history row; a drag within one lane records none. Emits a story.updated audit row. Does NOT enqueue PM sync (priority is Fabric-only per spec).",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			newPriority: z.enum([
				"P0_CRITICAL",
				"P1_HIGH",
				"P2_MEDIUM",
				"P3_LOW",
			]),
			// null/undefined = append to end of target bucket.
			// Otherwise: insert the moved story immediately BEFORE this peer id.
			insertBeforeId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const { movedTitle, bandChanged } = await db.$transaction(
			async (tx: Prisma.TransactionClient) => {
				// 1. Load the moved story (need its title for audit, confirm it exists).
				const moved = await tx.userStory.findUnique({
					where: { id: input.storyId, projectId: input.projectId },
					select: { id: true, title: true, priority: true },
				});
				if (!moved) {
					throw new ORPCError("NOT_FOUND", {
						message: "Story not found in project",
					});
				}

				// 2. Load the full target bucket — ALL stories with priority=newPriority
				//    for this project, including the moved story (if it's already
				//    there) and including CLOSED draftingStage. We rewrite
				//    roadmapOrder for everyone, so hidden-by-filter peers get a
				//    consistent value.
				const bucket = await tx.userStory.findMany({
					where: {
						projectId: input.projectId,
						priority: input.newPriority,
					},
					select: { id: true },
					// Sort by current roadmapOrder, then by id (matches client tiebreaker).
					orderBy: [{ roadmapOrder: "asc" }, { id: "asc" }],
				});

				// 3. Remove the moved id from the bucket (whether it was there or
				//    not) so we can re-insert at the requested position.
				const without = bucket.filter((s) => s.id !== input.storyId);

				// 4. Compute insertion index. Default = append (insertIndex = without.length).
				let insertIndex = without.length;
				if (input.insertBeforeId != null) {
					const idx = without.findIndex(
						(s) => s.id === input.insertBeforeId,
					);
					if (idx === -1) {
						throw new ORPCError("BAD_REQUEST", {
							message:
								"insertBeforeId is not present in the target priority bucket",
						});
					}
					insertIndex = idx;
				}

				// 5. Build the new full bucket ordering (moved story slotted in).
				const orderedIds = [
					...without.slice(0, insertIndex).map((s) => s.id),
					input.storyId,
					...without.slice(insertIndex).map((s) => s.id),
				];

				// 6. Record the band move — and only a real move. Dropping a card
				//    back into its own lane changes the ordering alone, which is a
				//    presentation change and must leave no trace in the history.
				//    Goes through the same helper the priority dropdown and the AI
				//    pass use, so the drag can't drift from them on what a move
				//    means. Its rebase (bottom of the new band) is deliberately
				//    discarded: the user dropped the card at a chosen position, and
				//    step 5 already computed the rank that position implies.
				const bandChanged = moved.priority !== input.newPriority;
				const priorityChangedAt = new Date();
				if (bandChanged) {
					await recordPriorityMove(tx, {
						storyId: input.storyId,
						projectId: input.projectId,
						fromPriority: moved.priority,
						toPriority: input.newPriority,
						source: "MANUAL",
						actorId: context.user.id,
						actorName: context.user.name ?? null,
						changedAt: priorityChangedAt,
					});
				}

				// 7. Write priority+roadmapOrder for the moved story when its band
				//    flipped; write roadmapOrder alone for every other story in the
				//    bucket — and for the moved story too when it stayed in its lane.
				//    Raw SQL on purpose: a Prisma `update` trips the model's
				//    `@updatedAt`, which would reset the "last updated" timestamp on
				//    every reordered peer. A drag-reorder is a presentation change,
				//    not a content edit, so the roadmap's "last active" dates must be
				//    left untouched — raw UPDATE writes only the columns we name.
				for (let i = 0; i < orderedIds.length; i++) {
					const id = orderedIds[i];
					const roadmapOrder = i + 1;
					if (id === input.storyId && bandChanged) {
						// A drag carries no comment, so the denormalised rationale
						// is cleared to NULL — the change is still recorded in the
						// history, it just has no "why" line.
						await tx.$executeRaw`
							UPDATE "user_story"
							SET "priority" = ${input.newPriority}::"StoryPriority",
								"roadmapOrder" = ${roadmapOrder},
								"priorityChangedAt" = ${priorityChangedAt},
								"priorityChangeReason" = NULL,
								"lastEditedAt" = ${priorityChangedAt},
								"lastEditedByName" = ${context.user.name ?? null},
								"lastEditedSource" = 'MANUAL'::"LastEditSource"
							WHERE "id" = ${id} AND "projectId" = ${input.projectId}`;
					} else {
						await tx.$executeRaw`
							UPDATE "user_story"
							SET "roadmapOrder" = ${roadmapOrder}
							WHERE "id" = ${id} AND "projectId" = ${input.projectId}`;
					}
				}

				return { movedTitle: moved.title ?? null, bandChanged };
			},
		);

		recordAuditFromRequest(context, {
			action: "story.updated",
			category: "story",
			organizationId,
			projectId: input.projectId,
			resource: { type: "story", id: input.storyId, name: movedTitle },
			metadata: {
				// Report only what actually moved: a same-lane drag changed the
				// order alone, so claiming "priority" changed here would make the
				// audit log disagree with the (now correct) priority history,
				// which writes nothing on a same-lane drag.
				changedFields: bandChanged
					? ["priority", "roadmapOrder"]
					: ["roadmapOrder"],
				via: "roadmap-drag",
			},
		});

		return { success: true };
	});
