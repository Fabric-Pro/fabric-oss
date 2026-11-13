import {
	findTimeTimerForOwner,
	getTimeTrackingPreference,
} from "@repo/database";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	describeTimer,
	requireTimerOrganization,
	timerOrganizationInput,
} from "../lib/timer";

export const getTimerInputSchema = timerOrganizationInput;

/**
 * The caller's running or paused timer in the organization, or null, with
 * their time-tracking preferences.
 *
 * Returned whatever the state of the timer's project, so a timer on a project
 * the caller can no longer time still shows and can be discarded. Every other
 * timer procedure except `discard` checks the project.
 */
export const getTimerProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.PROJECT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/time-tracking/timer",
		tags: ["Time tracking"],
		summary: "Get the caller's timer",
		description:
			"The caller's running or paused timer in the organization (null when none), with its segments, the seconds it has run, its project's current start/stop rule and billable default, and the caller's timer preferences.",
	})
	.input(getTimerInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = requireTimerOrganization(
			resolveOrganizationId(input.organizationId, context.session),
		);
		const owner = { organizationId, userId: context.user.id };
		const [timer, preference] = await Promise.all([
			findTimeTimerForOwner(owner),
			getTimeTrackingPreference(owner),
		]);
		return {
			timer: timer ? await describeTimer(timer, new Date()) : null,
			preference,
		};
	});
