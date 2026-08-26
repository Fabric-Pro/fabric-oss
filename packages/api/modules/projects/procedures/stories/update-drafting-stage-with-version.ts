import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import {
	createFeatureVersion,
	db,
	type FeatureDraftingStage,
	FeatureDraftingStageSchema,
	getStoryById,
	StoryVersionConflictError,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
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
	READY_FOR_DEV_STAGE,
	shouldDraftOnReadyForDev,
	startAutoDraft,
} from "../../lib/auto-draft-test-cases";
import { enqueuePmSync } from "../../lib/enqueue-pm-sync";
import { extractStoryMediaKeysFromContent } from "../../lib/extract-story-media-keys";
import { logReinjectedAttachments } from "../../lib/log-reinjected-attachments";
import { stripInternalStoryFields } from "../../lib/strip-internal-story-fields";
import { validateStageForKind } from "../../lib/validate-stage-for-kind";
import { maybeTriggerMaturationScan } from "../scan/lib/start-scan";

/**
 * Called from the CopilotKit confirm_changes onConfirm handler.
 * Accepts the new content + target stage, creates a version snapshot
 * of the old content, updates the story with new content + stage,
 * and creates a version for the new content.
 */
export const updateDraftingStageWithVersionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/update-stage-with-version",
		tags: ["Projects", "Features"],
		summary: "Update feature stage with version history",
		description:
			"Update feature content and drafting stage while creating version snapshots",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			targetStage: FeatureDraftingStageSchema,
			description: z.string().nullable().optional(),
			acceptanceCriteria: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const story = await getStoryById(input.storyId, input.projectId);
		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Feature not found",
			});
		}
		validateStageForKind(input.targetStage, story.kind);

		const currentVersion = story.version ?? 1;
		const tenantContext = {
			userId: user.id,
			organizationId,
		};

		// Snapshot the pre-AI content as the prior version.
		await createFeatureVersion({
			storyId: input.storyId,
			version: currentVersion,
			description: story.description ?? null,
			acceptanceCriteria: story.acceptanceCriteria ?? null,
			draftingStage: story.draftingStage as FeatureDraftingStage,
			changeDescription: `Before ${input.targetStage.toLowerCase().replace(/_/g, " ")} enhancement`,
			changedBy: user.id,
			...tenantContext,
		});

		// Auto-reinject any `story-media/` attachments the AI rewrite dropped.
		// The system prompt asks the model to preserve in-body images, but
		// belt-and-braces protection guarantees the post-fix invariant even
		// when the model misbehaves. This is a recovery action, not an
		// error: a dropped image is a backend-invariant violation the user
		// cannot act on, so we silently restore the image markdown and emit
		// a structured `warn` for observability.
		//
		// Runs BEFORE the post-AI snapshot so the FeatureVersion row at
		// `newVersion` records what actually got persisted — rolling back to
		// it via FeatureVersionHistory must recover the reinjected
		// attachments, not the AI's truncated draft.
		const descriptionAfterGuard = await reinjectDroppedStoryMediaIfNeeded({
			projectId: input.projectId,
			storyId: input.storyId,
			priorDescription: story.description,
			incomingDescription: input.description,
			targetStage: input.targetStage as FeatureDraftingStage,
			draftingStage: story.draftingStage as FeatureDraftingStage | null,
		});
		const genuinelyChanged =
			(descriptionAfterGuard ?? story.description) !==
				story.description ||
			(input.acceptanceCriteria ?? story.acceptanceCriteria) !==
				story.acceptanceCriteria ||
			input.targetStage !== story.draftingStage;
		const changedAt = new Date();

		// Snapshot the post-AI (and post-guard) content as the new version.
		// Mirrors the persisted shape that lands in `db.userStory.update`
		// below so the audit trail and the live row agree byte-for-byte.
		const newVersion = currentVersion + 1;
		await createFeatureVersion({
			storyId: input.storyId,
			version: newVersion,
			description: descriptionAfterGuard ?? null,
			acceptanceCriteria: input.acceptanceCriteria ?? null,
			draftingStage: input.targetStage as FeatureDraftingStage,
			changeDescription: `AI-enhanced to ${input.targetStage.toLowerCase().replace(/_/g, " ")}`,
			changedBy: user.id,
			...tenantContext,
		});

		// Update the story with new content + stage, under the version this
		// handler read before it started.
		//
		// `currentVersion` is read at the top, and a version snapshot plus the
		// attachment-reinjection guard both run before we reach here — while the
		// editor autosaves the same row every 10s. Without `version` in the
		// predicate this wrote `version: newVersion` straight over whatever landed
		// in that window: the concurrent edit disappeared with no error, and the
		// version number it had already taken was reused. Adding the predicate
		// makes the write refuse instead, which is the contract `updateStory` has
		// always had.
		//
		// Prisma raises P2025 when the predicate matches nothing, so a lost race
		// is caught below and re-thrown as the typed conflict the API layer maps
		// to CONFLICT. `createFeatureVersion` above upserts, so a client retry
		// after a conflict leaves no duplicate snapshot.
		let updatedStory: Awaited<ReturnType<typeof db.userStory.update>>;
		try {
			updatedStory = await db.userStory.update({
				where: {
					id: input.storyId,
					projectId: input.projectId,
					version: currentVersion,
				},
				data: {
					description: descriptionAfterGuard ?? story.description,
					acceptanceCriteria:
						input.acceptanceCriteria ?? story.acceptanceCriteria,
					draftingStage: input.targetStage as FeatureDraftingStage,
					draftingStageUpdatedAt: changedAt,
					lastContextUpdateAt: new Date(),
					version: newVersion,
					...(genuinelyChanged
						? {
								lastEditedAt: changedAt,
								lastEditedByName: user.name ?? null,
								lastEditedSource: "AI_MATURATION" as const,
							}
						: {}),
					// Clear the auto-hide marker: any manual stage write is intentional
					// (not auto-hidden), so the UNHIDE provenance is reset (#1360 D1 matrix).
					pmAutoHidden: false,
				},
				include: {
					status: true,
					tasks: { orderBy: { order: "asc" } },
				},
			});
		} catch (error) {
			const isPrismaNotFound =
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "P2025";
			if (isPrismaNotFound) {
				throw new StoryVersionConflictError(input.storyId);
			}
			throw error;
		}

		// Auto-trigger a security & accessibility scan if this transition crosses
		// the project's configured maturation gate (best-effort, non-blocking).
		void maybeTriggerMaturationScan({
			projectId: input.projectId,
			storyId: input.storyId,
			previousStage: story.draftingStage as FeatureDraftingStage | null,
			newStage: input.targetStage as FeatureDraftingStage,
			userId: user.id,
			organizationId,
		});

		// Test-first: this is the OTHER way a feature reaches Ready for Dev —
		// the transition dialog inside the feature editor, rather than a drag on
		// the roadmap. Both write `draftingStage`, so a guarantee that only one
		// of them honours is not a guarantee. Queried lazily: this costs nothing
		// on the transitions that are not arrivals at Ready for Dev, which is
		// most of them.
		if (
			input.targetStage === READY_FOR_DEV_STAGE &&
			story.draftingStage !== READY_FOR_DEV_STAGE
		) {
			const eligibility = await db.userStory.findUnique({
				where: { id: input.storyId, projectId: input.projectId },
				select: {
					kind: true,
					project: {
						select: {
							// Read from the RECORD, not from the request. This
							// procedure's only guard authorizes `projectId`; the
							// ambient `organizationId` comes from
							// `resolveOrganizationId`, which returns a non-null
							// `input.organizationId` verbatim without a
							// membership check. Handing that to the drafting run
							// would resolve AI credentials and bill credits
							// against an org the caller may not belong to.
							organizationId: true,
							generateManualTestCases: true,
							applyTddApproach: true,
						},
					},
					_count: { select: { testCaseLinks: true } },
				},
			});
			if (
				eligibility &&
				shouldDraftOnReadyForDev({
					targetStage: input.targetStage,
					previousStage: story.draftingStage ?? "",
					kind: eligibility.kind,
					generateManualTestCases:
						eligibility.project?.generateManualTestCases ?? false,
					applyTddApproach:
						eligibility.project?.applyTddApproach ?? false,
					existingCaseCount: eligibility._count.testCaseLinks,
					testCasesEnabled: isTestCasesEnabled(),
				})
			) {
				runInBackground(
					startAutoDraft({
						projectId: input.projectId,
						organizationId:
							eligibility.project?.organizationId ?? null,
						userId: user.id,
						storyId: input.storyId,
						trigger: "ready-for-dev",
					}),
				);
			}
		}

		// CopilotKit confirm-changes accepts AI-rewritten description / AC.
		// Mirror the auto-sync gate from update-story.ts so accepting an
		// AI rewrite while auto-sync is on propagates to the linked PM
		// ticket — matching the behavior of editor-typed edits.
		const touchedPmContent =
			input.description !== undefined ||
			input.acceptanceCriteria !== undefined;
		if (updatedStory.pmAutoSyncEnabled && touchedPmContent) {
			enqueuePmSync({
				itemId: input.storyId,
				itemType: "story",
				projectId: input.projectId,
				userId: user.id,
				triggerSource: "manual-edit",
			}).catch((err) => {
				logger.warn("enqueuePmSync failed", {
					storyId: input.storyId,
					err: err instanceof Error ? err.message : String(err),
				});
			});
		}

		// Subscriber fan-out — this path always persists an AI-rewritten content
		// change (new version), so watchers are always notified. AI-initiated
		// changes notify subscribers per spec. Fire-and-forget.
		void fanOut
			.subscriptionUpdate({
				subjectType: "FEATURE",
				subjectId: input.storyId,
				projectId: input.projectId,
				organizationId: organizationId ?? null,
				actorUserId: user.id,
				actorName: user.name ?? "A teammate",
				title: updatedStory.title ?? "",
				link: `projects/${input.projectId}/stories/${input.storyId}`,
				changeKind: "content",
			})
			.catch((err) => {
				logger.warn(
					"[update-stage-with-version] subscription dispatch failed",
					{
						storyId: input.storyId,
						err: err instanceof Error ? err.message : String(err),
					},
				);
			});

		return { story: stripInternalStoryFields(updatedStory) };
	});

