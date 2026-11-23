import { ORPCError } from "@orpc/server";
import { canEditProject, db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal/client";
import { z } from "zod";
import { mintParlumeActingGrantForConfirmedAction } from "../../../../lib/agent-service-auth";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	effectiveParlumeActionStatus,
	parlumeActionClosedMessage,
} from "../../lib/parlume-actions";
import { mayReadParlumeSessionContent } from "../../lib/parlume-confidential";
import { parlumeLog } from "../../lib/parlume-log";
import { requireParlumeProject } from "./sessions";

const actionInput = z.object({
	projectId: z.string(),
	actionId: z.string().min(1).max(128),
});

const actionSelect = {
	id: true,
	sessionId: true,
	toolName: true,
	summary: true,
	arguments: true,
	speakerName: true,
	status: true,
	expiresAt: true,
	confirmedAt: true,
	completedAt: true,
	decidedByUserId: true,
	chatTag: true,
	outcome: true,
	createdAt: true,
	turn: {
		select: {
			requestText: true,
			session: {
				select: {
					agentLabel: true,
					status: true,
					createdAt: true,
					joinedAt: true,
				},
			},
		},
	},
} as const;

/**
 * A proposal the member may see: one from a confidential meeting only for its
 * verified attendees and the project's managers, as the rest of the meeting.
 */
async function findAction(
	project: { id: string; organizationId: string },
	actionId: string,
	userId: string,
) {
	const action = await db.parlumeAction.findFirst({
		where: {
			id: actionId,
			projectId: project.id,
			organizationId: project.organizationId,
		},
		select: actionSelect,
	});
	const session = action
		? await db.parlumeMeetingSession.findUnique({
				where: { id: action.sessionId },
				select: { confidential: true, attendeeUserIds: true },
			})
		: null;
	if (
		!action ||
		!session ||
		!(await mayReadParlumeSessionContent({
			projectId: project.id,
			userId,
			session,
		}))
	) {
		throw new ORPCError("NOT_FOUND", {
			message: "Parlume proposal not found",
		});
	}
	return action;
}

/** A proposal as the action page shows it, with who decided it by name. */
async function actionView(action: Awaited<ReturnType<typeof findAction>>) {
	const decidedBy = action.decidedByUserId
		? await db.user.findUnique({
				where: { id: action.decidedByUserId },
				select: { name: true },
			})
		: null;
	const { decidedByUserId: _, turn, ...rest } = action;
	return {
		...rest,
		status: effectiveParlumeActionStatus(action),
		requestText: turn.requestText,
		session: turn.session,
		decidedByName: decidedBy?.name ?? null,
	};
}

/** Temporal's "already started" error, matched by name. */
function isWorkflowAlreadyStartedError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.name === "WorkflowExecutionAlreadyStartedError"
	);
}

/**
 * Settles the state a claim found instead of PROPOSED: a proposal past its
 * expiry is recorded as EXPIRED, and the caller is told why it cannot act.
 */
async function refuseClosed(actionId: string, now: Date): Promise<never> {
	await db.parlumeAction.updateMany({
		where: { id: actionId, status: "PROPOSED", expiresAt: { lte: now } },
		data: { status: "EXPIRED", completedAt: now },
	});
	const current = await db.parlumeAction.findUniqueOrThrow({
		where: { id: actionId },
		select: { status: true, expiresAt: true },
	});
	throw new ORPCError("CONFLICT", {
		message: parlumeActionClosedMessage(
			effectiveParlumeActionStatus(current, now),
		),
	});
}

export const getParlumeActionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/parlume/actions/{actionId}",
		tags: ["Projects", "Parlume"],
		summary: "Show a change Parlume proposed in a meeting",
	})
	.input(actionInput)
	.handler(async ({ input, context }) => {
		const project = await requireParlumeProject(input.projectId);
		const action = await findAction(
			project,
			input.actionId,
			context.user.id,
		);
		return {
			action: await actionView(action),
			canConfirm: await canEditProject(project.id, context.user.id),
		};
	});

