import {
	pauseTimeTimer,
	resumeTimeTimer,
	type TimeTimerRow,
} from "@repo/database";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	assertCanTimeProject,
	describeTimer,
	requireOwnTimer,
	requireTimerOrganization,
	timerChangeInput,
	timerConflict,
} from "../lib/timer";

export const pauseTimerInputSchema = timerChangeInput;
export const resumeTimerInputSchema = timerChangeInput;

/**
 * Move the caller's timer to `target`. A timer already there answers as it
 * is, whatever version the caller saw, so a repeated pause or resume is
 * harmless; otherwise a stale version answers CONFLICT with the current
 * timer.
 */
async function moveTimer(params: {
	organizationId: string;
	userId: string;
	timerId: string;
	version: number;
	target: TimeTimerRow["status"];
}) {
	const { organizationId, userId, timerId, version, target } = params;
	const timer = await requireOwnTimer({ organizationId, userId, timerId });
	await assertCanTimeProject(timer.projectId, userId);
	if (timer.status === target) {
		return { timer: await describeTimer(timer, new Date()) };
	}
	if (timer.version !== version) {
		throw await timerConflict(timer);
	}

	const now = new Date();
	const key = { timerId, organizationId, userId, version, at: now };
	const moved =
		target === "PAUSED"
			? await pauseTimeTimer(key)
			: await resumeTimeTimer(key);
	if (moved) {
		return { timer: await describeTimer(moved, now) };
	}

	// Changed between the read and the write: answer as above.
	const current = await requireOwnTimer({ organizationId, userId, timerId });
	if (current.status === target) {
		return { timer: await describeTimer(current, now) };
	}
	throw await timerConflict(current);
}

/** Pause the caller's running timer, closing its current segment. */
export const pauseTimerProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.PROJECT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/time-tracking/timer/pause",
		tags: ["Time tracking"],
		summary: "Pause the caller's timer",
		description:
			"Pauses the caller's running timer. Pausing a paused timer answers its current state; a stale version answers CONFLICT with the current timer.",
	})
	.input(pauseTimerInputSchema)
	.handler(async ({ input, context }) =>
		moveTimer({
			organizationId: requireTimerOrganization(
				resolveOrganizationId(input.organizationId, context.session),
			),
			userId: context.user.id,
			timerId: input.timerId,
			version: input.version,
			target: "PAUSED",
		}),
	);

/** Resume the caller's paused timer, opening a new segment. */
export const resumeTimerProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.PROJECT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/time-tracking/timer/resume",
		tags: ["Time tracking"],
		summary: "Resume the caller's timer",
		description:
			"Resumes the caller's paused timer. Resuming a running timer answers its current state; a stale version answers CONFLICT with the current timer.",
	})
	.input(resumeTimerInputSchema)
	.handler(async ({ input, context }) =>
		moveTimer({
			organizationId: requireTimerOrganization(
				resolveOrganizationId(input.organizationId, context.session),
			),
			userId: context.user.id,
			timerId: input.timerId,
			version: input.version,
			target: "RUNNING",
		}),
	);
