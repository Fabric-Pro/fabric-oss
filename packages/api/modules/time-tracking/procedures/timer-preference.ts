import { setTimeTrackingPreference } from "@repo/database";
import { TIME_TIMER_WIDGET_VALUES } from "@repo/utils/time-tracking";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { requireTimerOrganization, timerOrganizationInput } from "../lib/timer";

export const setTimerPreferenceInputSchema = timerOrganizationInput.extend({
	/**
	 * `SHOWN`; `HIDDEN_UNTIL_START`, closed until the next start shows it
	 * again; or `OFF`, never shown.
	 */
	timerWidget: z.enum(TIME_TIMER_WIDGET_VALUES).optional(),
	/** Whether the browser reminds the caller of a running timer. */
	timerReminders: z.boolean().optional(),
});

/** Change the caller's own timer preferences; fields left out are kept. */
export const setTimerPreferenceProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.PROJECT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/time-tracking/timer/preference",
		tags: ["Time tracking"],
		summary: "Change the caller's timer preferences",
		description:
			"Sets whether the caller's floating timer shows and whether the browser reminds them of a running timer, in this organization.",
	})
	.input(setTimerPreferenceInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = requireTimerOrganization(
			resolveOrganizationId(input.organizationId, context.session),
		);
		const preference = await setTimeTrackingPreference({
			organizationId,
			userId: context.user.id,
			values: {
				timerWidget: input.timerWidget,
				timerReminders: input.timerReminders,
			},
		});
		return { preference };
	});
