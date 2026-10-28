/**
 * Coding Run Activities
 * Activities for managing background agent coding execution sessions.
 */

import type { Prisma } from "@repo/database";
import {
	addCodingRunEvent,
	canEditProject,
	createCodingRun,
	db,
	isProjectReadOnly,
	updateCodingRunStatus,
} from "@repo/database";
import type {
	CodingRunProvider,
	CodingRunStatus,
} from "@repo/database/prisma/generated/client";
import { getAmbientProjectId } from "@repo/utils/project-context";
import {
	READ_ONLY_MODE_ERROR_CODE,
	READ_ONLY_MODE_MESSAGE,
} from "@repo/utils/read-only-mode";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { isFabricAgentsBridgeEnabled } from "../../lib/coding-execution/bridge-rollout";
import {
	AuthError,
	RuntimeNotFoundError,
	SessionValidationError,
} from "../../lib/coding-execution/errors";
import { getCodingExecutionProvider } from "../../lib/coding-execution/get-provider";
import { getLocalKanbanSessionUrl } from "../../lib/coding-execution/local-kanban-provider";
import { dispatchLifecycleEvent } from "../../lib/lifecycle-dispatcher";

// Spike run activities (plan Slice 3) live in ./spike and are part of this
// activity module so the workflow can proxy them alongside the others.
export * from "./spike";

// -- Types --

export interface CreateCodingRunRecordInput {
	projectId: string;
	storyId: string;
	storyTaskId?: string;
	userId: string;
	organizationId?: string;
	repositoryUrl?: string;
	repositoryOwner?: string;
	repositoryName?: string;
	targetBranch?: string;
	promptText?: string;
	workflowId?: string;
}

export interface CreateExecutionSessionInput {
	fabricAgentsBridgeEnabled?: boolean;
	provider: CodingRunProvider;
	repoOwner: string;
	repoName: string;
	projectName?: string;
	organizationName?: string;
	title?: string;
	branch?: string;
	headBranch?: string;
	userId?: string;
	workingDirectory?: string;
	promptText?: string;
	/** Fabric CodingRun ID — passed to fabric-agent-server for idempotent worktree & session binding */
	codingRunId?: string;
	/** Temporal workflow ID — passed to fabric-agent-server for run correlation */
	workflowId?: string;
	/** Fabric organization ID — passed to fabric-agent-server for tenant binding */
	organizationId?: string;
	/**
	 * Owning Fabric project — enables the Read-only mode gate:
	 * a session ends in a branch + PR on the connected repository.
	 */
	projectId?: string;
	/** Optional Fabric Agents backend connection slug (e.g. "claude-max", "codex", "cursor-cli", "antigravity-cli", "droid-cli", "grok-cli", "kimi-cli") */
	llmConnection?: string;
	/** Optional model identifier override */
	model?: string;
	/** Optional target machine / host identifier */
	targetMachine?: string;
}

export interface BuildImplementationPromptInput {
	storyId: string;
	projectId: string;
	storyTaskId?: string;
	userId: string;
	organizationId?: string;
	repositoryOwner?: string;
	repositoryName?: string;
	targetBranch?: string;
	workingDirectory?: string;
}

export interface PollExecutionStatusInput {
	provider: CodingRunProvider;
	sessionId: string;
}

export interface PollBackgroundAgentStatusOutput {
	providerStatus: string;
	fabricStatus: CodingRunStatus;
	branchName: string | null;
	error?: string | null;
	pullRequestUrl: string | null;
	pullRequestArtifact: {
		url: string;
		type: string;
	} | null;
}

export interface SyncCodingRunArtifactsInput {
	codingRunId: string;
	provider: CodingRunProvider;
	sessionId: string;
}

export interface SyncCodingRunArtifactsOutput {
	pullRequestUrl: string | null;
	pullRequestNumber?: number;
	branchName: string | null;
}

