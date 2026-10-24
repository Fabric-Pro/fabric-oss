import { randomUUID } from "node:crypto";
import {
	canEditProject,
	db,
	hasProjectAccess,
	recordAuditTx,
} from "@repo/database";
import { redactLogText } from "@repo/utils/log-redaction";
import { classifyReadOnlyToolAccess } from "@repo/utils/read-only-mode";
import { foreignProjectId } from "../lib/fabric-portal-tools";
import {
	parlumeActionArguments,
	parlumeActionOutcome,
	parlumeFingerprint,
	parlumeToolFingerprint,
	summarizeParlumeAction,
} from "./parlume-action-policy";
import { createParlumeMeetingChatTool } from "./parlume-chat-tool";
import { offerHeldChange } from "./parlume-held-change";
import { readParlumeVoiceState } from "./parlume-voice";
import {
	type AgentToolInvocation,
	type AgentToolRuntime,
	RUNTIME_TOOL_CONFIG_ID,
	withApprovedAgentTool,
} from "./shared/agent-tool-runtime";
import { FABRIC_PLATFORM_CONFIG_ID } from "./shared/fabric-confirmation";

export interface ParlumeActionContext {
	turnId: string;
	sessionId: string;
	projectId: string;
	organizationId: string;
	userId: string;
	speakerId: string | null;
	speakerName: string | null;
	/** The request as asked: what a held change's `go` asks for again. */
	requestText: string;
	agentRevision: string;
	voiceGeneration: number;
	toolsReadOnly: boolean;
	signal?: AbortSignal;
}

/** Recorded for a change asked for by a speaker Teams gave no identity for. */
const UNATTRIBUTED_SPEAKER = "unattributed";

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

/**
 * Whether the call names a project other than the meeting's own. Fabric's own
 * tools and built-in tools take a `projectId` argument that a participant must
 * not be able to point elsewhere.
 */
function namesOtherProject(
	context: ParlumeActionContext,
	invocation: AgentToolInvocation,
): boolean {
	return foreignProjectId(invocation.args, context.projectId) !== null;
}

export function createParlumeToolRuntime(
	context: ParlumeActionContext,
): AgentToolRuntime {
	return {
		projectScope: {
			projectId: context.projectId,
			userId: context.userId,
			organizationId: context.organizationId,
		},
		abortSignal: context.signal,
		deferStoryDrafting: true,
		tools: createParlumeMeetingChatTool(context),
		invoke: async (invocation: AgentToolInvocation) => {
			if (!(await sessionIsCurrent(context))) {
				return {
					error: "The meeting request was interrupted or access changed. Ask again.",
				};
			}
			// Writing in the meeting chat changes nothing in Fabric, so it is
			// open to a read-only meeting.
			if (invocation.source.configId === RUNTIME_TOOL_CONFIG_ID) {
				return invocation.execute();
			}
			if (
				invocation.source.configId === FABRIC_PLATFORM_CONFIG_ID &&
				namesOtherProject(context, invocation)
			) {
				return {
					error: "This meeting can only use its own project.",
				};
			}
			if (
				invocation.delegates ||
				(invocation.source.access ??
					classifyReadOnlyToolAccess(
						invocation.source.originalName,
					)) === "READ"
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
				namesOtherProject(context, invocation)
			) {
				return {
					error: "This meeting can only change its own project.",
				};
			}
			return runParlumeAction(context, invocation);
		},
	};
}

/**
 * Makes a change a speaker asked for, with the inviter's permissions, and
 * records it. The record is written before the change runs, so a turn that
 * stops halfway leaves an action whose outcome is unknown rather than no trace,
 * and it is the claim that keeps one call from running twice in a turn.
 */
async function runParlumeAction(
	context: ParlumeActionContext,
	invocation: AgentToolInvocation,
) {
	let args: ReturnType<typeof parlumeActionArguments>;
	try {
		args = parlumeActionArguments(invocation.args);
	} catch (error) {
		return {
			error:
				error instanceof Error
					? error.message
					: "This action cannot be made by voice.",
		};
	}
	const invocationKey = parlumeFingerprint({ name: invocation.name, args });
	const actionId = randomUUID();
	const claimed = await db.$transaction(async (tx) => {
		const created = await tx.parlumeAction.createMany({
			data: {
				turnId: context.turnId,
				sessionId: context.sessionId,
				projectId: context.projectId,
				organizationId: context.organizationId,
				userId: context.userId,
				speakerId: context.speakerId ?? UNATTRIBUTED_SPEAKER,
				speakerName: context.speakerName,
				id: actionId,
				invocationKey,
				toolName: invocation.name,
				toolConfigId: invocation.source.configId,
				toolOriginalName: invocation.source.originalName,
				toolFingerprint: parlumeToolFingerprint(invocation),
				agentRevision: context.agentRevision,
				arguments: args,
				summary: summarizeParlumeAction(invocation.name, args),
				status: "EXECUTING",
				expiresAt: new Date(),
			},
			skipDuplicates: true,
		});
		if (created.count === 1) {
			await recordAuditTx(tx, {
				action: "project.parlume.action_confirmed",
				category: "project",
				severity: "info",
				outcome: "success",
				actor: { type: "user", userId: context.userId },
				organizationId: context.organizationId,
				projectId: context.projectId,
				resource: { type: "parlume_action", id: actionId },
				metadata: {
					sessionId: context.sessionId,
					requesterSpeakerId: context.speakerId,
					turnId: context.turnId,
					toolName: invocation.name,
				},
			});
		}
		return created.count === 1;
	});
	if (!claimed) {
		const earlier = await db.parlumeAction.findUnique({
			where: {
				turnId_invocationKey: { turnId: context.turnId, invocationKey },
			},
		});
		return {
			alreadyRequested: true,
			status: earlier?.status.toLowerCase(),
			outcome: earlier?.outcome ?? undefined,
			instruction:
				"This exact change was already requested in this turn. Do not repeat it.",
		};
	}
	try {
		const voice = await readParlumeVoiceState(context);
		if (!voice.current || voice.muted) {
			await db.parlumeAction.update({
				where: { id: actionId },
				data: {
					status: "CANCELLED",
					completedAt: new Date(),
					outcome: voice.current
						? "Held before dispatch: the meeting spoke over Parlume. Offered again in the meeting chat."
						: "Interrupted before dispatch.",
				},
			});
			if (voice.current) {
				return offerHeldChange(context, invocation.name, args);
			}
			return {
				error: "The request was interrupted before dispatch. No change was made.",
			};
		}
		const result = await withApprovedAgentTool(
			{
				configId: invocation.source.configId,
				originalName: invocation.source.originalName,
				userId: context.userId,
				organizationId: context.organizationId,
				args: invocation.args,
			},
			invocation.execute,
		);
		await db.parlumeAction.update({
			where: { id: actionId },
			data: {
				status: parlumeActionOutcome(result),
				completedAt: new Date(),
				outcome: redactLogText(
					JSON.stringify(result) ?? "Completed",
				).text.slice(0, 4_000),
			},
		});
		return result;
	} catch {
		await db.parlumeAction.update({
			where: { id: actionId },
			data: {
				status: "OUTCOME_UNKNOWN",
				completedAt: new Date(),
				outcome:
					"Execution was interrupted. Verify the destination before trying again; this action will not be retried automatically.",
			},
		});
		return {
			error: "I could not verify the outcome. Check the destination before requesting it again.",
		};
	}
}
