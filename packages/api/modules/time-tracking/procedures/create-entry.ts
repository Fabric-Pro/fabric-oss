import { createTimeEntry } from "@repo/database";
import { projectNotFoundUnlessVisible } from "../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	normalizeEntryDescription,
	resolveEntryTiming,
	START_STOP_TOGETHER_ERROR,
	startStopGivenTogether,
	timeEntryFieldsObject,
} from "../lib/entry-input";
import {
	assertAcceptsNewTime,
	evaluateEntryWarnings,
	requireTimeTrackingProject,
	type SaveTimeEntryResult,
	serializeTimeEntry,
	snapshotStory,
} from "../lib/save-entry";

export const createTimeEntryInputSchema = timeEntryFieldsObject.refine(
	startStopGivenTogether,
	START_STOP_TOGETHER_ERROR,
);

/**
 * Log a confirmed time entry on an ACTIVE project. The entry is saved under
 * the project's current effective policy, which it keeps for later edits.
 */
export const createTimeEntryProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.TIME_LOG))
	.route({
		method: "POST",
		path: "/time-tracking/entries",
		tags: ["Time tracking"],
		summary: "Log time on a project",
		description:
			"Saves one of the caller's time entries. Returns needs_confirmation with the warnings instead of saving when the entry looks like a duplicate or takes the day over 16 hours and those warnings are not in acknowledgedWarnings.",
	})
	.input(createTimeEntryInputSchema)
	.handler(async ({ input, context }): Promise<SaveTimeEntryResult> => {
		const project = await requireTimeTrackingProject(input.projectId);
		assertAcceptsNewTime(project);
		const startStopRequired = project.policy.startStopRequired;
		const timing = resolveEntryTiming(
			{
				durationMinutes: input.durationMinutes,
				startAt: input.startAt,
				stopAt: input.stopAt,
			},
			startStopRequired,
		);
		const story = await snapshotStory({
			projectId: project.id,
			storyId: input.storyId,
		});
		const description = normalizeEntryDescription(input.description);

		const { warnings, blocked } = await evaluateEntryWarnings({
			organizationId: project.organizationId,
			userId: context.user.id,
			proposed: {
				projectId: project.id,
				workDate: input.workDate,
				activity: input.activity,
				storyId: story.storyId,
				description,
				...timing,
			},
			acknowledged: input.acknowledgedWarnings,
		});
		if (blocked) {
			return { status: "needs_confirmation", warnings };
		}

		const entry = await createTimeEntry({
			organizationId: project.organizationId,
			userId: context.user.id,
			values: {
				projectId: project.id,
				workDate: input.workDate,
				timezone: input.timezone,
				activity: input.activity,
				billable: input.billable ?? project.policy.defaultBillable,
				description,
				startStopRequired,
				userNameSnapshot: context.user.name,
				...timing,
				...story,
			},
		});
		return { status: "saved", entry: serializeTimeEntry(entry), warnings };
	});