export interface UpdateCodingRunStatusInput {
	codingRunId: string;
	status: CodingRunStatus;
	data?: {
		providerSessionId?: string;
		pullRequestUrl?: string;
		pullRequestNumber?: number;
		pullRequestBranch?: string;
		externalUrl?: string;
		externalStatus?: string;
		providerMetadata?: Prisma.InputJsonValue;
	};
}

export interface AddCodingRunEventInput {
	codingRunId: string;
	eventType: string;
	payload?: Record<string, unknown>;
	providerEventId?: string;
}

export interface SendExecutionPromptInput {
	provider: CodingRunProvider;
	sessionId: string;
	content: string;
	authorId: string;
	/** Owning Fabric project — enables the Read-only mode gate. */
	projectId?: string;
}

export interface CancelExecutionSessionInput {
	provider: CodingRunProvider;
	sessionId: string;
}

// -- Helper --

/**
 * Read-only mode gate. Throws non-retryable when the owning
 * project is read-only — the coding-execution provider writes a branch + PR
 * to the connected repository, and retrying cannot succeed until an admin
 * disables the mode. No-op when the input carries no projectId (legacy
 * histories / non-project sessions).
 */
async function failIfProjectReadOnly(
	projectId: string | undefined,
): Promise<void> {
	const resolvedProjectId = projectId ?? getAmbientProjectId();
	if (resolvedProjectId && (await isProjectReadOnly(resolvedProjectId))) {
		throw ApplicationFailure.nonRetryable(
			READ_ONLY_MODE_MESSAGE,
			READ_ONLY_MODE_ERROR_CODE,
		);
	}
}

function mapProviderStatusToFabric(
	providerStatus: string,
	hasPrArtifact: boolean,
): CodingRunStatus {
	switch (providerStatus) {
		case "created":
			return "STARTING";
		case "active":
			return hasPrArtifact ? "PR_OPENED" : "RUNNING";
		case "paused":
			return "AWAITING_REVIEW";
		case "completed":
			return "COMPLETED";
		case "failed":
			return "FAILED";
		case "stopped":
		case "archived":
			return "CANCELLED";
		default:
			return "RUNNING";
	}
}

// -- Activities --

export async function createCodingRunRecord(
	input: CreateCodingRunRecordInput,
): Promise<{ codingRunId: string }> {
	const run = await createCodingRun({
		projectId: input.projectId,
		storyId: input.storyId,
		storyTaskId: input.storyTaskId,
		userId: input.userId,
		organizationId: input.organizationId,
		repositoryUrl: input.repositoryUrl,
		repositoryOwner: input.repositoryOwner,
		repositoryName: input.repositoryName,
		targetBranch: input.targetBranch,
		promptText: input.promptText,
		workflowId: input.workflowId,
	});
	return { codingRunId: run.id };
}

