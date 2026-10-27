import { canEditProject, db, isProjectReadOnly } from "@repo/database";
import { ApplicationFailure, Context } from "@temporalio/activity";

/** Resolve a workflow-owned execution and recheck its creator before remote mutation. */
export async function authorizeWeaveRuntime(input: {
	userId: string;
	organizationId?: string | null;
	sessionId?: string;
}) {
	const info = Context.current().info;
	if (!info.workflowExecution) {
		throw ApplicationFailure.nonRetryable(
			"Missing workflow identity",
			"INVALID_SESSION",
		);
	}
	const execution = await db.weaveExecution.findFirst({
		where: {
			workflowId: info.workflowExecution.workflowId,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			...(input.sessionId ? { sandboxSessionId: input.sessionId } : {}),
		},
		select: { id: true, projectId: true },
	});
	if (
		!execution ||
		!(await canEditProject(execution.projectId, input.userId))
	) {
		throw ApplicationFailure.nonRetryable(
			"Execution is no longer authorized",
			"INVALID_SESSION",
		);
	}
	if (await isProjectReadOnly(execution.projectId)) {
		throw ApplicationFailure.nonRetryable(
			"Project is read-only",
			"WORKSPACE_ERROR",
		);
	}
	return { execution, info, workflow: info.workflowExecution };
}
