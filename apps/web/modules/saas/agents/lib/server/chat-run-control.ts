import {
	type AuditRequestContext,
	recordAuditFromRequest,
} from "@repo/api/lib/audit";
import { canControlChatRun } from "@repo/api/lib/chat-control-permission";
import { checkRateLimit } from "@repo/api/lib/rate-limit";
import { getConversationTurnOwnerForExecution } from "@repo/database";
import {
	type ApprovalReceipt,
	getTemporalClient,
	type PendingApprovalInfo,
} from "@repo/temporal";
import { getSession } from "@saas/auth/lib/server";
import { z } from "zod";

const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const commandSchema = z.object({
	executionId: z.string(),
	approvalId: z.string().min(1).max(300).optional(),
	approved: z.boolean().optional(),
	feedback: z.string().max(10_000).optional(),
	reason: z.string().max(500).optional(),
});

/** All chat controls authorize the described run before pinning its handle. */
export async function controlChatRun(
	request: Request,
	engine: "direct" | "orchestrator",
	action: "approve" | "cancel",
) {
	try {
		const session = await getSession();
		if (!session) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}
		const userId = session.user.id;
		const prefix = engine === "direct" ? "direct-chat" : "orchestrator";
		const limit = await checkRateLimit(
			`${prefix}:${action}:${userId}`,
			10,
			60_000,
		);
		if (!limit.allowed) {
			return Response.json(
				{
					error: "Rate limit exceeded",
					retryAfter: limit.resetInSeconds,
				},
				{
					status: 429,
					headers: { "Retry-After": String(limit.resetInSeconds) },
				},
			);
		}
		const parsed = commandSchema.safeParse(
			await request.json().catch(() => null),
		);
		if (!parsed.success) {
			return Response.json(
				{ error: "Invalid control request" },
				{ status: 400 },
			);
		}
		const command = parsed.data;
		if (
			!new RegExp(
				`^${engine === "direct" ? "direct-chat" : "orch"}-${uuid}$`,
			).test(command.executionId)
		) {
			return Response.json(
				{ error: "Invalid executionId format" },
				{ status: 400 },
			);
		}
		if (action === "approve" && command.approved === undefined) {
			return Response.json(
				{ error: "approvalId and approved are required" },
				{ status: 400 },
			);
		}
		const { handle, description, organizationId } =
			await getAuthorizedChatRun({
				executionId: command.executionId,
				userId,
				engine,
				action,
			});

		if (description.status.name !== "RUNNING") {
			return action === "cancel"
				? Response.json({
						success: true,
						executionId: command.executionId,
						alreadyTerminated: true,
					})
				: Response.json(
						{ error: "The run is no longer waiting for approval" },
						{ status: 409 },
					);
		}
		if (action === "approve") {
			const refusal = approvalRefusalResponse(
				await decideChatRunApproval({
					run: { handle, description, organizationId },
					userId,
					approvalId: command.approvalId,
					approved: command.approved === true,
					feedback: command.feedback,
				}),
			);
			if (refusal) {
				return refusal;
			}
		} else {
			await handle.cancel();
		}
		recordChatRunControlAudit(
			{
				headers: request.headers,
				user: session.user,
				session: session.session,
			},
			{
				action,
				organizationId,
				executionId: command.executionId,
				runId: description.runId,
				approvalId: command.approvalId,
				approved: command.approved,
			},
		);
		return Response.json({
			success: true,
			executionId: command.executionId,
			approved: command.approved,
			...(action === "cancel" ? { cancellationRequested: true } : {}),
		});
	} catch (error) {
		if (error instanceof ChatRunAccessError) {
			return Response.json(
				{ error: error.message },
				{ status: error.status },
			);
		}
		// A transport failure is ambiguous. Never report cancellation or approval
		// as completed, and never echo provider errors or retry the mutation.
		return Response.json(
			{
				error: "The decision could not be confirmed. Reconnect to check the run before trying again.",
			},
			{ status: 503 },
		);
	}
}

/** How an approval decision ended. Only `decided` reached the workflow. */
export type ChatRunApprovalOutcome =
	| { kind: "decided" }
	| { kind: "approval_id_required" }
	| { kind: "not_pending" }
	| { kind: "older_protocol" }
	| { kind: "unavailable" }
	| {
			kind: "rejected";
			reason: Extract<ApprovalReceipt, { accepted: false }>["reason"];
	  };

/**
 * Decide the pending approval of a running, authorized run: the v1 signal,
 * or the v2 `decideApproval` update with the request and run ids the server
 * reads from the run itself (never the client's). Shared by the approve
 * route and the agent runtime's Orchestrator engine.
 */
