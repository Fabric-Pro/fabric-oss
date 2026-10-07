/**
 * The activities of the repository sync follow-up workflow
 * (`workflows/project-repository-sync-follow-up.ts`): wait for the project's
 * open sync run to close, then start the run a member asked for by changing
 * what is synced while that one was still going.
 *
 * Both are for the two repository syncs alike, told apart by `subject`.
 */
import { setTimeout as sleep } from "node:timers/promises";
import {
	getContextRepositorySync,
	getInstructionRepositorySync,
	getProjectInstructionSettings,
	instructionRepositoryImportAllowed,
} from "@repo/database";
import {
	contextRepositorySyncWorkflowId,
	instructionRepositorySyncWorkflowId,
	type RepositorySyncFollowUpSubject,
} from "@repo/instructions/workflow-ids";
import { heartbeat } from "@temporalio/activity";
import { getTemporalClient } from "../client";
import {
	REPOSITORY_SYNC_FOLLOW_UP_WAIT_MS,
	type RepositorySyncClosedResult,
	type RepositorySyncFollowUpInput,
	type RepositorySyncFollowUpOutcome,
} from "../lib/repository-sync-follow-up";
import { startManualContextSync } from "./lib/context-sync-start";
import { startManualInstructionSync } from "./lib/instruction-sync-start";

const POLL_MS = 5_000;

function syncWorkflowId(
	subject: RepositorySyncFollowUpSubject,
	projectId: string,
): string {
	switch (subject) {
		case "instructions":
			return instructionRepositorySyncWorkflowId(projectId);
		case "context":
			return contextRepositorySyncWorkflowId(projectId);
		default: {
			const unreachable: never = subject;
			return unreachable;
		}
	}
}

/**
 * Waits up to one `REPOSITORY_SYNC_FOLLOW_UP_WAIT_MS` for the project's sync
 * execution to stop being open. `closed: false` means it is still going and
 * the workflow asks again; a describe that fails for any reason but "no such
 * execution" is not read as closed.
 */
export async function awaitRepositorySyncClosed(input: {
	subject: RepositorySyncFollowUpSubject;
	projectId: string;
}): Promise<RepositorySyncClosedResult> {
	const client = await getTemporalClient();
	const handle = client.workflow.getHandle(
		syncWorkflowId(input.subject, input.projectId),
	);
	const deadline = Date.now() + REPOSITORY_SYNC_FOLLOW_UP_WAIT_MS;
	for (;;) {
		try {
			const description = await handle.describe();
			if (description.status.name !== "RUNNING") {
				return { closed: true };
			}
		} catch (error) {
			if (
				error instanceof Error &&
				error.name === "WorkflowNotFoundError"
			) {
				return { closed: true };
			}
			throw error;
		}
		if (Date.now() + POLL_MS > deadline) {
			return { closed: false };
		}
		heartbeat({ phase: "await-sync-closed" });
		await sleep(POLL_MS);
	}
}

/**
 * Starts the queued run, as the member who asked for it, with the sync's own
 * `FAIL` conflict policy. `already_running` is a normal answer and enough: a
 * run that is open now was started after the change and reads the
 * configuration fresh when it begins, so it is the run that was asked for.
 * A configuration that has since been removed, or whose repository
 * connection is no longer usable, starts nothing.
 */
export async function startQueuedRepositorySync(
	input: RepositorySyncFollowUpInput,
): Promise<{ outcome: RepositorySyncFollowUpOutcome }> {
	const sync =
		input.subject === "instructions"
			? await getInstructionRepositorySync(
					input.projectId,
					input.organizationId,
				)
			: await getContextRepositorySync(
					input.projectId,
					input.organizationId,
				);
	if (!sync) {
		return { outcome: "not_configured" };
	}
	if (input.subject === "instructions") {
		const settings = await getProjectInstructionSettings(
			input.projectId,
			input.organizationId,
		);
		if (!instructionRepositoryImportAllowed(settings, sync.id)) {
			return { outcome: "direct_repository" };
		}
	}
	if (sync.repositoryIntegration.status !== "ACTIVE") {
		return { outcome: "integration_unavailable" };
	}
	const start =
		input.subject === "instructions"
			? startManualInstructionSync
			: startManualContextSync;
	const started = await start({
		projectId: input.projectId,
		organizationId: input.organizationId,
		requesterUserId: input.requesterUserId,
	});
	return { outcome: started ? "started" : "already_running" };
}
