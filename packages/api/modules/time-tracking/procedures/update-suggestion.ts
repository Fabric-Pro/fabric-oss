import { ORPCError } from "@orpc/server";
import { updatePendingTimeSuggestion } from "@repo/database";
import { MAX_TIME_SUGGESTION_DESCRIPTION_LENGTH } from "@repo/utils/time-suggestions";
import {
	MAX_TIME_ENTRY_MINUTES,
	TIME_ACTIVITY_VALUES,
} from "@repo/utils/time-tracking";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import {
	assertProjectPermission,
	Permissions,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { resolveEntryTiming } from "../lib/entry-input";
import { assertProjectVisible } from "../lib/project-access";
import {
	assertAcceptsNewTime,
	requireTimeTrackingProject,
	snapshotStory,
} from "../lib/save-entry";
import {
	requireOwnSuggestion,
	serializeTimeSuggestion,
} from "../lib/suggestions";

export const updateTimeSuggestionInputSchema = z
	.object({
		suggestionId: z.string().min(1).max(INPUT_BOUNDS.name),
		activity: z.enum(TIME_ACTIVITY_VALUES),
		/** Null takes the project's billable default when it is confirmed. */
		billable: z.boolean().nullable(),
		description: z
			.string()
			.trim()
			.min(1)
			.max(MAX_TIME_SUGGESTION_DESCRIPTION_LENGTH),
		storyId: z.string().min(1).max(INPUT_BOUNDS.name).nullable(),
		/** Ignored when start and stop are given; null leaves it to confirm. */
		durationMinutes: z
			.number()
			.int()
			.positive()
			.max(MAX_TIME_ENTRY_MINUTES)
			.nullable(),
		startAt: z.iso.datetime({ offset: true }).nullable(),
		stopAt: z.iso.datetime({ offset: true }).nullable(),
	})
	.refine((input) => (input.startAt === null) === (input.stopAt === null), {
		message: "Give both a start and a stop time, or neither",
		path: ["stopAt"],
	});

/**
 * Replace the editable fields of one of the caller's own suggestions while it
 * waits for confirmation. Its project and work date stay as generated.
 *
 * Someone else's suggestion answers NOT_FOUND. The caller must still see the
 * suggestion's project and hold TIME_LOG there, and the project must still
 * accept new time; the work item must belong to it. The project's start/stop
 * rule is applied when the suggestion is confirmed, not here.
 */
export const updateTimeSuggestionProcedure = tenantProtectedProcedure
	.route({
		method: "PUT",
		path: "/time-tracking/suggestions/{suggestionId}",
		tags: ["Time tracking"],
		summary: "Change a time suggestion",
		description:
			"Replaces the activity, billable flag, description, work item and time of one of the caller's own pending suggestions.",
	})
	.input(updateTimeSuggestionInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const suggestion = await requireOwnSuggestion({
			suggestionId: input.suggestionId,
			userId,
		});
		await assertProjectVisible(suggestion.projectId, userId);
		await assertProjectPermission(
			suggestion.projectId,
			userId,
			Permissions.TIME_LOG,
		);
		if (suggestion.status !== "PENDING") {
			throw new ORPCError("CONFLICT", {
				message:
					"Only a suggestion waiting for confirmation can be changed",
			});
		}

		const project = await requireTimeTrackingProject(suggestion.projectId);
		assertAcceptsNewTime(project);
		const story = await snapshotStory({
			projectId: project.id,
			storyId: input.storyId,
		});
		const timing =
			input.startAt !== null && input.stopAt !== null
				? resolveEntryTiming(
						{ startAt: input.startAt, stopAt: input.stopAt },
						false,
					)
				: input.durationMinutes !== null
					? resolveEntryTiming(
							{ durationMinutes: input.durationMinutes },
							false,
						)
					: { durationMinutes: null, startAt: null, stopAt: null };

		const updated = await updatePendingTimeSuggestion({
			id: suggestion.id,
			userId,
			values: {
				activity: input.activity,
				billable: input.billable,
				description: input.description,
				...story,
				...timing,
			},
		});
		if (!updated) {
			throw new ORPCError("CONFLICT", {
				message:
					"Only a suggestion waiting for confirmation can be changed",
			});
		}
		return { suggestion: serializeTimeSuggestion(updated, project.policy) };
	});
