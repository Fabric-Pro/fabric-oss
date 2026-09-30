import {
	canEditProject,
	db,
	hasProjectAccess,
	recordAuditTx,
} from "@repo/database";
import { redactLogText } from "@repo/utils/log-redaction";
import { classifyReadOnlyToolAccess } from "@repo/utils/read-only-mode";
import {
	describeParlumeAction,
	PARLUME_APPROVAL_TTL_MS,
	parlumeActionArguments,
	parlumeActionOutcome,
	parlumeFingerprint,
	parlumeToolFingerprint,
	parseParlumeDecision,
} from "./parlume-action-policy";
import { verifyParlumeVoiceGeneration } from "./parlume-voice";
import {
	type AgentToolInvocation,
	type AgentToolRuntime,
	isExecutableAgentTool,
	withAgentToolRuntime,
	withApprovedAgentTool,
} from "./shared/agent-tool-runtime";

export interface ParlumeActionContext {
	turnId: string;
	sessionId: string;
	projectId: string;
	organizationId: string;
	userId: string;
	speakerId: string | null;
	speakerName: string | null;
	agentRevision: string;
	voiceGeneration: number;
	toolsReadOnly: boolean;
	signal?: AbortSignal;
}

async function sessionIsCurrent(
	context: ParlumeActionContext,
): Promise<boolean> {
	if (context.signal?.aborted) {
		return false;
	}
	const [session, access] = await Promise.all([
		db.parlumeMeetingSession.findFirst({
			where: {
				id: context.sessionId,
				projectId: context.projectId,
				organizationId: context.organizationId,
				userId: context.userId,
				status: "ACTIVE",
				voiceGeneration: context.voiceGeneration,
			},
			select: { toolsReadOnly: true },
		}),
		context.toolsReadOnly
			? hasProjectAccess(
					context.projectId,
					context.userId,
					context.organizationId,
				)
			: canEditProject(context.projectId, context.userId),
	]);
	return Boolean(
		session && access && session.toolsReadOnly === context.toolsReadOnly,
	);
}

export function createParlumeToolRuntime(
	context: ParlumeActionContext,
): AgentToolRuntime {
	let proposal: Promise<unknown> | undefined;
	return {
		projectScope: {
			projectId: context.projectId,
			userId: context.userId,
			organizationId: context.organizationId,
		},
		abortSignal: context.signal,
		invoke: async (invocation: AgentToolInvocation) => {
			if (!(await sessionIsCurrent(context))) {
				return {
					error: "The meeting request was interrupted or access changed. Ask again.",
				};
			}
			if (
				invocation.delegates ||
				classifyReadOnlyToolAccess(invocation.source.originalName) ===
					"READ"
			) {
				return invocation.execute();
			}
			if (context.toolsReadOnly) {
				return {
					error: "This meeting is read-only. Invite Parlume with actions enabled to request changes.",
				};
			}
			if (
				invocation.source.configId === "builtin" &&
				typeof invocation.args === "object" &&
				invocation.args !== null &&
				"projectId" in invocation.args &&
				invocation.args.projectId !== context.projectId
			) {
				return {
					error: "This meeting can only change its own project.",
				};
			}
			if (!context.speakerId) {
				return {
					error: "I cannot reliably identify the requester. Please make this change in the agent chat.",
				};
			}
			proposal ??= proposeParlumeAction(context, invocation);
			return proposal;
		},
	};
}

