/**
 * Starts an instructions consolidation run (specs/2026-10-21-ai-artifacts-hub
 * §5.2). Kept free of workflow imports so `@repo/api` can call it without
 * pulling the workflow bundle in.
 */

import type { Client } from "@temporalio/client";

export type InstructionConsolidationStart = {
	consolidationId: string;
	projectId: string;
	organizationId: string;
	userId: string;
	author: { name: string; email: string };
	committer: { name: string; email: string };
};

export function instructionConsolidationWorkflowId(
	consolidationId: string,
): string {
	return `instruction-consolidation-${consolidationId}`;
}

export async function startInstructionConsolidationWorkflow(
	client: Client,
	input: InstructionConsolidationStart,
	options: {
		decorateStartOptions?: <T extends object>(options: T) => T;
	} = {},
): Promise<{ workflowId: string }> {
	const workflowId = instructionConsolidationWorkflowId(
		input.consolidationId,
	);
	const startOptions = {
		taskQueue: "project-instructions",
		workflowId,
		args: [input],
		workflowIdConflictPolicy: "FAIL" as const,
		workflowExecutionTimeout: "2 hours" as const,
	};
	await client.workflow.start(
		"instructionConsolidationWorkflow",
		options.decorateStartOptions
			? options.decorateStartOptions(startOptions)
			: startOptions,
	);
	return { workflowId };
}
