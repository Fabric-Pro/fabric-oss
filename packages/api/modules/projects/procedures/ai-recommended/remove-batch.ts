import { ORPCError } from "@orpc/server";
import {
	aiRecommendedAwaitingApprovalWhere,
	aiRecommendedEligibleWhere,
	aiRecommendedProtectedWhere,
	db,
	loadProjectStagePolicy,
	updateStoryDraftingStage,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { fanOut } from "../../../../lib/notification-service";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertCapabilityAvailable } from "../../../capabilities/assert";
import { mapStageTransitionError } from "../../lib/stage-transition-errors";
import { assertAiRecommendedLifecycleEnabled } from "./lifecycle-flag";

const MAX_ITEMS = 200;

const OUTCOMES = [
	"moved",
	"requested",
	"already-requested",
	"skipped-protected",
	"skipped-ineligible",
	"failed",
] as const;
type Outcome = (typeof OUTCOMES)[number];

type ItemResult = {
	storyId: string;
	identifier: string | null;
	title: string | null;
	outcome: Outcome;
	error?: string;
};

type StoryLabel = { id: string; identifier: string; title: string };

function errorMessage(error: unknown): string {
	const mapped = mapStageTransitionError(error);
	return mapped instanceof Error ? mapped.message : String(mapped);
}

/**
 * Hide the unprotected, untouched-by-approval items of ONE recommendation
 * batch (Fizzy #2211).
 *
 * The door re-derives everything from the shared eligibility predicate rather
 * than trusting the page. It acts only on `eligible ∩ expectedStoryIds`: an
 * item that became eligible after the preview is left alone and reported as
 * `notPreviewed`, and an item protected between the preview and the click is
 * re-checked inside its own transaction and skipped. That transaction first
 * locks the story row (`FOR UPDATE`), so a protect committing concurrently is
 * either seen by the re-check or waits until the item has been hidden — it can
 * never land between the re-check and the hide.
 *
 * Items are hidden one at a time, each through `updateStoryDraftingStage` in
 * its own transaction — the same choke point the Hide action uses — so a
 * governed project turns each one into an approval request (`requested`), one
 * failure does not undo the others, and no PM sync is enqueued.
 *
 * The capability gate's HIDDEN verdict ("no eligible batch") does not throw at
 * the door, so an empty removal is refused here, with PRECONDITION_FAILED and
 * `data.reason = "NO_ELIGIBLE_ITEMS"` plus the counts that explain why. That
 * payload is deliberately not the `{ gate }` shape a gate refusal carries.
 */
export const removeAiRecommendationBatchProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/ai-recommended-batches/{batchId}/remove",
		tags: ["Projects", "Features"],
		summary: "Hide the eligible items of an AI-recommended batch",
	})
	.input(
		z.object({
			projectId: z.string(),
			batchId: z.string(),
			expectedStoryIds: z.array(z.string()).min(1).max(MAX_ITEMS),
		}),
	)
	.output(
		z.object({
			results: z.array(
				z.object({
					storyId: z.string(),
					identifier: z.string().nullable(),
					title: z.string().nullable(),
					outcome: z.enum(OUTCOMES),
					error: z.string().optional(),
				}),
			),
			counts: z.object({
				moved: z.number().int(),
				requested: z.number().int(),
				alreadyRequested: z.number().int(),
				skippedProtected: z.number().int(),
				skippedIneligible: z.number().int(),
				failed: z.number().int(),
				notPreviewed: z.number().int(),
			}),
			governedReview: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, batchId } = input;
		const user = context.user;
		const { organizationId: projectOrganizationId } =
			await assertAiRecommendedLifecycleEnabled(projectId);

		await assertCapabilityAvailable({
			capabilityKey: "roadmap.remove-ai-recommended",
			projectId,
			userId: user.id,
			organizationId: projectOrganizationId,
		});

		const expected = new Set(input.expectedStoryIds);
		const [eligible, protectedItems, awaitingApproval, named, policy] =
			await Promise.all([
				db.userStory.findMany({
					where: aiRecommendedEligibleWhere(projectId, batchId),
					select: { id: true, identifier: true, title: true },
				}),
				db.userStory.findMany({
					where: aiRecommendedProtectedWhere(projectId, batchId),
					select: { id: true },
				}),
				db.userStory.findMany({
					where: aiRecommendedAwaitingApprovalWhere(
						projectId,
						batchId,
					),
					select: { id: true },
				}),
				db.userStory.findMany({
					where: { id: { in: [...expected] }, projectId },
					select: { id: true, identifier: true, title: true },
				}),
				loadProjectStagePolicy(db, projectId),
			]);

		const eligibleIds = new Set(eligible.map((story) => story.id));
		const protectedIds = new Set(protectedItems.map((story) => story.id));
		const awaitingIds = new Set(awaitingApproval.map((story) => story.id));
		const labels = new Map<string, StoryLabel>(
			named.map((story) => [story.id, story]),
		);

		const target = eligible.filter((story) => expected.has(story.id));
		const notPreviewed = eligible.length - target.length;

		const results: ItemResult[] = [];
		const record = (storyId: string, outcome: Outcome, error?: string) => {
			const label = labels.get(storyId);
			results.push({
				storyId,
				identifier: label?.identifier ?? null,
				title: label?.title ?? null,
				outcome,
				...(error !== undefined ? { error } : {}),
			});
		};
		const tally = (outcome: Outcome) =>
			results.filter((result) => result.outcome === outcome).length;

		for (const storyId of expected) {
			if (eligibleIds.has(storyId)) {
				continue;
			}
			record(
				storyId,
				protectedIds.has(storyId)
					? "skipped-protected"
					: awaitingIds.has(storyId)
						? "already-requested"
						: "skipped-ineligible",
			);
		}

		if (target.length === 0) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message: "No eligible items to remove",
				data: {
					reason: "NO_ELIGIBLE_ITEMS",
					protectedCount: tally("skipped-protected"),
					alreadyRequestedCount: tally("already-requested"),
					ineligibleCount: tally("skipped-ineligible"),
				},
			});
		}

		const stageChanged: StoryLabel[] = [];
		for (const story of target) {
			try {
				const outcome = await db.$transaction(async (tx) => {
					await tx.$queryRaw`SELECT id FROM user_story WHERE id = ${story.id} AND "projectId" = ${projectId} FOR UPDATE`;
					const still = await tx.userStory.findFirst({
						where: {
							id: story.id,
							...aiRecommendedEligibleWhere(projectId, batchId),
						},
						select: { id: true },
					});
					if (!still) {
						return "skipped-ineligible" as const;
					}
					const updated = await updateStoryDraftingStage(
						story.id,
						projectId,
						"CLOSED",
						{
							userId: user.id,
							organizationId: projectOrganizationId ?? undefined,
							changedBy: user.id,
							lastEditedByName: user.name ?? null,
							lastEditedSource: "MANUAL",
							transitionReason: "manual",
						},
						tx,
					);
					const pendingStageRequestId = (
						updated as { pendingStageRequestId?: string }
					).pendingStageRequestId;
					return pendingStageRequestId
						? ("requested" as const)
						: ("moved" as const);
				});
				record(story.id, outcome);
				if (outcome !== "skipped-ineligible") {
					stageChanged.push(story);
				}
			} catch (error) {
				record(story.id, "failed", errorMessage(error));
			}
		}

		// Watchers hear about each item whose stage changed or became a
		// request, as they do from the single-item Hide. Fire-and-forget: a
		// notification failure must never fail the removal.
		for (const story of stageChanged) {
			void fanOut
				.subscriptionUpdate({
					subjectType: "FEATURE",
					subjectId: story.id,
					projectId,
					organizationId: projectOrganizationId,
					actorUserId: user.id,
					actorName: user.name ?? "A teammate",
					title: story.title,
					link: `projects/${projectId}/stories/${story.id}`,
					changeKind: "stage",
				})
				.catch((error) => {
					logger.warn(
						"[AiRecommended] subscription dispatch failed",
						{
							storyId: story.id,
							err:
								error instanceof Error
									? error.message
									: String(error),
						},
					);
				});
		}

		const counts = {
			moved: tally("moved"),
			requested: tally("requested"),
			alreadyRequested: tally("already-requested"),
			skippedProtected: tally("skipped-protected"),
			skippedIneligible: tally("skipped-ineligible"),
			failed: tally("failed"),
			notPreviewed,
		};

		logger.info("[AiRecommended] Batch removal", {
			projectId,
			batchId,
			userId: user.id,
			counts,
		});

		return {
			results,
			counts,
			governedReview: policy.reviewRequired,
		};
	});