async function proposeParlumeAction(
	context: ParlumeActionContext,
	invocation: AgentToolInvocation,
) {
	if (!context.speakerId) {
		throw new Error("A speaker is required for approval.");
	}
	let args: ReturnType<typeof parlumeActionArguments>;
	try {
		args = parlumeActionArguments(invocation.args);
	} catch (error) {
		return {
			error:
				error instanceof Error
					? error.message
					: "This action cannot be approved by voice.",
		};
	}
	const invocationKey =
		invocation.callId ??
		parlumeFingerprint({ name: invocation.name, args });
	const action = await db.parlumeAction.upsert({
		where: {
			turnId_invocationKey: { turnId: context.turnId, invocationKey },
		},
		update: {},
		create: {
			turnId: context.turnId,
			sessionId: context.sessionId,
			projectId: context.projectId,
			organizationId: context.organizationId,
			userId: context.userId,
			speakerId: context.speakerId,
			speakerName: context.speakerName,
			invocationKey,
			toolName: invocation.name,
			toolConfigId: invocation.source.configId,
			toolOriginalName: invocation.source.originalName,
			toolFingerprint: parlumeToolFingerprint(invocation),
			agentRevision: context.agentRevision,
			arguments: args,
			summary: describeParlumeAction(invocation.name, args),
			expiresAt: new Date(Date.now() + PARLUME_APPROVAL_TTL_MS),
		},
	});
	return {
		status: "awaiting_confirmation",
		actionId: action.id,
		proposal: action.summary,
		instruction:
			"No change has been made. Stop here and ask the requester to confirm this one action.",
	};
}

