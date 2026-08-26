import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess, isFeatureEnabled } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { utcDayRange } from "./occurrence-day";

/**
 * Pre-meeting agenda procedures (#1901).
 *
 * Identity is (linkedMeetingId, occurrenceStart), never a Graph event id —
 * Graph returns a different event id to every attendee for the same occurrence.
 */

// Reschedule resilience — the unique constraint is on the exact timestamp, but
// both reads and generation resolve on the UTC DAY. The rule now lives in
// occurrence-day.ts because list-upcoming-meetings.ts must resolve an agenda to
// a calendar occurrence exactly the way this file does (#2106). Re-exported
// because callers and tests already import it from here.
export { utcDayRange };

/** Agendas may be generated for a meeting that has just started, but not for history. */
const PAST_GRACE_MS = 60 * 60 * 1000;

const agendaSelect = {
	id: true,
	status: true,
	content: true,
	contextStats: true,
	// Which prompt produced the agenda — read by "How this agenda was built".
	// Widening this select rather than adding a procedure is deliberate: a new
	// @repo/api procedure is not on the input-org-unverified ratchet baseline
	// and would fail CI.
	promptProvenance: true,
	occurrenceStart: true,
	generatedAt: true,
	generationError: true,
	editedAt: true,
	editedById: true,
	version: true,
} as const;

async function assertProjectAccess(
	projectId: string,
	userId: string,
	organizationId: string | undefined,
) {
	if (!(await isFeatureEnabled("MEETING_AGENDA"))) {
		throw new ORPCError("NOT_FOUND", {
			message: "Meeting agendas are not enabled.",
		});
	}
	if (!(await hasProjectAccess(projectId, userId, organizationId))) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have access to this project",
		});
	}
}

const occurrenceInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	linkedMeetingId: z.string(),
	occurrenceStart: z.coerce.date(),
});

/**
 * Read the shared agenda for one occurrence. PROJECT_READ: every project member
 * may read the agenda, only admins may create or edit it (D4).
 */
export const getAgendaProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.PROJECT_READ))
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/meeting-digest/agenda",
		tags: ["Projects", "Meeting Digest"],
		summary: "Get the agenda for one upcoming meeting occurrence",
	})
	.input(occurrenceInput)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await assertProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);

		const agenda = await db.projectMeetingAgenda.findFirst({
			where: {
				projectId: input.projectId,
				linkedMeetingId: input.linkedMeetingId,
				occurrenceStart: utcDayRange(input.occurrenceStart),
			},
			orderBy: { createdAt: "desc" },
			select: agendaSelect,
		});

		return { agenda };
	});

/**
 * Start generation for one occurrence. PROJECT_UPDATE (D4): generating writes
 * the SHARED agenda, so it carries the same permission as editing it.
 */
