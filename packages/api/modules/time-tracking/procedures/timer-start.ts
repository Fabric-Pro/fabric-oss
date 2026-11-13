import { ORPCError } from "@orpc/server";
import { getTimeTrackingPreference, startTimeTimer } from "@repo/database";
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
import { resolveProfileTimeZone } from "../lib/time-settings";
import {
	assertCanTimeProject,
	describeTimer,
	requireTimerOrganization,
	timerConflict,
	timerOrganizationInput,
} from "../lib/timer";

export const startTimerInputSchema = timeEntryFieldsObject
	.pick({
		projectId: true,
		activity: true,
		storyId: true,
		description: true,
		timezone: true,
	})
	.extend(timerOrganizationInput.shape);

/**
 * Start the caller's timer on an ACTIVE project of the organization, under
 * the same project and work item rules as `createEntry`. A member has one
 * timer per organization: while one is running or paused, a start answers
 * CONFLICT with it in `data.timer`.
 *
 * The timer runs in the time zone on the caller's profile when it is a real
 * IANA zone, and in the `timezone` the client sends (its browser's) when not:
 * the same rule a new entry starts under.
 *
 * A widget closed until the next start shows again; one turned off stays
 * off.
 */
export const startTimerProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.PROJECT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/time-tracking/timer/start",
		tags: ["Time tracking"],
		summary: "Start a timer",
		description:
			"Starts the caller's timer on a project they can log time on. Answers CONFLICT with the current timer when one is already running or paused.",
	})
	.input(startTimerInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = requireTimerOrganization(
			resolveOrganizationId(input.organizationId, context.session),
		);
		const userId = context.user.id;

		const project = await requireTimeTrackingProject(input.projectId);
		if (project.organizationId !== organizationId) {
			throw new ORPCError("NOT_FOUND", {
				message: PROJECT_NOT_FOUND_MESSAGE,
			});
		}
		await assertCanTimeProject(project.id, userId);
		assertAcceptsNewTime(project);
		const story = await snapshotStory({
			projectId: project.id,
			storyId: input.storyId,
		});

		const now = new Date();
		const result = await startTimeTimer({
			organizationId,
			userId,
			timezone: (await resolveProfileTimeZone(userId)) ?? input.timezone,
			startAt: now,
			values: {
				projectId: project.id,
				activity: input.activity,
				description: normalizeEntryDescription(input.description),
				billable: null,
				...story,
			},
		});
		switch (result.status) {
			case "started":
				return {
					timer: await describeTimer(result.timer, now),
					preference: await getTimeTrackingPreference({
						organizationId,
						userId,
					}),
				};
			case "exists":
				throw await timerConflict(
					result.timer,
					"You already have a timer running",
				);
			default: {
				const unreachable: never = result;
				throw new Error(
					`Unhandled timer start result: ${String(unreachable)}`,
				);
			}
		}
	});
