import { ORPCError } from "@orpc/server";
import {
	confirmTimeSuggestionAsEntry,
	findTimeEntryForSuggestion,
	type TimeSuggestionRow,
} from "@repo/database";
import { TIME_ACTIVITY_VALUES } from "@repo/utils/time-tracking";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import {
	assertProjectPermission,
	Permissions,
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
import { requireOwnSuggestion } from "../lib/suggestions";

/**
 * The entry fields a member may still change as they confirm. Every field
 * left out takes the suggestion's value; `billable` left out on both takes
 * the project's default. The project and work date are the suggestion's.
 */
export const confirmTimeSuggestionInputSchema = timeEntryFieldsObject
	.pick({
		timezone: true,
		billable: true,
		description: true,
		storyId: true,
		durationMinutes: true,
		startAt: true,
		stopAt: true,
		acknowledgedWarnings: true,
	})
	.extend({
		suggestionId: z.string().min(1).max(INPUT_BOUNDS.name),
		activity: z.enum(TIME_ACTIVITY_VALUES).optional(),
	})
	.refine(startStopGivenTogether, START_STOP_TOGETHER_ERROR);

type ConfirmTimeSuggestionInput = z.infer<
	typeof confirmTimeSuggestionInputSchema
>;

const ALREADY_CONFIRMED_MESSAGE = "This suggestion was already confirmed";

/** The time the entry is saved with: the caller's, else the suggestion's. */
function timingInput(
	input: Pick<
		ConfirmTimeSuggestionInput,
		"durationMinutes" | "startAt" | "stopAt"
	>,
	suggestion: TimeSuggestionRow,
): { durationMinutes?: number; startAt?: string; stopAt?: string } {
	if (input.startAt !== undefined && input.stopAt !== undefined) {
		return { startAt: input.startAt, stopAt: input.stopAt };
	}
	if (input.durationMinutes !== undefined) {
		return { durationMinutes: input.durationMinutes };
	}
	if (suggestion.startAt && suggestion.stopAt) {
		return {
			startAt: suggestion.startAt.toISOString(),
			stopAt: suggestion.stopAt.toISOString(),
		};
	}
	return { durationMinutes: suggestion.durationMinutes ?? undefined };
}

/**
 * Confirm one of the caller's own suggestions as a time entry.
 *
 * The entry goes through the same rules as `createEntry`: an ACTIVE project,
 * the project's current start/stop rule (a suggestion with only a duration
 * is refused on a project that requires start and stop, until the caller
 * gives them), the billable default, a work item of the project, and the
 * duplicate and daily-total warnings, answered with `needs_confirmation`
 * until acknowledged.
 *
 * Exactly once: a repeated or concurrent confirm returns the entry the first
 * one created, never a second entry. Someone else's suggestion answers
 * NOT_FOUND; the project is known only once the suggestion is loaded, so its
 * visibility and TIME_LOG are checked in the handler.
 */
export const confirmTimeSuggestionProcedure = tenantProtectedProcedure
	.route({
		method: "POST",
		path: "/time-tracking/suggestions/{suggestionId}/confirm",
		tags: ["Time tracking"],
		summary: "Confirm a time suggestion as a time entry",
		description:
			"Saves one of the caller's own suggestions as a time entry, with any fields the caller changed. Returns needs_confirmation with the warnings instead of saving when they are not in acknowledgedWarnings. Confirming again returns the same entry.",
	})
	.input(confirmTimeSuggestionInputSchema)
	.handler(async ({ input, context }): Promise<SaveTimeEntryResult> => {
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

		switch (suggestion.status) {
			case "PENDING":
				break;
			case "CONFIRMED": {
				const entry = await findTimeEntryForSuggestion({
					suggestionId: suggestion.id,
					userId,
				});
				if (!entry) {
					throw new ORPCError("CONFLICT", {
						message: ALREADY_CONFIRMED_MESSAGE,
					});
				}
				return {
					status: "saved",
					entry: serializeTimeEntry(entry),
					warnings: [],
				};
			}
			case "DISMISSED":
				throw new ORPCError("CONFLICT", {
					message: "This suggestion was dismissed",
				});
			default: {
				const unreachable: never = suggestion.status;
				throw new Error(
					`Unhandled suggestion status: ${String(unreachable)}`,
				);
			}
		}
		if (suggestion.expiresAt.getTime() <= Date.now()) {
			throw new ORPCError("CONFLICT", {
				message: "This suggestion has expired",
			});
		}

		const project = await requireTimeTrackingProject(suggestion.projectId);
		assertAcceptsNewTime(project);
		const startStopRequired = project.policy.startStopRequired;
		const timing = resolveEntryTiming(
			timingInput(
				{
					durationMinutes: input.durationMinutes,
					startAt: input.startAt,
					stopAt: input.stopAt,
				},
				suggestion,
			),
			startStopRequired,
		);
		const story = await snapshotStory({
			projectId: project.id,
			storyId:
				input.storyId !== undefined
					? input.storyId
					: suggestion.storyId,
		});
		const description = normalizeEntryDescription(
			input.description !== undefined
				? input.description
				: suggestion.description,
		);
		const activity = input.activity ?? suggestion.activity;

		const { warnings, blocked } = await evaluateEntryWarnings({
			organizationId: project.organizationId,
			userId,
			proposed: {
				projectId: project.id,
				workDate: suggestion.workDate,
				activity,
				storyId: story.storyId,
				description,
				...timing,
			},
			acknowledged: input.acknowledgedWarnings,
		});
		if (blocked) {
			return { status: "needs_confirmation", warnings };
		}

		const outcome = await confirmTimeSuggestionAsEntry({
			suggestionId: suggestion.id,
			organizationId: project.organizationId,
			userId,
			values: {
				projectId: project.id,
				workDate: suggestion.workDate,
				timezone: input.timezone,
				activity,
				billable:
					input.billable ??
					suggestion.billable ??
					project.policy.defaultBillable,
				description,
				startStopRequired,
				userNameSnapshot: context.user.name,
				...timing,
				...story,
			},
		});
		switch (outcome.status) {
			case "created":
				return {
					status: "saved",
					entry: serializeTimeEntry(outcome.entry),
					warnings,
				};
			case "existing":
				return {
					status: "saved",
					entry: serializeTimeEntry(outcome.entry),
					warnings: [],
				};
			case "not_pending":
				// Dismissed, or confirmed and its entry deleted, since it was
				// loaded above.
				throw new ORPCError("CONFLICT", {
					message:
						"This suggestion is no longer waiting for confirmation",
				});
			default: {
				const unreachable: never = outcome;
				throw new Error(
					`Unhandled confirm outcome: ${String(unreachable)}`,
				);
			}
		}
	});
