import { recordAuditFromRequest } from "@repo/api/lib/audit";
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
			if (
				description.memo?.approvalProtocol === 2 &&
				!command.approvalId
			) {
				return Response.json(
					{ error: "approvalId is required" },
					{ status: 400 },
				);
			}
			const pending = await handle.query<PendingApprovalInfo | null>(
				"pendingApproval",
			);
			if (description.memo?.approvalProtocol !== 2) {
				if (
					!pending ||
					(command.approvalId !== undefined &&
						command.approvalId !== pending.approvalId)
				) {
					return Response.json(
						{
							error: "This approval is no longer pending.",
							code: "APPROVAL_NOT_PENDING",
						},
						{ status: 409 },
					);
				}
				await handle.signal("approval", {
					approved: command.approved,
					feedback: command.feedback,
					decidedBy: userId,
					approvalId: pending.approvalId,
				});
			} else {
				if (
					!pending?.requestId ||
					pending.approvalId !== command.approvalId ||
					pending.runId !== description.runId
				) {
					return Response.json(
						{
							error:
								pending && !pending.requestId
									? "This run uses an older approval protocol. Start a new run to review actions safely."
									: "This approval is no longer available. Refresh the conversation.",
						},
						{ status: 409 },
					);
				}
				const receipt = await handle.executeUpdate<
					ApprovalReceipt,
					[unknown]
				>("decideApproval", {
					args: [
						{
							approvalId: command.approvalId,
							requestId: pending.requestId,
							runId: description.runId,
							organizationId,
							decidedBy: userId,
							approved: command.approved,
							feedback: command.feedback,
						},
					],
				});

				if (!receipt.accepted) {
					return Response.json(
						{ error: `Approval ${receipt.reason}` },
						{ status: receipt.reason === "forbidden" ? 403 : 409 },
					);
				}
			}
		} else {
			await handle.cancel();
		}
		await recordAuditFromRequest(
			{
				headers: request.headers,
				user: session.user,
				session: session.session,
			},
			{
				action:
					action === "approve"
						? "org.chat_approval.decided"
						: "org.chat_run.cancel_requested",
				organizationId,
				resource: { type: "chat_run", id: command.executionId },
				metadata: {
					runId: description.runId,
					approvalId:
						action === "approve" ? command.approvalId : undefined,
					approved: command.approved,
				},
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
