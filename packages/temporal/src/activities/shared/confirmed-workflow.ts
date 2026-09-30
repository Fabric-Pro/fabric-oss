import { getBaseUrl } from "@repo/utils";
import type { ReadOnlyBlockedOutput } from "@repo/utils/read-only-mode";
import { z } from "zod";
import {
	agentToolAbortSignal,
	agentToolProjectScope,
	hasExactAgentToolApproval,
} from "./agent-tool-runtime";
import { guardToolWriteForReadOnly } from "./read-only-gate";

export async function executeApprovedWorkflow(input: {
	args: { workflowId: string };
	userId: string;
	organizationId?: string;
}): Promise<Record<string, unknown> | ReadOnlyBlockedOutput | undefined> {
	if (
		!hasExactAgentToolApproval({
			...input,
			configId: "builtin",
			originalName: "execute_workflow",
		})
	) {
		return;
	}
	const scope = agentToolProjectScope();
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (
		!scope ||
		!secret ||
		scope.userId !== input.userId ||
		scope.organizationId !== input.organizationId
	) {
		return {
			error: "A verified project context is required to start this workflow.",
		};
	}
	const readOnlyBlock = await guardToolWriteForReadOnly(
		scope.projectId,
		"execute_workflow",
	);
	if (readOnlyBlock) {
		return readOnlyBlock;
	}
	try {
		const response = await fetch(
			new URL("/api/agents/fabric-ai/execute-workflow", getBaseUrl()),
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Agent-Service-Token": secret,
				},
				body: JSON.stringify({
					...input.args,
					organizationId: input.organizationId,
					serviceUserId: input.userId,
					projectId: scope.projectId,
				}),
				signal: agentToolAbortSignal(AbortSignal.timeout(30_000)),
			},
		);
		const result = z
			.record(z.string(), z.unknown())
			.parse(await response.json());
		if (response.status >= 500 && result.code !== "EXECUTION_NOT_STARTED") {
			return { ...result, status: "unconfirmed" };
		}
		return result;
	} catch {
		return {
			status: "unconfirmed",
			error: "The workflow start could not be verified. Check its execution history before trying again.",
		};
	}
}
