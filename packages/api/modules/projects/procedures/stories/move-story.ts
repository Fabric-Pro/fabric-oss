import { db, moveStory } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { fanOut } from "../../../../lib/notification-service";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { dispatchLifecycleEvent } from "../../../agent-deployments/lib/lifecycle-dispatcher";
import { enqueuePmSync } from "../../lib/enqueue-pm-sync";
import { fireColumnAutomations } from "../../lib/story-automations";
import { stripInternalStoryFields } from "../../lib/strip-internal-story-fields";

/**
 * After a successful status mutation, optionally enqueue a Temporal
 * push-to-PM workflow. Strict guards:
 *  - project.autoPushPmSync === true (project toggle)
 *  - story has externalId (was previously synced to PM tool)
 *  - story.lastPmSyncStatus !== "CONFLICT" (don't clobber remote drift)
 * Enqueue failures are logged but never thrown — moving a card must
 * not fail because sync infrastructure is down.
 */
export async function maybeEnqueueAutoPush(args: {
	projectId: string;
	storyId: string;
	userId: string;
}): Promise<void> {
	try {
		const project = await db.project.findUnique({
			where: { id: args.projectId },
			select: { autoPushPmSync: true },
		});
		if (!project?.autoPushPmSync) {
			return;
		}

		const story = await db.userStory.findUnique({
			where: { id: args.storyId },
			select: { externalId: true, lastPmSyncStatus: true },
		});
		if (!story?.externalId) {
			return;
		}
		if (story.lastPmSyncStatus === "CONFLICT") {
			return;
		}

		await enqueuePmSync({
			itemId: args.storyId,
			itemType: "story",
			projectId: args.projectId,
			userId: args.userId,
			triggerSource: "auto-push",
		});
	} catch (err) {
		console.error("[move-story] auto-push enqueue failed", {
			projectId: args.projectId,
			storyId: args.storyId,
			error: err,
		});
	}
}

export const moveStoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_MOVE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/move",
		tags: ["Projects", "Stories"],
		summary: "Move user story",
		description:
			"Move a user story to a different status column (Kanban drag-drop)",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			statusId: z.string(),
			order: z.number().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		const previousStory = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: { statusId: true },
		});
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const story = await moveStory(
			input.storyId,
			input.projectId,
			input.statusId,
			input.order,
			{
				lastEditedByName: user.name ?? null,
				lastEditedSource: "MANUAL",
			},
		);

		// Fire-and-forget: trigger column-based automations (Skills tagged with column name)
		if (story.status?.name) {
			const project = await db.project.findUnique({
				where: { id: input.projectId },
				select: { name: true },
			});
			fireColumnAutomations({
				storyId: story.id,
				storyTitle: story.title,
				storyIdentifier: story.identifier,
				projectId: input.projectId,
				projectName: project?.name ?? "",
				targetColumnName: story.status.name,
				userId: user.id,
				organizationId: organizationId ?? null,
			}).catch(() => {});
		}

		if (previousStory?.statusId !== input.statusId) {
			dispatchLifecycleEvent({
				resource: "story",
				event: "status_changed",
				projectId: input.projectId,
				entityId: story.id,
				userId: user.id,
				organizationId,
				data: {
					storyId: story.id,
					statusId: input.statusId,
					previousStatusId: previousStory?.statusId,
					statusName: story.status?.name,
				},
			}).catch((error) => {
				console.warn(
					"[LifecycleDispatcher] Story status_changed dispatch failed:",
					error,
				);
			});

			// Audit-log emission. Only fire when the status really
			// changed so cosmetic reorders within the same column do not spam
			// the ledger.
			recordAuditFromRequest(context, {
				action: "story.status_changed",
				category: "story",
				organizationId,
				projectId: input.projectId,
				resource: {
					type: "story",
					id: story.id,
					name: story.title ?? null,
				},
				metadata: {
					fromStatus: previousStory?.statusId ?? null,
					toStatus: input.statusId,
					statusName: story.status?.name ?? null,
				},
			});

			// Fan-out notifications for transitions into terminal/approval/blocked
			// statuses. Recipients are the story's assignee and the project owner;
			// self-notifications are filtered inside the helper.
			const [project, target, previous, storyDetail] = await Promise.all([
				db.project.findUnique({
					where: { id: input.projectId },
					select: { userId: true },
				}),
				db.projectStoryStatus.findUnique({
					where: { id: input.statusId },
					select: {
						name: true,
						isFinal: true,
						requiresApproval: true,
					},
				}),
				previousStory?.statusId
					? db.projectStoryStatus.findUnique({
							where: { id: previousStory.statusId },
							select: { name: true },
						})
					: Promise.resolve(null),
				db.userStory.findUnique({
					where: { id: input.storyId },
					select: { title: true, assigneeId: true },
				}),
			]);

			if (target && storyDetail) {
				const recipients = [
					storyDetail.assigneeId,
					project?.userId ?? null,
				].filter((id): id is string => Boolean(id));

				void fanOut
					.storyStatusChanged({
						storyId: input.storyId,
						storyTitle: storyDetail.title ?? "",
						projectId: input.projectId,
						organizationId: organizationId ?? null,
						actorUserId: user.id,
						actorName: user.name ?? "Someone",
						previousStatusId: previousStory?.statusId ?? null,
						previousStatusName: previous?.name ?? null,
						statusId: input.statusId,
						statusName: target.name,
						isFinal: target.isFinal,
						requiresApproval: target.requiresApproval,
						recipientUserIds: recipients,
						link: `projects/${input.projectId}/stories/${input.storyId}`,
					})
					.catch((error) => {
						console.warn(
							"[notification-service] storyStatusChanged fan-out failed:",
							error,
						);
					});
			}

			// Subscriber fan-out — notify watchers on EVERY status change (not
			// just terminal/approval/blocked, unlike storyStatusChanged above).
			// Distinct audience + category (SUBSCRIPTION) + dedupeKey, so a
			// subscriber who is also the assignee may legitimately get both rows.
			// Fire-and-forget; must never break the move.
			void fanOut
				.subscriptionUpdate({
					subjectType: "FEATURE",
					subjectId: input.storyId,
					projectId: input.projectId,
					organizationId: organizationId ?? null,
					actorUserId: user.id,
					actorName: user.name ?? "A teammate",
					title: story.title ?? "",
					link: `projects/${input.projectId}/stories/${input.storyId}`,
					changeKind: "status",
				})
				.catch((error) => {
					console.warn(
						"[notification-service] subscriptionUpdate fan-out failed:",
						error,
					);
				});
		}

		// Fire-and-forget: auto-push status change to PM tool if the toggle is on.
		// Failures are swallowed inside the helper — moving a card must not fail
		// because Temporal / the PM tool is temporarily unreachable.
		await maybeEnqueueAutoPush({
			projectId: input.projectId,
			storyId: input.storyId,
			userId: user.id,
		});

		return { story: stripInternalStoryFields(story) };
	});
