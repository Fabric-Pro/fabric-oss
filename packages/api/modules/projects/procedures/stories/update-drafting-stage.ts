import { ORPCError } from "@orpc/client";
import {
	db,
	type FeatureDraftingStage,
	FeatureDraftingStageSchema,
	updateStoryDraftingStage,
} from "@repo/database";
import { logger } from "@repo/logs";
import { isTestCasesEnabled } from "@repo/utils/feature-flag";
import { z } from "zod";
import { fanOut } from "../../../../lib/notification-service";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { runInBackground } from "../../../weave/lib/run-in-background";
import {
	shouldDraftOnReadyForDev,
	startAutoDraft,
} from "../../lib/auto-draft-test-cases";
import { stripInternalStoryFields } from "../../lib/strip-internal-story-fields";
import { validateStageForKind } from "../../lib/validate-stage-for-kind";

export const updateDraftingStageProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/drafting-stage",
		tags: ["Projects", "Features"],
		summary: "Update feature drafting stage",
		description: "Update a feature's drafting stage",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			targetStage: FeatureDraftingStageSchema,
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const existing = await db.userStory.findUnique({
			where: { id: input.storyId, projectId: input.projectId },
			select: {
				kind: true,
				draftingStage: true,
				title: true,
				// For the test-first auto-draft below. Selected here rather than
				// re-queried so the decision is made from one snapshot.
				project: {
					select: {
						// From the RECORD, not the request: `resolveOrganizationId`
						// returns a non-null `input.organizationId` verbatim, and
						// this procedure's guard authorizes `projectId` alone. The
						// drafting run resolves AI credentials and bills credits
						// against whatever org it is handed.
						organizationId: true,
						generateManualTestCases: true,
						applyTddApproach: true,
					},
				},
				_count: { select: { testCaseLinks: true } },
			},
		});
		if (!existing) {
			throw new ORPCError("NOT_FOUND", { message: "Story not found" });
		}
		validateStageForKind(input.targetStage, existing.kind);

		const story = await updateStoryDraftingStage(
			input.storyId,
			input.projectId,
			input.targetStage as FeatureDraftingStage,
			{
				userId: user.id,
				organizationId: organizationId ?? undefined,
				changedBy: user.id,
				lastEditedByName: user.name ?? null,
				lastEditedSource: "MANUAL",
			},
		);

		// Subscriber fan-out — notify watchers only on a real stage transition
		// (updateStoryDraftingStage is a no-op when the stage is unchanged).
		// Fire-and-forget; must never break the update.
		if (existing.draftingStage !== input.targetStage) {
			void fanOut
				.subscriptionUpdate({
					subjectType: "FEATURE",
					subjectId: input.storyId,
					projectId: input.projectId,
					organizationId: organizationId ?? null,
					actorUserId: user.id,
					actorName: user.name ?? "A teammate",
					title: story.title ?? existing.title ?? "",
					link: `projects/${input.projectId}/stories/${input.storyId}`,
					changeKind: "stage",
				})
				.catch((error) => {
					logger.warn(
						"[update-drafting-stage] subscription dispatch failed",
						{
							storyId: input.storyId,
							err:
								error instanceof Error
									? error.message
									: String(error),
						},
					);
				});
		}

		// Test-first: reaching Ready for Dev is what "drafted straight after the
		// requirements" means. Fire-and-forget — a drafting run that cannot start
		// must never fail the transition the user actually asked for.
		//
		// Scheduled with runInBackground rather than a bare `void`: on Vercel a
		// floating promise is not guaranteed to finish once the response is sent,
		// and the window that would be lost here spans the ledger claim. A run
		// killed between claiming and dispatching leaves a PENDING row that
		// blocks the feature's next draft until the staleness cutoff clears it.
		if (
			shouldDraftOnReadyForDev({
				targetStage: input.targetStage,
				previousStage: existing.draftingStage,
				kind: existing.kind,
				generateManualTestCases:
					existing.project?.generateManualTestCases ?? false,
				applyTddApproach: existing.project?.applyTddApproach ?? false,
				existingCaseCount: existing._count.testCaseLinks,
				testCasesEnabled: isTestCasesEnabled(),
			})
		) {
			runInBackground(
				startAutoDraft({
					projectId: input.projectId,
					organizationId: existing.project?.organizationId ?? null,
					userId: user.id,
					storyId: input.storyId,
					trigger: "ready-for-dev",
				}),
			);
		}

		return { story: stripInternalStoryFields(story) };
	});