/**
 * Confirms a proposed change and starts it, as the confirming member, with a
 * grant minted for that member. The claim moves the proposal to EXECUTING
 * once, so two confirmations run one change, and the run claims it once
 * more before it acts, so a start that failed ambiguously never runs it
 * twice. Only the action page calls this: no chat or spoken command confirms.
 */
export const confirmParlumeActionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/parlume/actions/{actionId}/confirm",
		tags: ["Projects", "Parlume"],
		summary: "Confirm a change Parlume proposed in a meeting",
	})
	.input(actionInput)
	.handler(async ({ input, context }) => {
		const project = await requireParlumeProject(input.projectId);
		const action = await findAction(
			project,
			input.actionId,
			context.user.id,
		);
		const now = new Date();
		const claimed = await db.parlumeAction.updateMany({
			where: {
				id: action.id,
				status: "PROPOSED",
				expiresAt: { gt: now },
			},
			data: {
				status: "EXECUTING",
				confirmedAt: now,
				decidedByUserId: context.user.id,
			},
		});
		if (claimed.count === 0) {
			await refuseClosed(action.id, now);
		}
		try {
			const temporal = await getTemporalClient();
			await temporal.workflow.start("parlumeConfirmedActionWorkflow", {
				taskQueue: "fabric-worker",
				workflowId: `parlume-action-${action.id}`,
				// The grant travels only in the workflow input; it is never
				// stored on the action.
				args: [
					{
						actionId: action.id,
						actingGrant: mintParlumeActingGrantForConfirmedAction({
							userId: context.user.id,
							organizationId: project.organizationId,
							projectId: project.id,
						}),
					},
				],
			});
		} catch (error) {
			// The workflow id is the action's, so an earlier start of it is
			// this change on its way. Any other error may still have started
			// it (a lost reply), so the proposal reopens only while no run has
			// claimed it; a run that did not claim it then does nothing.
			const reopened = isWorkflowAlreadyStartedError(error)
				? { count: 0 }
				: await db.parlumeAction.updateMany({
						where: {
							id: action.id,
							status: "EXECUTING",
							startedAt: null,
						},
						data: {
							status: "PROPOSED",
							confirmedAt: null,
							decidedByUserId: null,
						},
					});
			if (reopened.count > 0) {
				parlumeLog("warn", "action.confirm_dispatch_failed", {
					sessionId: action.sessionId,
					actionId: action.id,
				});
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "Fabric could not start the change. Try again.",
				});
			}
		}
		recordAuditFromRequest(context, {
			action: "project.parlume.action_confirmed",
			category: "project",
			organizationId: project.organizationId,
			projectId: project.id,
			resource: { type: "parlume_action", id: action.id },
			metadata: {
				sessionId: action.sessionId,
				toolName: action.toolName,
			},
		});
		return {
			action: await actionView(
				await findAction(project, action.id, context.user.id),
			),
		};
	});

/** Dismisses a proposed change: it is never made. */
export const dismissParlumeActionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/parlume/actions/{actionId}/dismiss",
		tags: ["Projects", "Parlume"],
		summary: "Dismiss a change Parlume proposed in a meeting",
	})
	.input(actionInput)
	.handler(async ({ input, context }) => {
		const project = await requireParlumeProject(input.projectId);
		const action = await findAction(
			project,
			input.actionId,
			context.user.id,
		);
		const now = new Date();
		const dismissed = await db.parlumeAction.updateMany({
			where: {
				id: action.id,
				status: "PROPOSED",
				expiresAt: { gt: now },
			},
			data: {
				status: "CANCELLED",
				completedAt: now,
				decidedByUserId: context.user.id,
				outcome: "Dismissed in Fabric. No change was made.",
			},
		});
		if (dismissed.count === 0) {
			await refuseClosed(action.id, now);
		}
		recordAuditFromRequest(context, {
			action: "project.parlume.action_dismissed",
			category: "project",
			organizationId: project.organizationId,
			projectId: project.id,
			resource: { type: "parlume_action", id: action.id },
			metadata: {
				sessionId: action.sessionId,
				toolName: action.toolName,
			},
		});
		return {
			action: await actionView(
				await findAction(project, action.id, context.user.id),
			),
		};
	});
