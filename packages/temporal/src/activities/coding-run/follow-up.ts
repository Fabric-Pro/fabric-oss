import { canEditProject, db, isProjectReadOnly } from "@repo/database";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { isFabricAgentsBridgeEnabled } from "../../lib/coding-execution/bridge-rollout";
import { getCodingExecutionProvider } from "../../lib/coding-execution/get-provider";

export interface CodingRunFollowUpInput {
	codingRunId: string;
	providerMetadata?: unknown;
	projectId: string;
	organizationId: string;
	userId: string;
	sessionId: string;
	promptId: string;
	content: string;
}

/** Re-check the actor and bound run when delivery actually executes, including retries. */
export async function deliverCodingRunFollowUp(
	input: CodingRunFollowUpInput,
): Promise<{ messageId: string }> {
	const workflow = Context.current().info.workflowExecution;
	if (!workflow) {
		throw ApplicationFailure.nonRetryable(
			"Missing continuation workflow identity",
			"INVALID_SESSION",
		);
	}
	const workflowId = workflow.workflowId;
	const run = await db.codingRun.findFirst({
		where: {
			id: input.codingRunId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			provider: "BACKGROUND_AGENTS",
			providerSessionId: input.sessionId,
			workflowId,
			status: {
				in: ["STARTING", "RUNNING", "AWAITING_REVIEW", "PR_OPENED"],
			},
		},
	});
	if (
		!run ||
		!isFabricAgentsBridgeEnabled() ||
		!(await canEditProject(input.projectId, input.userId)) ||
		(await isProjectReadOnly(input.projectId))
	) {
		throw ApplicationFailure.nonRetryable(
			"The existing coding session is no longer authorized for continuation",
			"INVALID_SESSION",
		);
	}
	const receipt = await getCodingExecutionProvider(
		"BACKGROUND_AGENTS",
		run.providerMetadata,
	).sendPrompt(input.sessionId, input.content, input.userId, {
		promptId: input.promptId,
	});
	if (!receipt) {
		throw ApplicationFailure.nonRetryable(
			"Native prompt receipt is missing",
			"RECOVERY_REQUIRED",
		);
	}
	await db.codingRunEvent.upsert({
		where: { id: `follow-up:${input.codingRunId}:${input.promptId}` },
		create: {
			id: `follow-up:${input.codingRunId}:${input.promptId}`,
			codingRunId: input.codingRunId,
			eventType: "follow_up_sent",
			providerEventId: receipt.messageId,
			payloadJson: {
				promptId: input.promptId,
				messageId: receipt.messageId,
				authorId: input.userId,
			},
		},
		update: {},
	});
	await db.codingRun.updateMany({
		where: { id: input.codingRunId, workflowId, status: "STARTING" },
		data: { status: "RUNNING" },
	});
	return receipt;
}