export async function decideChatRunApproval({
	run: { handle, description, organizationId },
	userId,
	approvalId,
	approved,
	feedback,
}: {
	run: Awaited<ReturnType<typeof getAuthorizedChatRun>>;
	userId: string;
	approvalId: string | undefined;
	approved: boolean;
	feedback: string | undefined;
}): Promise<ChatRunApprovalOutcome> {
	if (description.memo?.approvalProtocol === 2 && !approvalId) {
		return { kind: "approval_id_required" };
	}
	const pending = await handle.query<PendingApprovalInfo | null>(
		"pendingApproval",
	);
	if (description.memo?.approvalProtocol !== 2) {
		if (
			!pending ||
			(approvalId !== undefined && approvalId !== pending.approvalId)
		) {
			return { kind: "not_pending" };
		}
		await handle.signal("approval", {
			approved,
			feedback,
			decidedBy: userId,
			approvalId: pending.approvalId,
		});
		return { kind: "decided" };
	}
	if (
		!pending?.requestId ||
		pending.approvalId !== approvalId ||
		pending.runId !== description.runId
	) {
		return {
			kind:
				pending && !pending.requestId
					? "older_protocol"
					: "unavailable",
		};
	}
	const receipt = await handle.executeUpdate<ApprovalReceipt, [unknown]>(
		"decideApproval",
		{
			args: [
				{
					approvalId,
					requestId: pending.requestId,
					runId: description.runId,
					organizationId,
					decidedBy: userId,
					approved,
					feedback,
				},
			],
		},
	);
	return receipt.accepted
		? { kind: "decided" }
		: { kind: "rejected", reason: receipt.reason };
}

/** The approve route's answer to an approval that did not reach the workflow. */
function approvalRefusalResponse(
	outcome: ChatRunApprovalOutcome,
): Response | null {
	switch (outcome.kind) {
		case "decided":
			return null;
		case "approval_id_required":
			return Response.json(
				{ error: "approvalId is required" },
				{ status: 400 },
			);
		case "not_pending":
			return Response.json(
				{
					error: "This approval is no longer pending.",
					code: "APPROVAL_NOT_PENDING",
				},
				{ status: 409 },
			);
		case "older_protocol":
			return Response.json(
				{
					error: "This run uses an older approval protocol. Start a new run to review actions safely.",
				},
				{ status: 409 },
			);
		case "unavailable":
			return Response.json(
				{
					error: "This approval is no longer available. Refresh the conversation.",
				},
				{ status: 409 },
			);
		case "rejected":
			return Response.json(
				{ error: `Approval ${outcome.reason}` },
				{ status: outcome.reason === "forbidden" ? 403 : 409 },
			);
		default: {
			const unhandled: never = outcome;
			throw new Error(
				`Unhandled approval outcome: ${JSON.stringify(unhandled)}`,
			);
		}
	}
}

/**
 * The audit row for a chat-run control, written after Temporal accepted it:
 * the decision on an approval, or the request to cancel the run. Shared by
 * the control routes and the agent runtime's stop.
 */
export function recordChatRunControlAudit(
	context: AuditRequestContext,
	control: {
		action: "approve" | "cancel";
		organizationId: string;
		executionId: string;
		runId: string | undefined;
		approvalId?: string;
		approved?: boolean;
	},
): void {
	recordAuditFromRequest(context, {
		action:
			control.action === "approve"
				? "org.chat_approval.decided"
				: "org.chat_run.cancel_requested",
		organizationId: control.organizationId,
		resource: { type: "chat_run", id: control.executionId },
		metadata: {
			runId: control.runId,
			approvalId:
				control.action === "approve" ? control.approvalId : undefined,
			approved: control.approved,
		},
	});
}

export class ChatRunAccessError extends Error {
	readonly status = 403;
	constructor() {
		super("Forbidden");
	}
}

/** Authorize before observing a run or sending it any command. */
export async function getAuthorizedChatRun(input: {
	executionId: string;
	userId: string;
	engine: "direct" | "orchestrator";
	action: "observe" | "reattach" | "approve" | "cancel";
	expectedOrganizationId?: string;
}) {
	const { executionId, userId, engine, action } = input;
	const temporal = await getTemporalClient();
	const description = await temporal.workflow
		.getHandle(executionId)
		.describe();
	const memo = description.memo;
	const organizationId = memo?.organizationId;
	const expectedType =
		engine === "direct"
			? "directChatWorkflow"
			: "orchestratorExecutionWorkflow";
	if (
		memo?.userId !== userId ||
		typeof organizationId !== "string" ||
		!organizationId ||
		(description.type !== undefined && description.type !== expectedType) ||
		(description.runId !== undefined && !description.runId) ||
		(input.expectedOrganizationId !== undefined &&
			organizationId !== input.expectedOrganizationId)
	) {
		throw new ChatRunAccessError();
	}
	const turnOwner = await getConversationTurnOwnerForExecution(executionId);
	if (
		turnOwner &&
		(turnOwner.userId !== userId ||
			turnOwner.organizationId !== organizationId)
	) {
		throw new ChatRunAccessError();
	}
	const handle = description.runId
		? temporal.workflow.getHandle(executionId, description.runId)
		: temporal.workflow.getHandle(executionId);
	let projectId = memo?.projectId;
	if (projectId === undefined && memo?.approvalProtocol === 2) {
		const context = z
			.object({
				userId: z.string(),
				organizationId: z.string(),
				projectId: z.string().min(1).nullable(),
			})
			.safeParse(await handle.query("chatRunContext"));
		if (
			!context.success ||
			context.data.userId !== userId ||
			context.data.organizationId !== organizationId
		) {
			throw new ChatRunAccessError();
		}
		projectId = context.data.projectId;
	}
	// Legacy runs retain staging's memo/turn ownership and tenant checks.
	if (projectId === undefined) {
		projectId = null;
	}

	if (projectId !== null && (typeof projectId !== "string" || !projectId)) {
		throw new ChatRunAccessError();
	}
	if (
		!(await canControlChatRun({
			userId,
			organizationId,
			projectId: typeof projectId === "string" ? projectId : undefined,
			action,
		}))
	) {
		throw new ChatRunAccessError();
	}
	return { handle, description, organizationId };
}
