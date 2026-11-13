import { ORPCError } from "@orpc/server";
import { updateTimeTimer } from "@repo/database";
import { TIME_ACTIVITY_VALUES } from "@repo/utils/time-tracking";
import { z } from "zod";
import { PROJECT_NOT_FOUND_MESSAGE } from "../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	normalizeEntryDescription,
	timeEntryFieldsObject,
} from "../lib/entry-input";
import {
	assertAcceptsNewTime,
	requireTimeTrackingProject,
	snapshotStory,
} from "../lib/save-entry";
import {
	assertCanTimeProject,
	describeTimer,
	requireOwnTimer,
	requireTimerOrganization,
	timerChangeInput,
	timerConflict,
} from "../lib/timer";

/**
 * What the caller changes on their timer; every field left out is kept.
 * `billable: null` goes back to the project's default; `storyId: null` and
 * `description: null` clear them.
 */
export const updateTimerInputSchema = timerChangeInput.extend({
	projectId: timeEntryFieldsObject.shape.projectId.optional(),
	activity: z.enum(TIME_ACTIVITY_VALUES).optional(),
	storyId: timeEntryFieldsObject.shape.storyId,
	description: timeEntryFieldsObject.shape.description,
	billable: z.boolean().nullable().optional(),
});

/**
 * Change what the caller's running or paused timer is timing. Moving it to
 * another project takes the same checks as starting there, and clears the
 * work item unless a work item of the new project is given.
 */
export const updateTimerProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.PROJECT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/time-tracking/timer/update",
		tags: ["Time tracking"],
		summary: "Change the caller's timer",
		description:
			"Changes the project, activity, work item, description or billable flag of the caller's timer. A stale version answers CONFLICT with the current timer.",
	})
	.input(updateTimerInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = requireTimerOrganization(
			resolveOrganizationId(input.organizationId, context.session),
		);
		const userId = context.user.id;
		const timer = await requireOwnTimer({
			organizationId,
			userId,
			timerId: input.timerId,
		});
		await assertCanTimeProject(timer.projectId, userId);
		if (timer.version !== input.version) {
			throw await timerConflict(timer);
		}

		const projectId = input.projectId ?? timer.projectId;
		const projectChanged = projectId !== timer.projectId;
		if (projectChanged) {
			const project = await requireTimeTrackingProject(projectId);
			if (project.organizationId !== organizationId) {
				throw new ORPCError("NOT_FOUND", {
					message: PROJECT_NOT_FOUND_MESSAGE,
				});
			}
			await assertCanTimeProject(projectId, userId);
			assertAcceptsNewTime(project);
		}
		const story =
			input.storyId !== undefined || projectChanged
				? await snapshotStory({
						projectId,
						storyId: input.storyId ?? null,
					})
				: {
						storyId: timer.storyId,
						storyIdentifier: timer.storyIdentifier,
						storyTitle: timer.storyTitle,
					};

		const updated = await updateTimeTimer({
			timerId: timer.id,
			organizationId,
			userId,
			version: input.version,
			values: {
				projectId,
				activity: input.activity ?? timer.activity,
				description:
					input.description !== undefined
						? normalizeEntryDescription(input.description)
						: timer.description,
				billable:
					input.billable !== undefined
						? input.billable
						: timer.billable,
				...story,
			},
		});
		if (!updated) {
			throw await timerConflict(
				await requireOwnTimer({
					organizationId,
					userId,
					timerId: input.timerId,
				}),
			);
		}
		return { timer: await describeTimer(updated, new Date()) };
	});
