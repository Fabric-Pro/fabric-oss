import { ORPCError } from "@orpc/server";
import { findTimeEntryForAuthor, updateTimeEntry } from "@repo/database";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import { projectNotFoundUnlessVisible } from "../../../orpc/middleware/project-visibility";
import {
	assertProjectPermission,
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
import { assertProjectVisible } from "../lib/project-access";
import {
	assertAcceptsNewTime,
	evaluateEntryWarnings,
	requireTimeTrackingProject,
	type SaveTimeEntryResult,
	serializeTimeEntry,
	snapshotStory,
} from "../lib/save-entry";

export const updateTimeEntryInputSchema = timeEntryFieldsObject
	.extend({ entryId: z.string().min(1).max(INPUT_BOUNDS.name) })
	.refine(startStopGivenTogether, START_STOP_TOGETHER_ERROR);

/**
 * Replace one of the caller's own time entries.
 *
 * `projectId` is where the entry ends up; the middleware checks that the
 * caller can see that project and holds TIME_LOG there. When it differs from
 * the entry's current project the caller must also still see and hold
 * TIME_LOG on the current one, the destination must be
 * ACTIVE, and the entry takes the destination's current policy. Otherwise it
 * is validated against the policy it was saved under, and an entry on an
 * archived or completed project can still be corrected in place, so
 * tightening or closing a project does not lock its existing entries.
 */
export const updateTimeEntryProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.TIME_LOG))
	.route({
		method: "PUT",
		path: "/time-tracking/entries/{entryId}",
		tags: ["Time tracking"],
		summary: "Change a logged time entry",
		description:
			"Replaces one of the caller's own time entries, possibly moving it to another project of the same organization. Returns needs_confirmation with the warnings instead of saving when they are not in acknowledgedWarnings.",
	})
	.input(updateTimeEntryInputSchema)
	.handler(async ({ input, context }): Promise<SaveTimeEntryResult> => {
		const existing = await findTimeEntryForAuthor({
			id: input.entryId,
			userId: context.user.id,
		});
		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "Time entry not found",
			});
		}

		const project = await requireTimeTrackingProject(input.projectId);
		const moving = project.id !== existing.projectId;
		if (moving) {
			assertAcceptsNewTime(project);
			if (project.organizationId !== existing.organizationId) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"A time entry can only move to a project of the same organization",
				});
			}
			await assertProjectVisible(existing.projectId, context.user.id);
			await assertProjectPermission(
				existing.projectId,
				context.user.id,
				Permissions.TIME_LOG,
			);
		}

		const startStopRequired = moving
			? project.policy.startStopRequired
			: existing.startStopRequired;
		const timing = resolveEntryTiming(
			{
				durationMinutes: input.durationMinutes,
				startAt: input.startAt,
				stopAt: input.stopAt,
			},
			startStopRequired,
		);
		const nextStoryId = input.storyId ?? null;
		const story =
			moving || nextStoryId !== existing.storyId
				? await snapshotStory({
						projectId: project.id,
						storyId: nextStoryId,
					})
				: {
						storyId: existing.storyId,
						storyIdentifier: existing.storyIdentifier,
						storyTitle: existing.storyTitle,
					};
		const description = normalizeEntryDescription(input.description);

		const { warnings, blocked } = await evaluateEntryWarnings({
			organizationId: existing.organizationId,
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
			editingEntryId: existing.id,
		});
		if (blocked) {
			return { status: "needs_confirmation", warnings };
		}

		const billable =
			input.billable ??
			(moving ? project.policy.defaultBillable : existing.billable);
		const entry = await updateTimeEntry({
			id: existing.id,
			userId: context.user.id,
			values: {
				projectId: project.id,
				workDate: input.workDate,
				timezone: input.timezone,
				activity: input.activity,
				billable,
				description,
				startStopRequired,
				userNameSnapshot: context.user.name,
				...timing,
				...story,
			},
		});
		return { status: "saved", entry: serializeTimeEntry(entry), warnings };
	});
