/**
 * Instructions consolidation activities (specs/2026-10-21-ai-artifacts-hub
 * §5.2, P4). The activities barrel re-exports this module, so EVERY export
 * here is a schedulable activity: the git work lives in
 * ./lib/instruction-consolidation-git.
 *
 * The run's row (`InstructionConsolidation`) is the only state: each
 * activity reads it, does one idempotent step and records the step's
 * result. A step that cannot succeed by retrying fails non-retryably with a
 * message the Coding Instructions tab shows as is.
 */
import {
	getInstructionConsolidation,
	getProjectRepoIntegration,
	type InstructionConsolidationFile,
	type InstructionConsolidationStep,
	InstructionMigrationOpenError,
	updateInstructionConsolidation,
	upsertInstructionRepositorySync,
} from "@repo/database";
import { logger } from "@repo/logs";
import { ApplicationFailure, Context } from "@temporalio/activity";
import {
	type CommitIdentity,
	ConsolidationStepError,
	runConsolidationCleanup,
	runConsolidationCopy,
} from "./lib/instruction-consolidation-git";

export type InstructionConsolidationWorkflowInput = {
	consolidationId: string;
	projectId: string;
	organizationId: string;
	userId: string;
	author: CommitIdentity;
	committer: CommitIdentity;
};

export type ConsolidationStepInput = InstructionConsolidationWorkflowInput & {
	/** ISO 8601 UTC, whole seconds; fixed by the workflow so a retry builds the same commit. */
	date: string;
};

async function loadRun(input: ConsolidationStepInput) {
	const run = await getInstructionConsolidation(
		input.consolidationId,
		input.projectId,
	);
	if (!run?.targetIntegrationId || !run.targetRepositoryUrl) {
		throw ApplicationFailure.nonRetryable(
			"The consolidation run no longer exists.",
			"CONSOLIDATION_GONE",
		);
	}
	return {
		...run,
		targetIntegrationId: run.targetIntegrationId,
		targetRepositoryUrl: run.targetRepositoryUrl,
		files: run.files as unknown as InstructionConsolidationFile[],
	};
}

function stepFailure(error: unknown): never {
	if (error instanceof ConsolidationStepError) {
		const retryable =
			error.code === "REPOSITORY_UNAVAILABLE" ||
			error.code === "AUTHENTICATION_FAILED";
		if (!retryable || Context.current().info.attempt >= 3) {
			throw ApplicationFailure.nonRetryable(error.message, error.code);
		}
		throw ApplicationFailure.retryable(error.message, error.code);
	}
	logger.warn("[instruction-consolidation] step failed", {
		error: error instanceof Error ? error.name : typeof error,
	});
	throw error;
}

export async function recordConsolidationStepActivity(input: {
	consolidationId: string;
	projectId: string;
	step?: InstructionConsolidationStep;
	status?: "RUNNING" | "COMPLETED" | "FAILED";
	error?: string | null;
}): Promise<void> {
	await updateInstructionConsolidation(
		input.consolidationId,
		input.projectId,
		{
			...(input.step ? { step: input.step } : {}),
			...(input.status ? { status: input.status } : {}),
			...(input.error !== undefined ? { error: input.error } : {}),
		},
	);
}

export async function copyConsolidationFilesActivity(
	input: ConsolidationStepInput,
): Promise<{ copiedCommitSha: string }> {
	const run = await loadRun(input);
	try {
		const copied = await runConsolidationCopy({
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId,
			sourceIntegrationId: run.sourceIntegrationId,
			targetIntegrationId: run.targetIntegrationId,
			files: run.files,
			author: input.author,
			committer: input.committer,
			date: input.date,
			signal: Context.current().cancellationSignal,
		});
		await updateInstructionConsolidation(run.id, input.projectId, {
			sourceCommitSha: copied.sourceCommitSha,
			copiedCommitSha: copied.copiedCommitSha,
		});
		return { copiedCommitSha: copied.copiedCommitSha };
	} catch (error) {
		stepFailure(error);
	}
}

/**
 * Points the project's Coding Instructions at the instructions repository
 * (its root, on its default branch): from here on the instructions are read
 * from it and every change is committed to it.
 */
export async function configureConsolidationSyncActivity(
	input: ConsolidationStepInput,
): Promise<void> {
	const run = await loadRun(input);
	const target = await getProjectRepoIntegration(
		run.targetIntegrationId,
		input.projectId,
	);
	if (!target) {
		throw ApplicationFailure.nonRetryable(
			"The instructions repository is no longer connected to the project.",
			"REPOSITORY_UNAVAILABLE",
		);
	}
	try {
		const written = await upsertInstructionRepositorySync({
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			repositoryIntegrationId: target.id,
			ref: target.defaultBranch,
			rootPath: "",
		});
		if (!written) {
			throw ApplicationFailure.nonRetryable(
				"The project no longer exists.",
				"PROJECT_GONE",
			);
		}
	} catch (error) {
		if (error instanceof InstructionMigrationOpenError) {
			throw ApplicationFailure.nonRetryable(
				"The project's instructions are already being moved into a repository. Finish or cancel that move first.",
				"MIGRATION_OPEN",
			);
		}
		throw error;
	}
}

export async function openConsolidationCleanupActivity(
	input: ConsolidationStepInput,
): Promise<{ pullRequestUrl: string | null }> {
	const run = await loadRun(input);
	try {
		const opened = await runConsolidationCleanup({
			consolidationId: run.id,
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId,
			sourceIntegrationId: run.sourceIntegrationId,
			targetRepositoryUrl: run.targetRepositoryUrl,
			files: run.files,
			author: input.author,
			committer: input.committer,
			date: input.date,
			signal: Context.current().cancellationSignal,
		});
		if (opened.pullRequestUrl) {
			await updateInstructionConsolidation(run.id, input.projectId, {
				cleanupPullRequestUrl: opened.pullRequestUrl,
				...(opened.pullRequestId
					? { cleanupPullRequestId: opened.pullRequestId }
					: {}),
				// The head Fabric first saw is the one a merge from Fabric
				// expects; a retry that finds the pull request again never
				// replaces it with whatever the branch holds by then.
				...(opened.headSha && !run.cleanupHeadSha
					? { cleanupHeadSha: opened.headSha }
					: {}),
			});
		}
		// The workflow's result keeps its shape.
		return { pullRequestUrl: opened.pullRequestUrl };
	} catch (error) {
		stepFailure(error);
	}
}