export async function createExecutionSession(
	input: CreateExecutionSessionInput,
): Promise<{
	sessionId: string;
	externalUrl?: string;
	externalStatus?: string;
	providerMetadata?: Prisma.InputJsonValue;
}> {
	// Read-only mode: the session creates a branch + PR on the
	// connected repository. The API start procedure blocks first; this gate
	// also covers runs already queued/in-flight when the toggle flipped and
	// the Weave delegation path (product decision 2026-07-23: code repos ARE
	// in read-only scope). Non-retryable — retrying cannot succeed until an
	// admin disables the mode.
	await failIfProjectReadOnly(input.projectId);
	try {
		if (
			input.provider === "BACKGROUND_AGENTS" &&
			input.fabricAgentsBridgeEnabled !== undefined &&
			input.fabricAgentsBridgeEnabled !== isFabricAgentsBridgeEnabled()
		) {
			throw ApplicationFailure.nonRetryable(
				"API and worker Fabric bridge rollout settings differ; no session was created",
				"VALIDATION_ERROR",
			);
		}
		const provider = getCodingExecutionProvider(input.provider);
		const result = await provider.createSession({
			repoOwner: input.repoOwner,
			repoName: input.repoName,
			projectName: input.projectName,
			organizationName: input.organizationName,
			title: input.title,
			branch: input.branch,
			headBranch: input.headBranch,
			userId: input.userId,
			workingDirectory: input.workingDirectory,
			promptText: input.promptText,
			codingRunId: input.codingRunId,
			workflowId: input.workflowId,
			organizationId: input.organizationId,
			llmConnection: input.llmConnection,
			model: input.model,
			targetMachine: input.targetMachine,
		});

		if (input.provider === "KANBAN_LOCAL") {
			return {
				sessionId: result.sessionId,
				externalUrl:
					result.externalUrl ??
					getLocalKanbanSessionUrl(result.sessionId),
				externalStatus: result.externalStatus,
				providerMetadata:
					result.providerMetadata as Prisma.InputJsonValue,
			};
		}

		return {
			sessionId: result.sessionId,
			externalUrl: result.externalUrl,
			externalStatus: result.externalStatus,
			providerMetadata: result.providerMetadata as Prisma.InputJsonValue,
		};
	} catch (error) {
		if (
			error instanceof AuthError ||
			error instanceof RuntimeNotFoundError ||
			error instanceof SessionValidationError
		) {
			throw ApplicationFailure.nonRetryable(error.message, error.name);
		}
		throw error;
	}
}

export async function buildImplementationPrompt(
	input: BuildImplementationPromptInput,
): Promise<string> {
	// Build tenant filter for XOR isolation via the project relation.
	// In org context, filter by organizationId only — Project.userId is the
	// owner, not the current user, so including it would exclude collaborators.
	const projectTenantFilter = input.organizationId
		? { organizationId: input.organizationId }
		: { organizationId: null, userId: input.userId };

	// Fetch story with tasks and project context
	const story = await db.userStory.findFirst({
		where: {
			id: input.storyId,
			projectId: input.projectId,
			project: projectTenantFilter,
		},
		include: {
			tasks: {
				where: { isCompleted: false },
				orderBy: { order: "asc" },
			},
			project: {
				select: {
					name: true,
					description: true,
					techStack: true,
					repositoryUrl: true,
					defaultBranch: true,
				},
			},
		},
	});

	if (!story) {
		throw new Error(
			`Story ${input.storyId} not found in project ${input.projectId}`,
		);
	}

	const focusedTask = input.storyTaskId
		? (story.tasks.find((task) => task.id === input.storyTaskId) ?? null)
		: null;
	const remainingTasks = focusedTask
		? story.tasks.filter((task) => task.id !== focusedTask.id)
		: story.tasks;

	const parts: string[] = [];

	parts.push("# Implementation Request");
	parts.push("");
	parts.push(`## Project: ${story.project.name}`);
	if (story.project.description) {
		parts.push(story.project.description);
	}
	if (story.project.techStack.length > 0) {
		parts.push(`\nTech stack: ${story.project.techStack.join(", ")}`);
	}

	parts.push("");
	parts.push(`## Feature: ${story.identifier} - ${story.title}`);
	if (story.description) {
		parts.push(story.description);
	}

	if (story.acceptanceCriteria) {
		parts.push("");
		parts.push("## Acceptance Criteria");
		parts.push(story.acceptanceCriteria);
	}

	parts.push("");
	parts.push("## Execution Context");
	parts.push(
		`Repository: ${input.repositoryOwner && input.repositoryName ? `${input.repositoryOwner}/${input.repositoryName}` : (story.project.repositoryUrl ?? "Repository not specified")}`,
	);
	parts.push(
		`Target branch: ${input.targetBranch ?? story.project.defaultBranch ?? "main"}`,
	);
	if (input.workingDirectory) {
		parts.push(`Working directory: ${input.workingDirectory}`);
		parts.push(
			"Launch local tools and code changes from this repository root when using Local Agents.",
		);
	}

	if (focusedTask) {
		parts.push("");
		parts.push("## Primary Task To Start With");
		parts.push(`- [ ] ${focusedTask.identifier}: ${focusedTask.title}`);
		if (focusedTask.description) {
			parts.push(`  ${focusedTask.description}`);
		}
	}

	if (remainingTasks.length > 0) {
		parts.push("");
		parts.push(
			focusedTask ? "## Remaining Open Tasks" : "## Tasks to Implement",
		);
		for (const task of remainingTasks) {
			parts.push(`- [ ] ${task.identifier}: ${task.title}`);
			if (task.description) {
				parts.push(`  ${task.description}`);
			}
		}
	}

	parts.push("");
	parts.push("## Instructions");
	parts.push(
		focusedTask
			? "Start with the primary task above, then continue through the remaining open tasks as needed to complete the feature."
			: "Implement the feature described above.",
	);
	parts.push(
		"Write clean, well-tested code following the project's existing patterns.",
	);
	parts.push(
		"Run relevant unit tests and type-checks to verify your implementation before committing.",
	);
	parts.push(
		`Stage and commit your changes on the current feature worktree branch, push the branch to origin, and open a GitHub Pull Request targeting \`${input.targetBranch ?? "main"}\` (for example using \`gh pr create --base ${input.targetBranch ?? "main"} --fill\` or \`gh pr create\`).`,
	);
	parts.push(
		"Include the opened Pull Request URL (`https://github.com/<owner>/<repo>/pull/<number>`) and a concise summary of what was implemented and validated in your final response.",
	);

	return parts.join("\n");
}

