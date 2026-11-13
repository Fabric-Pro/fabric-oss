import { ORPCError } from "@orpc/server";
import {
	DEFAULT_TIME_SUGGESTION_SPAN_DAYS,
	localDateOf,
	MAX_TIME_SUGGESTION_SPAN_DAYS,
} from "@repo/utils/time-suggestions";
import {
	addDays,
	inclusiveDaySpan,
	isIsoDate,
	isValidTimeZone,
} from "@repo/utils/time-tracking";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	type RefreshTimeSuggestionsResult,
	refreshTimeSuggestions,
} from "../lib/automatic-suggestions";
import { workDateSchema } from "../lib/entry-input";
import {
	loggableSuggestionProjects,
	startTimeSuggestions,
} from "../lib/suggestion-runs";

export const generateTimeSuggestionsInputSchema = z
	.object({
		organizationId: z.string().min(1).max(INPUT_BOUNDS.name),
		/** First work date, inclusive. Omitted with `to`: the week ending today. */
		from: workDateSchema.optional(),
		/** Last work date, inclusive. */
		to: workDateSchema.optional(),
		/** The caller's IANA time zone: what "today" and each work date mean. */
		timezone: z
			.string()
			.max(100)
			.refine(isValidTimeZone, { message: "Use an IANA time zone" }),
		/**
		 * `on_demand`: the member asked; every project they can log on.
		 * `automatic`: the page refreshes on its own; time and materials
		 * projects only, the default range, and nothing when the newest run
		 * is less than 12 hours old.
		 */
		mode: z.enum(["on_demand", "automatic"]).default("on_demand"),
	})
	.refine(
		(input) => (input.from === undefined) === (input.to === undefined),
		{
			message: "Give both a first and a last work date, or neither",
			path: ["to"],
		},
	)
	.refine((input) => input.mode === "on_demand" || input.from === undefined, {
		message: "An automatic refresh reads the default range",
		path: ["from"],
	})
	.refine(
		(input) => {
			// Missing or unreadable dates are reported on their own.
			if (
				input.from === undefined ||
				input.to === undefined ||
				!isIsoDate(input.from) ||
				!isIsoDate(input.to)
			) {
				return true;
			}
			const span = inclusiveDaySpan(input.from, input.to);
			return span >= 1 && span <= MAX_TIME_SUGGESTION_SPAN_DAYS;
		},
		{
			message: `Choose a range of 1 to ${MAX_TIME_SUGGESTION_SPAN_DAYS} days, ending on or after its start`,
			path: ["to"],
		},
	);

export type GenerateTimeSuggestionsResult =
	| { started: true; runId: string }
	| {
			started: false;
			reason: "in-progress" | "unavailable" | "fresh" | "no-projects";
	  };

function toResult(
	result: RefreshTimeSuggestionsResult,
): GenerateTimeSuggestionsResult {
	return result.status === "started"
		? { started: true, runId: result.runId }
		: { started: false, reason: result.status };
}

/**
 * Start building the caller's time suggestions from their own activity over
 * a range of work dates, on the projects they can log time on now.
 *
 * Fire-and-forget: the page polls `suggestionStatus` until the run finishes,
 * then reads `listSuggestions`. One run at a time per member and organization;
 * a second start while one runs answers `in-progress`. Gated on organization
 * membership like `listLoggableProjects`; TIME_LOG is decided per project.
 */
export const generateTimeSuggestionsProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.PROJECT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/time-tracking/suggestions/generate",
		tags: ["Time tracking"],
		summary: "Generate the caller's time suggestions",
		description:
			"Starts building suggested time entries from the caller's own meetings, test runs, feature edits and test work over at most 14 days (default: the 7 days ending today in `timezone`). Returns started:false with in-progress while a run is already going, or unavailable when the background worker cannot be reached. With mode `automatic` it reads only time and materials projects over the default range, and returns fresh when the caller's newest run started less than 12 hours ago or no-projects when none of their projects is time and materials.",
	})
	.input(generateTimeSuggestionsInputSchema)
	.handler(
		async ({ input, context }): Promise<GenerateTimeSuggestionsResult> => {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);
			if (!organizationId) {
				throw new ORPCError("BAD_REQUEST", {
					message: "organizationId is required",
				});
			}
			const userId = context.user.id;

			switch (input.mode) {
				case "automatic":
					return toResult(
						await refreshTimeSuggestions({
							organizationId,
							userId,
							timezone: input.timezone,
							now: new Date(),
						}),
					);
				case "on_demand": {
					const toDate =
						input.to ?? localDateOf(new Date(), input.timezone);
					const fromDate =
						input.from ??
						addDays(toDate, 1 - DEFAULT_TIME_SUGGESTION_SPAN_DAYS);
					return toResult(
						await startTimeSuggestions({
							organizationId,
							userId,
							fromDate,
							toDate,
							timezone: input.timezone,
							projects: await loggableSuggestionProjects({
								organizationId,
								userId,
							}),
							automatic: false,
						}),
					);
				}
				default: {
					const unhandled: never = input.mode;
					throw new Error(`Unhandled mode: ${String(unhandled)}`);
				}
			}
		},
	);