export const generateAgendaProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.PROJECT_UPDATE))
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-digest/agenda/generate",
		tags: ["Projects", "Meeting Digest"],
		summary: "Generate an agenda for one upcoming meeting occurrence",
	})
	.input(occurrenceInput.extend({ force: z.boolean().optional() }))
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await assertProjectAccess(input.projectId, user.id, organizationId);

		if (input.occurrenceStart.getTime() < Date.now() - PAST_GRACE_MS) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Agendas can only be generated for upcoming meetings.",
			});
		}

		const linkedMeeting = await db.projectLinkedMeeting.findFirst({
			where: { id: input.linkedMeetingId, projectId: input.projectId },
			select: { id: true },
		});
		if (!linkedMeeting) {
			throw new ORPCError("NOT_FOUND", {
				message:
					"Link this meeting to the project before generating an agenda.",
			});
		}

		const dayRange = utcDayRange(input.occurrenceStart);
		const existing = await db.projectMeetingAgenda.findFirst({
			where: {
				projectId: input.projectId,
				linkedMeetingId: input.linkedMeetingId,
				occurrenceStart: dayRange,
			},
			orderBy: { createdAt: "desc" },
			select: { id: true, editedAt: true },
		});

		// D7 — regenerating over hand-edited content destroys it. Make the caller
		// say so explicitly rather than discarding work silently.
		if (existing?.editedAt && !input.force) {
			return { started: false, reason: "would-discard-edits" as const };
		}

		const reuseExisting = (id: string) =>
			db.projectMeetingAgenda.update({
				where: { id },
				data: {
					status: "GENERATING",
					generationError: null,
					occurrenceStart: input.occurrenceStart,
				},
				select: { id: true },
			});

		// Reuse the same-day row rather than inserting a second one, so a
		// rescheduled meeting keeps one agenda.
		let agenda: { id: string };
		if (existing) {
			agenda = await reuseExisting(existing.id);
		} else {
			try {
				agenda = await db.projectMeetingAgenda.create({
					data: {
						projectId: input.projectId,
						linkedMeetingId: input.linkedMeetingId,
						occurrenceStart: input.occurrenceStart,
						status: "GENERATING",
						createdById: user.id,
						userId: user.id,
						organizationId,
					},
					select: { id: true },
				});
			} catch (err) {
				// Two interleaved requests can both see no same-day row and both
				// try to create one — the unique constraint on
				// (linkedMeetingId, occurrenceStart) rejects the loser with P2002.
				// Recover by re-reading the winner's row and reusing it exactly
				// like the same-day-reuse path above, rather than surfacing a raw
				// 500 for a routine double-click (#1901 final review, FIX 5).
				const isUniqueViolation =
					typeof err === "object" &&
					err !== null &&
					(err as { code?: string }).code === "P2002";
				if (!isUniqueViolation) {
					throw err;
				}
				const winner = await db.projectMeetingAgenda.findFirst({
					where: {
						projectId: input.projectId,
						linkedMeetingId: input.linkedMeetingId,
						occurrenceStart: dayRange,
					},
					orderBy: { createdAt: "desc" },
					select: { id: true },
				});
				if (!winner) {
					throw err;
				}
				agenda = await reuseExisting(winner.id);
			}
		}

		// Dynamic import keeps @repo/temporal's client out of the API static graph.
		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();
		const workflowId = `meeting-agenda:${agenda.id}`;

		try {
			await client.workflow.start("generateMeetingAgendaWorkflow", {
				taskQueue: "project-documents",
				workflowId,
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
				// Ordinary concurrent clicks collapse onto the same in-progress
				// run (FAIL — caught below as "in-progress"). A forced regenerate
				// must instead be able to displace a run that is stuck rather
				// than merely in-progress — e.g. the worker never picked up the
				// workflow type at all, so it retries forever with nothing to
				// collapse onto. workflowExecutionTimeout below also bounds a
				// run that never had a worker to execute it in the first place
				// (#1901 final review, FIX 1).
				workflowIdConflictPolicy: input.force
					? "TERMINATE_EXISTING"
					: "FAIL",
				workflowExecutionTimeout: "10m",
				args: [
					{
						agendaId: agenda.id,
						projectId: input.projectId,
						organizationId: organizationId ?? null,
						userId: user.id,
						linkedMeetingId: input.linkedMeetingId,
					},
				],
			});
		} catch (err) {
			if (
				err instanceof Error &&
				err.name === "WorkflowExecutionAlreadyStartedError"
			) {
				// A run for this agenda is already going — the UI is polling for
				// exactly the row it will fill.
				return { started: false, reason: "in-progress" as const };
			}

			// Roll the row back so the UI shows an error instead of polling a
			// GENERATING row no workflow will ever complete.
			await db.projectMeetingAgenda.update({
				where: { id: agenda.id },
				data: {
					status: "FAILED",
					generationError:
						err instanceof Error
							? err.message
							: "Could not start generation",
				},
			});
			throw err;
		}

		await db.projectMeetingAgenda.update({
			where: { id: agenda.id },
			data: { temporalWorkflowId: workflowId },
		});

		return { started: true, reason: "started" as const };
	});

/**
 * Save hand-edited agenda content (FR3 / AC3).
 *
 * A version conflict returns `{ saved: false, reason: "conflict" }` and does NOT
 * throw. That is a data-exposure control, not just UX: auditErrorMiddleware
 * snapshots procedure INPUT into an org-admin-readable AuditLog row on any
 * throw, and its redaction is key-name-substring matching only — `content` is
 * not on the denylist. Throwing on a routine concurrent edit would publish the
 * user's full agenda text to the audit log every time two admins edit at once.
 *
 * Belt and braces: this path is also on ALWAYS_SKIP_PATHS in
 * audit-error-middleware.ts.
 */
export const saveAgendaProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.PROJECT_UPDATE))
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/meeting-digest/agenda",
		tags: ["Projects", "Meeting Digest"],
		summary: "Save edits to a generated agenda",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			agendaId: z.string(),
			content: z.string().max(100_000),
			expectedVersion: z.number().int().positive(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await assertProjectAccess(input.projectId, user.id, organizationId);

		const existing = await db.projectMeetingAgenda.findFirst({
			where: { id: input.agendaId, projectId: input.projectId },
			select: agendaSelect,
		});
		if (!existing) {
			throw new ORPCError("NOT_FOUND", { message: "Agenda not found" });
		}

		if (existing.version !== input.expectedVersion) {
			return {
				saved: false as const,
				reason: "conflict" as const,
				current: existing,
			};
		}

		// Guard the write on the version too: the check above races with another
		// admin's save, and updateMany's count tells us whether we lost.
		const result = await db.projectMeetingAgenda.updateMany({
			where: {
				id: input.agendaId,
				projectId: input.projectId,
				version: input.expectedVersion,
			},
			data: {
				content: input.content,
				editedAt: new Date(),
				editedById: user.id,
				version: { increment: 1 },
			},
		});

		if (result.count === 0) {
			const current = await db.projectMeetingAgenda.findFirst({
				where: { id: input.agendaId, projectId: input.projectId },
				select: agendaSelect,
			});
			return {
				saved: false as const,
				reason: "conflict" as const,
				current,
			};
		}

		return { saved: true as const, version: input.expectedVersion + 1 };
	});