/**
 * Compute the set of `story-media/` keys present in the prior description
 * but missing from the AI-produced description, sign each one to a short-
 * lived URL, and return the incoming description with a `## Attachments`
 * footer that re-embeds the dropped keys as `![](signed-url)` markdown.
 *
 * Idempotent: on a second invocation with the already-
 * reinjected description, `droppedKeys` is empty and the function is a
 * no-op. The `story-media/<projectId>/<storyId>/` key-prefix check guards
 * against cross-story leakage (defense in depth — keys originate from the
 * tenant-validated story row).
 */
async function reinjectDroppedStoryMediaIfNeeded(params: {
	projectId: string;
	storyId: string;
	priorDescription: string | null | undefined;
	incomingDescription: string | null | undefined;
	targetStage: FeatureDraftingStage;
	draftingStage: FeatureDraftingStage | null;
}): Promise<string | null | undefined> {
	const {
		projectId,
		storyId,
		priorDescription,
		incomingDescription,
		targetStage,
		draftingStage,
	} = params;

	// Nothing to compare against if the incoming description is null /
	// undefined — preserve the existing "fall back to prior" semantics
	// that the caller relies on via `descriptionAfterGuard ?? story.description`.
	if (incomingDescription === null || incomingDescription === undefined) {
		return incomingDescription;
	}

	const oldKeys = extractStoryMediaKeysFromContent(priorDescription);
	if (oldKeys.length === 0) {
		return incomingDescription;
	}

	const newKeys = new Set(
		extractStoryMediaKeysFromContent(incomingDescription),
	);
	const droppedKeys = oldKeys.filter((key) => !newKeys.has(key));
	if (droppedKeys.length === 0) {
		return incomingDescription;
	}

	// Key-prefix safety check: every key must belong to the
	// current story's keyspace. Mismatches are skipped + logged at `error`
	// level — this should be impossible in practice since `priorDescription`
	// was already tenant-validated, but cheap to enforce here.
	const expectedPrefix = `story-media/${projectId}/${storyId}/`;
	const safeKeys: string[] = [];
	for (const key of droppedKeys) {
		if (key.startsWith(expectedPrefix)) {
			safeKeys.push(key);
		} else {
			logger.error("[stage-transition] dropped key failed prefix check", {
				key,
				expectedPrefix,
				storyId,
				projectId,
				surface: "stage-transition",
			});
		}
	}

	if (safeKeys.length === 0) {
		return incomingDescription;
	}

	const storageProvider = getStorageProvider();
	const bucket = config.storage.bucketNames.projectContexts;

	// Sign in parallel via `Promise.allSettled` so a single failed key
	// (e.g. the object was deleted out-of-band) does not block reinjection
	// of the surviving keys.
	const settled = await Promise.allSettled(
		safeKeys.map((key) =>
			storageProvider.getSignedUrl(key, {
				bucket,
				expiresIn: 3600,
			}),
		),
	);

	const signedPairs: Array<{ key: string; url: string }> = [];
	for (let index = 0; index < settled.length; index += 1) {
		const result = settled[index];
		const key = safeKeys[index];
		if (result.status === "fulfilled") {
			signedPairs.push({ key, url: result.value });
		} else {
			logger.error("[stage-transition] sign failed for dropped key", {
				key,
				storyId,
				projectId,
				surface: "stage-transition",
				error:
					result.reason instanceof Error
						? result.reason.message
						: String(result.reason),
			});
		}
	}

	if (signedPairs.length === 0) {
		return incomingDescription;
	}

	const attachmentsSection = `\n\n## Attachments\n\n${signedPairs
		.map(({ url }) => `![](${url})`)
		.join("\n")}`;

	logReinjectedAttachments({
		storyId,
		projectId,
		surface: "stage-transition",
		targetStage,
		draftingStage,
		droppedKeys: signedPairs.map(({ key }) => key),
	});

	return `${incomingDescription}${attachmentsSection}`;
}