export async function sendExecutionPrompt(
	input: SendExecutionPromptInput,
): Promise<void> {
	// Read-only mode: a prompt drives more commits/PR updates on
	// the connected repository — same gate as createExecutionSession.
	await failIfProjectReadOnly(input.projectId);
	const provider = getCodingExecutionProvider(input.provider);
	if (input.provider !== "BACKGROUND_AGENTS") {
		await provider.sendPrompt(
			input.sessionId,
			input.content,
			input.authorId,
		);
		return;
	}
	// Activity identity is stable across retries, including worker restarts.
	const info = Context.current().info;
	if (!info.workflowExecution) {
		throw new Error("Prompt delivery requires a workflow identity");
	}
	const promptId = `${info.workflowExecution.workflowId}:${info.workflowExecution.runId}:${info.activityId}`;
	const run = await db.codingRun.findFirst({
		where: {
			OR: [
				{ workflowId: info.workflowExecution.workflowId },
				...(info.workflowExecution.workflowId.startsWith("coding-run-")
					? [
							{
								id: info.workflowExecution.workflowId.slice(
									"coding-run-".length,
								),
								workflowId: null,
							},
						]
					: []),
			],
			providerSessionId: input.sessionId,
			provider: input.provider,
			userId: input.authorId,
			...(input.projectId ? { projectId: input.projectId } : {}),
		},
		select: { id: true, projectId: true },
	});
	if (!run || !(await canEditProject(run.projectId, input.authorId))) {
		throw ApplicationFailure.nonRetryable(
			"Prompt has no authorized coding run",
			"INVALID_SESSION",
		);
	}
	const receipt = await provider.sendPrompt(
		input.sessionId,
		input.content,
		input.authorId,
		{ promptId },
	);
	if (receipt) {
		await db.codingRunEvent.upsert({
			where: { id: `prompt-receipt:${run.id}:${promptId}` },
			create: {
				id: `prompt-receipt:${run.id}:${promptId}`,
				codingRunId: run.id,
				eventType: "prompt_accepted",
				providerEventId: receipt.messageId,
				payloadJson: { promptId, messageId: receipt.messageId },
			},
			update: {},
		});
	}
}

