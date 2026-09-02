import { ORPCError } from "@orpc/client";
import {
	db,
	type FeatureDraftingStage,
	FeatureDraftingStageSchema,
	getProjectQaSettings,
	getQaSignOffStatus,
	getStoryCoverage,
	MaturationStatusSchema,
	type StoryPriority,
	type StorySize,
	setLastContextUpdateAt,
	updateStory,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { fanOut } from "../../../../lib/notification-service";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { runInBackground } from "../../../weave/lib/run-in-background";
import { maybeAutoDraftOnStageChange } from "../../lib/auto-draft-test-cases";
import { enqueuePmSync } from "../../lib/enqueue-pm-sync";
import { stripInternalStoryFields } from "../../lib/strip-internal-story-fields";
import { validateStageForKind } from "../../lib/validate-stage-for-kind";
import { maybeTriggerMaturationScan } from "../scan/lib/start-scan";

export const updateStoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/stories/{storyId}",
		tags: ["Projects", "Stories"],
		summary: "Update user story",
		description: "Update a user story's details",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			title: z.string().min(1).max(500).optional(),
			description: z.string().optional().nullable(),
			acceptanceCriteria: z.string().optional().nullable(),
			priority: z
				.enum(["P0_CRITICAL", "P1_HIGH", "P2_MEDIUM", "P3_LOW"])
				.optional(),
			size: z.enum(["XS", "S", "M", "L", "XL"]).optional().nullable(),
			storyPoints: z.number().int().min(0).max(100).optional().nullable(),
			assigneeId: z.string().optional().nullable(),
			externalId: z.string().optional().nullable(),
			externalUrl: z.string().url().optional().nullable(),
			draftingStage: FeatureDraftingStageSchema.optional(),
			// Maturation V2 "dummy" status label (To Do / Discovery / Done). Pure
			// label — carries no logic; persisted verbatim with no FeatureVersion
			// snapshot or stage side-effect. Null clears it.
			maturationStatus: MaturationStatusSchema.optional().nullable(),
			/**
			 * Why this feature is being marked done below the project's coverage
			 * target. Required only when it actually is below; supplying one when
			 * the target is met records nothing, so a client that always sends it
			 * cannot manufacture an override.
			 */
			coverageOverrideReason: z
				.string()
				.trim()
				.min(1)
				.max(500)
				.optional(),
			// Per-feature opt-in for auto-pushing edits to the linked PM tool.
			// Flipping this from false to true on a story without an externalId
			// arms the next save to perform the initial PM-tool create (see the
			// initial-push gate below). The persisted value is the source of
			// truth — the database wins over `input` for the gate decision.
			pmAutoSyncEnabled: z.boolean().optional(),
			// Indicates if this save originated from an AI context refresh (e.g. Update Full Spec)
			isContextUpdate: z.boolean().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Capture prior assignee + version so we can detect changes after the
		// update without depending on whatever updateStory returns. `updateStory`
		// bumps `version` only on a real content/stage change (description,
		// acceptanceCriteria, or draftingStage) — never on a title-only or
		// metadata-only edit — so a version delta is the precise "notify
		// subscribers" signal.
		const prior = await db.userStory.findFirst({
			where: {
				id: input.storyId,
				projectId: input.projectId,
			},
			select: {
				assigneeId: true,
				title: true,
				version: true,
				// Read so the sign-off gate can fire on the TRANSITION to DONE
				// rather than on the value — see below.
				maturationStatus: true,
			},
		});

		// Validate target stage against the story's kind so a stale client
		// can't push a bug into SANITY_CHECK or any other feature-only stage.
		// Capture the prior drafting stage so the maturation-gate auto-scan
		// fires only on a real transition INTO the gate (not edits at the gate).
		let previousStage: FeatureDraftingStage | null = null;
		if (input.draftingStage) {
			const existingForStage = await db.userStory.findUnique({
				where: { id: input.storyId, projectId: input.projectId },
				select: { kind: true, draftingStage: true },
			});
			if (!existingForStage) {
				throw new ORPCError("NOT_FOUND", {
					message: "Story not found",
				});
			}
			validateStageForKind(
				input.draftingStage as FeatureDraftingStage,
				existingForStage.kind,
			);
			previousStage = existingForStage.draftingStage;
		}

		// Filled only when the coverage gate below was overridden, so a feature
		// that met its target writes nothing and the record stays meaningful.
		let coverageOverride: {
			coverageOverrideReason: string;
			coverageOverrideById: string;
			coverageOverrideAt: Date;
		} | null = null;

		// QA sign-off gate. Only DONE is gated: TO_DO and DISCOVERY are ordinary
		// board movement, and blocking those would stop people organising work
		// they have not finished yet — the opposite of the intent.
		//
		// Reads the threshold per call rather than caching it, so raising the
		// requirement takes effect on the next attempt rather than on the next
		// deploy. `required: 0` is the default and short-circuits to satisfied,
		// which is what keeps every unconfigured project unaffected.
		// Gate the TRANSITION, not the value. A client that echoes the story's
		// current status alongside an unrelated edit — a title change on a feature
		// that is already done — must not be refused; re-affirming a state the
		// feature is already in is not progress, and blocking it would make an
		// already-shipped feature uneditable the moment somebody raised the
		// threshold.
		//
		// A missing `prior` (story not found) is treated as not-yet-DONE, so the
		// gate still applies; the update below fails on its own terms anyway.
		if (
			input.maturationStatus === "DONE" &&
			prior?.maturationStatus !== "DONE"
		) {
			const signOffs = await getQaSignOffStatus({
				projectId: input.projectId,
				userStoryId: input.storyId,
			});
			if (!signOffs.satisfied) {
				throw new ORPCError("FORBIDDEN", {
					message: `This project requires ${signOffs.required} QA sign-off${
						signOffs.required === 1 ? "" : "s"
					} before a feature can be marked done. ${
						signOffs.recorded
					} recorded so far.`,
				});
			}

			// The test coverage gate — its own setting (`testCoverageTarget`), not
			// the reporting `coverageTarget` the rings read. One number once drove
			// both, which armed a blocking transition from a field the settings
			// screen described as an automation-reporting target.
			//
			// Refuses the move to Done below target, but takes a reason instead
			// of being immovable. A low-risk feature may legitimately ship under
			// it, and a second wall as absolute as the sign-off gate would
			// strand work for a far less clear-cut reason. What the override is
			// NOT is silent: it is recorded on the feature, so a team shipping
			// under target repeatedly can see that it did and why.
			//
			// Read per call like the sign-off threshold above, so raising the
			// target takes effect on the next attempt rather than the next
			// deploy. 0 — the default for every project — short-circuits to off.
			const qaSettings = await getProjectQaSettings(input.projectId);
			const target = qaSettings?.testCoverageTarget ?? 0;
			if (target > 0) {
				const coverage = await getStoryCoverage({
					projectId: input.projectId,
					userStoryId: input.storyId,
				});
				const reason = input.coverageOverrideReason?.trim();
				if (coverage.percent < target && !reason) {
					throw new ORPCError("FORBIDDEN", {
						message: `This feature covers ${coverage.percent}% of its acceptance criteria (${coverage.coveredCriteria} of ${coverage.totalCriteria}), and this project asks for ${target}%. Add cases for the uncovered criteria, or record a reason for shipping under the target.`,
						data: {
							errorCode: "COVERAGE_BELOW_TARGET",
							percent: coverage.percent,
							target,
							coveredCriteria: coverage.coveredCriteria,
							totalCriteria: coverage.totalCriteria,
						},
					});
				}
				// Only stamped when the override was actually needed. A feature
				// that met its target carries no override, so the columns stay
				// null and the record means what it says.
				if (coverage.percent < target && reason) {
					coverageOverride = {
						coverageOverrideReason: reason,
						coverageOverrideById: user.id,
						coverageOverrideAt: new Date(),
					};
				}
			}
		}

		const story = await updateStory(
			input.storyId,
			input.projectId,
			{
				title: input.title,
				description: input.description,
				acceptanceCriteria: input.acceptanceCriteria,
				priority: input.priority as StoryPriority | undefined,
				size: input.size as StorySize | null | undefined,
				storyPoints: input.storyPoints,
				assigneeId: input.assigneeId,
				externalId: input.externalId,
				externalUrl: input.externalUrl,
				draftingStage: input.draftingStage as
					| FeatureDraftingStage
					| undefined,
				maturationStatus: input.maturationStatus,
				...(coverageOverride ?? {}),
				pmAutoSyncEnabled: input.pmAutoSyncEnabled,
			},
			{
				userId: user.id,
				organizationId,
				changedBy: user.id,
				// The database boundary proves whether a classified field changed,
				// so metadata-only saves count while identical submissions do not.
				lastEditedSource: "MANUAL",
				lastEditedByName: user.name ?? null,
			},
		);

		// If this update was driven by an AI context refresh, stamp the context update timer
		if (input.isContextUpdate) {
			void setLastContextUpdateAt({
				userStoryId: input.storyId,
				projectId: input.projectId,
				at: new Date(),
			}).catch((error) => {
				logger.warn(
					"[update-story] Failed to stamp lastContextUpdateAt:",
					error,
				);
			});
		}

		// Auto-trigger a security & accessibility scan when this update crosses
		// the project's configured maturation gate (best-effort, non-blocking).
		if (input.draftingStage) {
			void maybeTriggerMaturationScan({
				projectId: input.projectId,
				storyId: input.storyId,
				previousStage,
				newStage: input.draftingStage as FeatureDraftingStage,
				userId: user.id,
				organizationId,
			});

			// This is the generic save the feature editor's own stage dropdown
			// posts to, so a user choosing "Ready for Dev" and pressing Save
			// lands here rather than on the dedicated stage procedures. It has
			// to run the test-first trigger for the same reason they do.
			runInBackground(
				maybeAutoDraftOnStageChange({
					projectId: input.projectId,
					storyId: input.storyId,
					userId: user.id,
					previousStage,
					targetStage: input.draftingStage,
				}),
			);
		}

		// Notify the new assignee when assignment changes. Independent of PM
		// sync below — covers the in-app notification surface only.
		if (
			input.assigneeId !== undefined &&
			input.assigneeId !== null &&
			input.assigneeId !== prior?.assigneeId
		) {
			void fanOut
				.assigned({
					recipientUserId: input.assigneeId,
					storyId: input.storyId,
					projectId: input.projectId,
					organizationId: organizationId ?? null,
					actorUserId: user.id,
					actorName: user.name ?? "Someone",
					link: `projects/${input.projectId}/stories/${input.storyId}`,
					itemTitle: input.title ?? prior?.title ?? "",
					previousAssigneeId: prior?.assigneeId ?? null,
				})
				.catch((error) => {
					console.warn(
						"[notification-service] Story assignment fan-out failed:",
						error,
					);
				});
		}

		// Subscriber fan-out — notify watchers on a real content/stage change
		// (version bumped). Title-only / metadata-only edits leave the version
		// untouched and do NOT notify. Fire-and-forget; must never break the save.
		if (prior != null && story.version !== prior.version) {
			const isStageOnly =
				input.description === undefined &&
				input.acceptanceCriteria === undefined &&
				input.draftingStage !== undefined;
			void fanOut
				.subscriptionUpdate({
					subjectType: "FEATURE",
					subjectId: input.storyId,
					projectId: input.projectId,
					organizationId: organizationId ?? null,
					actorUserId: user.id,
					actorName: user.name ?? "A teammate",
					title: story.title ?? input.title ?? prior.title ?? "",
					link: `projects/${input.projectId}/stories/${input.storyId}`,
					changeKind: isStageOnly ? "stage" : "content",
				})
				.catch((error) => {
					logger.warn("[update-story] subscription dispatch failed", {
						storyId: input.storyId,
						err:
							error instanceof Error
								? error.message
								: String(error),
					});
				});
		}

		// Only enqueue PM sync when fields the PM tool actually stores have
		// changed. Kanban metadata edits (priority, size, assignee,
		// draftingStage) do not warrant a no-op revision in the PM tool.
		const touchedPmContent =
			input.title !== undefined ||
			input.description !== undefined ||
			input.acceptanceCriteria !== undefined;

		// Initial-push gate relaxation: when the story has no externalId yet AND
		// the user has just flipped pmAutoSyncEnabled to true in this same
		// update, fire enqueuePmSync even with no PM-relevant field diff so the
		// workflow's create-then-link branch runs. The persisted post-update
		// `story.pmAutoSyncEnabled` is the source of truth — a simultaneous
		// PATCH from another client cannot bypass the gate by sending
		// `pmAutoSyncEnabled: true` here while the row says false.
		const isInitialPushArmed =
			story.pmAutoSyncEnabled &&
			!story.externalId &&
			input.pmAutoSyncEnabled === true;

		// Gate on the persisted toggle. When false we skip silently (no log,
		// no exception) — every Fabric-only edit would otherwise emit noise.
		if (
			story.pmAutoSyncEnabled &&
			(touchedPmContent || isInitialPushArmed)
		) {
			if (isInitialPushArmed) {
				// Structured-log telemetry for the initial-push relaxation
				// path. The editor toggle is the only call path that arms
				// this gate, so `source` is constant. Mirrors the
				// `[ai_title_edited]` pattern at `StoryWorkspace.tsx:1571`.
				logger.info("[pm_sync_initial_push_triggered]", {
					storyId: input.storyId,
					projectId: input.projectId,
					organizationId,
					userId: user.id,
					source: "editor",
				});
			}
			enqueuePmSync({
				itemId: input.storyId,
				itemType: "story",
				projectId: input.projectId,
				userId: user.id,
				triggerSource: "manual-edit",
				forceInitialPush: isInitialPushArmed,
			}).catch((err) => {
				logger.warn("enqueuePmSync failed", {
					storyId: input.storyId,
					err: err instanceof Error ? err.message : String(err),
				});
			});
		}

		// Audit-log emission. Metadata records which fields the
		// caller asked to change rather than the resolved values — that keeps
		// diff size predictable and avoids leaking large description text into
		// the audit row.
		const changedFields = Object.entries(input)
			.filter(
				([key, value]) =>
					value !== undefined &&
					key !== "projectId" &&
					key !== "storyId" &&
					key !== "organizationId",
			)
			.map(([key]) => key);
		recordAuditFromRequest(context, {
			action: "story.updated",
			category: "story",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "story",
				id: story.id,
				name: story.title ?? null,
			},
			metadata: {
				changedFields,
			},
		});

		return { story: stripInternalStoryFields(story) };
	});