export async function prepareParlumeDecision(
	context: ParlumeActionContext,
	requestText: string,
): Promise<{
	response?: string;
	runtime?: AgentToolRuntime;
}> {
	const decision = parseParlumeDecision(requestText);
	const pendingStatuses: Array<"PROPOSED" | "AWAITING_CONFIRMATION"> = [
		"PROPOSED",
		"AWAITING_CONFIRMATION",
	];
	const pendingWhere = {
		sessionId: context.sessionId,
		organizationId: context.organizationId,
		projectId: context.projectId,
		speakerId: context.speakerId ?? "",
		status: { in: pendingStatuses },
	};
	if (!decision) {
		await db.parlumeAction.updateMany({
			where: pendingWhere,
			data: {
				status: "CANCELLED",
				outcome: "Superseded by a new request from the requester.",
			},
		});
		return {};
	}
	if (!context.speakerId) {
		return {
			response:
				"I cannot identify the speaker, so I cannot accept this confirmation.",
		};
	}
	const action = await db.parlumeAction.findFirst({
		where: pendingWhere,
		orderBy: { createdAt: "desc" },
	});
	if (!action) {
		return { response: "There is no pending action for you to confirm." };
	}
	if (decision === "cancel") {
		await db.parlumeAction.updateMany({
			where: { ...pendingWhere, id: action.id },
			data: {
				status: "CANCELLED",
				outcome: "Cancelled by the requester.",
			},
		});
		return { response: "Cancelled. No change was made." };
	}
	if (action.expiresAt <= new Date()) {
		await db.parlumeAction.updateMany({
			where: { ...pendingWhere, id: action.id },
			data: { status: "EXPIRED" },
		});
		return {
			response: "That approval request has expired. Please ask me again.",
		};
	}
	if (action.status !== "AWAITING_CONFIRMATION" || !action.presentedAt) {
		return {
			response:
				"The proposal was interrupted before it finished. Please ask me to propose it again.",
		};
	}
	if (
		action.agentRevision !== context.agentRevision ||
		context.toolsReadOnly
	) {
		await db.parlumeAction.updateMany({
			where: { ...pendingWhere, id: action.id },
			data: { status: "INVALIDATED" },
		});
		return {
			response:
				"The agent or its permissions changed. Please ask me again so I can prepare a fresh proposal.",
		};
	}
	const runtime = createParlumeToolRuntime(context);
	return {
		runtime: {
			...runtime,
			requiredTool: {
				configId: action.toolConfigId,
				originalName: action.toolOriginalName,
			},
			prepared: async (tools, sources) => {
				const toolName =
					action.toolConfigId === "builtin"
						? action.toolName
						: Object.keys(sources).find(
								(name) =>
									sources[name]?.configId ===
										action.toolConfigId &&
									sources[name]?.originalName ===
										action.toolOriginalName,
							);
				const definition = toolName ? tools[toolName] : undefined;
				const source = {
					configId: action.toolConfigId,
					originalName: action.toolOriginalName,
				};
				if (
					!isExecutableAgentTool(definition) ||
					parlumeToolFingerprint({
						...definition,
						name: action.toolName,
						source,
					}) !== action.toolFingerprint ||
					!(await sessionIsCurrent(context))
				) {
					await db.parlumeAction.updateMany({
						where: { ...pendingWhere, id: action.id },
						data: { status: "INVALIDATED" },
					});
					return "The action or access changed. Please ask me again for a fresh proposal.";
				}
				const claimed = await db.$transaction(async (tx) => {
					const current = await tx.parlumeMeetingSession.updateMany({
						where: {
							id: context.sessionId,
							status: "ACTIVE",
							toolsReadOnly: false,
							voiceGeneration: context.voiceGeneration,
							activeTurnId: context.turnId,
						},
						data: { updatedAt: new Date() },
					});
					if (!current.count) {
						return false;
					}
					const result = await tx.parlumeAction.updateMany({
						where: {
							...pendingWhere,
							id: action.id,
							status: "AWAITING_CONFIRMATION",
							expiresAt: { gt: new Date() },
							presentedAt: { not: null },
						},
						data: {
							status: "EXECUTING",
							confirmationTurnId: context.turnId,
							confirmedAt: new Date(),
						},
					});
					if (result.count === 1) {
						await recordAuditTx(tx, {
							action: "project.parlume.action_confirmed",
							category: "project",
							severity: "info",
							outcome: "success",
							actor: { type: "user", userId: context.userId },
							organizationId: context.organizationId,
							projectId: context.projectId,
							resource: { type: "parlume_action", id: action.id },
							metadata: {
								sessionId: context.sessionId,
								requesterSpeakerId: context.speakerId,
								confirmationTurnId: context.turnId,
								toolName: action.toolName,
							},
						});
					}
					return result.count === 1;
				});
				if (!claimed) {
					return "This action has already been handled or expired. I will not repeat it.";
				}
				try {
					if (
						!(await sessionIsCurrent(context)) ||
						!(await verifyParlumeVoiceGeneration(context))
					) {
						await db.parlumeAction.update({
							where: { id: action.id },
							data: {
								status: "CANCELLED",
								completedAt: new Date(),
								outcome: "Interrupted before dispatch.",
							},
						});
						return "The request was interrupted before dispatch. No change was made.";
					}
					const result = await withAgentToolRuntime(runtime, () =>
						withApprovedAgentTool(
							{
								...source,
								userId: context.userId,
								organizationId: context.organizationId,
								args: action.arguments,
							},
							async () =>
								definition.execute(action.arguments, {
									toolCallId: action.id,
									messages: [],
									abortSignal: context.signal,
								}),
						),
					);
					const status = parlumeActionOutcome(result);
					const outcome = redactLogText(
						JSON.stringify(result) ?? "Completed",
					).text.slice(0, 4_000);
					await db.parlumeAction.update({
						where: { id: action.id },
						data: {
							status,
							completedAt: new Date(),
							outcome,
						},
					});
					return status === "COMPLETED"
						? "The confirmed action completed. The result is in Parlume history."
						: status === "FAILED"
							? "The action could not be completed. The result is in Parlume history."
							: "The tool returned a result, but completion is not verified. Check Parlume history and the destination before trying again.";
				} catch {
					await db.parlumeAction.update({
						where: { id: action.id },
						data: {
							status: "OUTCOME_UNKNOWN",
							completedAt: new Date(),
							outcome:
								"Execution was interrupted. Verify the destination before trying again; this action will not be retried automatically.",
						},
					});
					return "I could not verify the outcome. Please check the destination before requesting it again.";
				}
			},
		},
	};
}