export async function pollExecutionStatus(
	input: PollExecutionStatusInput,
): Promise<PollBackgroundAgentStatusOutput> {
	const provider = getCodingExecutionProvider(input.provider);
	const status = await provider.getSessionStatus(input.sessionId);

	const prArtifact = status.artifacts.find(
		(a) => a.type === "pull_request" && a.url,
	);

	const localRuntimeArtifact = status.artifacts.find(
		(a) => a.type === "local_runtime",
	);

	const hasPr = !!prArtifact;
	let fabricStatus = mapProviderStatusToFabric(status.status, hasPr);

	if (
		input.provider === "KANBAN_LOCAL" &&
		localRuntimeArtifact?.metadata &&
		typeof localRuntimeArtifact.metadata === "object"
	) {
		const sessionState =
			typeof localRuntimeArtifact.metadata.sessionState === "string"
				? localRuntimeArtifact.metadata.sessionState
				: null;
		if (sessionState === "awaiting_review") {
			fabricStatus = "AWAITING_REVIEW";
		}
	}

	return {
		providerStatus: status.status,
		fabricStatus,
		branchName: status.branchName,
		...(status.error ? { error: status.error } : {}),
		pullRequestUrl: prArtifact?.url ?? null,
		pullRequestArtifact: prArtifact?.url
			? { url: prArtifact.url, type: prArtifact.type }
			: null,
	};
}

export async function syncCodingRunArtifacts(
	input: SyncCodingRunArtifactsInput,
): Promise<SyncCodingRunArtifactsOutput> {
	const provider = getCodingExecutionProvider(input.provider);
	const status = await provider.getSessionStatus(input.sessionId);

	const prArtifact = status.artifacts.find(
		(a) => a.type === "pull_request" && a.url,
	);

	if (prArtifact?.url) {
		// Extract PR number from URL (e.g., https://github.com/owner/repo/pull/123)
		const prMatch = prArtifact.url.match(/\/pull\/(\d+)/);
		const pullRequestNumber = prMatch
			? Number.parseInt(prMatch[1], 10)
			: undefined;
		const existingRun = await db.codingRun.findUnique({
			where: { id: input.codingRunId },
			select: { status: true },
		});
		const nextStatus: CodingRunStatus =
			status.status === "paused" ||
			existingRun?.status === "AWAITING_REVIEW"
				? "AWAITING_REVIEW"
				: "PR_OPENED";
		await updateCodingRunStatus(input.codingRunId, nextStatus, {
			pullRequestUrl: prArtifact.url,
			pullRequestNumber,
			pullRequestBranch: status.branchName ?? undefined,
		});
		return {
			pullRequestUrl: prArtifact.url,
			pullRequestNumber,
			branchName: status.branchName,
		};
	}

	return {
		pullRequestUrl: null,
		branchName: status.branchName,
	};
}

export async function updateCodingRunStatusActivity(
	input: UpdateCodingRunStatusInput,
): Promise<void> {
	const codingRun = await updateCodingRunStatus(
		input.codingRunId,
		input.status,
		input.data,
	);

	if (input.status === "COMPLETED") {
		try {
			await dispatchLifecycleEvent({
				resource: "coding_run",
				event: "completed",
				projectId: codingRun.projectId,
				userId: codingRun.userId,
				organizationId: codingRun.organizationId ?? null,
				entityId: codingRun.id,
				data: {
					storyId: codingRun.storyId,
					storyTaskId: codingRun.storyTaskId,
					codingRunId: codingRun.id,
				},
			});
		} catch (error) {
			console.warn(
				"[LifecycleDispatcher] Coding run completed dispatch failed:",
				error,
			);
		}
	}
}

export async function addCodingRunEventActivity(
	input: AddCodingRunEventInput,
): Promise<void> {
	await addCodingRunEvent(
		input.codingRunId,
		input.eventType,
		input.payload,
		input.providerEventId,
	);
}

export async function cancelExecutionSession(
	input: CancelExecutionSessionInput,
): Promise<void> {
	const provider = getCodingExecutionProvider(input.provider);
	await provider.cancelSession(input.sessionId);
}
