/**
 * Starts and signals a repository import run (specs/2026-10-23-repository-import).
 * Kept free of workflow imports so `@repo/api` can call it without pulling
 * the workflow bundle in.
 */

import type { ProjectImportSelection } from "@repo/database";
import type { Client } from "@temporalio/client";

export type ProjectImportStart = {
	runId: string;
	projectId: string;
	organizationId: string;
	userId: string;
};

export function projectImportWorkflowId(runId: string): string {
	return `project-import-${runId}`;
}

type Decorate = { decorateStartOptions?: <T extends object>(options: T) => T };

export async function startProjectImportWorkflow(
	client: Client,
	input: ProjectImportStart,
	options: Decorate = {},
): Promise<{ workflowId: string }> {
	const workflowId = projectImportWorkflowId(input.runId);
	const startOptions = {
		taskQueue: "project-documents",
		workflowId,
		args: [input],
		workflowIdConflictPolicy: "FAIL" as const,
		workflowExecutionTimeout: "8 days" as const,
	};
	await client.workflow.start(
		"projectImportWorkflow",
		options.decorateStartOptions
			? options.decorateStartOptions(startOptions)
			: startOptions,
	);
	return { workflowId };
}

/** Hands the person's selection to the waiting run. Throws when the run is no longer open. */
export async function signalProjectImportApply(
	client: Client,
	runId: string,
	selection: ProjectImportSelection,
): Promise<void> {
	await client.workflow
		.getHandle(projectImportWorkflowId(runId))
		.signal("apply", selection);
}
