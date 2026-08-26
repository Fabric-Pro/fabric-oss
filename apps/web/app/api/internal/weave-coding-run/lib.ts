import { db } from "@repo/database";
import type {
	CodingRunExecutionChannel,
	CodingRunProvider,
} from "@repo/database/prisma/generated/client";
import { getTemporalClient } from "@repo/temporal";
import { getCodingExecutionProvider } from "@repo/temporal/coding-execution";
import type { CodingRunWorkflowOutput } from "@repo/temporal/workflows";

const ACTIVE_CODING_RUN_STATUSES = [
	"QUEUED",
	"STARTING",
	"RUNNING",
	"AWAITING_REVIEW",
	"PR_OPENED",
] as const;

export interface WeaveCodingRunRequest {
	planId: string;
	prompt: string;
	category: string;
	executionProvider?: "BACKGROUND_AGENTS" | "KANBAN_LOCAL";
	/** Category-based model override from ProjectWeaveConfig.categoryRouting */
	modelOverride?: string;
	userId: string;
	organizationId: string | null;
	weaveExecutionId?: string;
	timeoutMs?: number;
}

export interface WeaveCodingRunResponse {
	executionKind: "coding_run" | "direct_execution_session";
	executionChannel?: CodingRunExecutionChannel;
	provider?: CodingRunProvider;
	codingRunId?: string;
	workflowId?: string;
	providerSessionId?: string;
	externalUrl?: string;
	status: "completed" | "failed" | "cancelled" | "running";
	pullRequestUrl?: string;
	summary: string;
}

function tenantWhere(userId: string, organizationId: string | null) {
	return organizationId
		? { userId, organizationId }
		: { userId, organizationId: null };
}

function getProviderLabel(provider: CodingRunProvider): string {
	switch (provider) {
		case "KANBAN_LOCAL":
			return "Local development";
		default:
			return "Background Agents";
	}
}

function resolveExecutionPolicy(
	project: {
		repositoryOwner: string | null;
		repositoryName: string | null;
		implementationDefaultChannel: CodingRunExecutionChannel | null;
		implementationDefaultProvider: CodingRunProvider | null;
		implementationDefaultWorkingDirectory: string | null;
	},
	overrideProvider?: CodingRunProvider,
) {
	const provider: CodingRunProvider = (() => {
		if (overrideProvider) {
			return overrideProvider;
		}
		if (project.implementationDefaultProvider === "KANBAN_LOCAL") {
			return "KANBAN_LOCAL";
		}
		return "BACKGROUND_AGENTS";
	})();
	const executionChannel: CodingRunExecutionChannel =
		provider === "KANBAN_LOCAL" ? "LOCAL_AGENTS" : "BACKGROUND_AGENTS";
	const workingDirectory =
		project.implementationDefaultWorkingDirectory?.trim() || undefined;

	return {
		executionChannel,
		provider,
		workingDirectory,
	};
}

function buildInitialExternalStatus(
	provider: CodingRunProvider,
): string | null {
	switch (provider) {
		case "KANBAN_LOCAL":
			return "launching_local_runtime";
		default:
			return null;
	}
}

function buildInitialProviderMetadata(input: {
	provider: CodingRunProvider;
	workingDirectory?: string;
}) {
	if (input.provider === "BACKGROUND_AGENTS") {
		return undefined;
	}

	return {
		launchMode: "kanban_local",
		workingDirectory: input.workingDirectory ?? null,
	};
}

function buildPrompt(input: {
	basePrompt: string;
	category: string;
	projectName: string;
	storyIdentifier?: string | null;
	storyTitle?: string | null;
	storyDescription?: string | null;
	acceptanceCriteria?: string | null;
	taskIdentifier?: string | null;
	taskTitle?: string | null;
	taskDescription?: string | null;
}) {
	const lines = [
		"# Weave Shuttle Implementation Request",
		"",
		`Project: ${input.projectName}`,
		input.storyIdentifier && input.storyTitle
			? `Feature: ${input.storyIdentifier} - ${input.storyTitle}`
			: "Feature: Standalone weave plan",
		`Implementation category: ${input.category}`,
	];

	if (input.storyDescription) {
		lines.push("", "## Feature Description", input.storyDescription);
	}
	if (input.acceptanceCriteria) {
		lines.push("", "## Acceptance Criteria", input.acceptanceCriteria);
	}
	if (input.taskIdentifier || input.taskTitle) {
		lines.push("", "## Focused Task");
		lines.push(
			`${input.taskIdentifier || "Task"}${input.taskTitle ? ` - ${input.taskTitle}` : ""}`,
		);
		if (input.taskDescription) {
			lines.push(input.taskDescription);
		}
	}

	lines.push(
		"",
		"## Shuttle Step Request",
		input.basePrompt || "Implement the requested change.",
	);
	lines.push("", "## Execution Instructions");
	lines.push("Implement the requested code changes in the repository.");
	lines.push("Run relevant tests or checks when practical.");
	lines.push("Open or update a pull request if the provider supports it.");
	lines.push("Return a concise implementation summary.");

	return lines.join("\n");
}

function buildPromptWithModelOverride(
	basePromptText: string,
	modelOverride?: string,
): string {
	if (!modelOverride) {
		return basePromptText;
	}
	return `<!-- model-preference: ${modelOverride} -->\n${basePromptText}`;
}

async function waitForWorkflowResult(workflowId: string, timeoutMs: number) {
	const temporal = await getTemporalClient();
	const handle = temporal.workflow.getHandle(workflowId);
	const timeoutPromise = new Promise<null>((resolve) => {
		setTimeout(() => resolve(null), timeoutMs);
	});
	return Promise.race([
		handle.result() as Promise<CodingRunWorkflowOutput>,
		timeoutPromise,
	]);
}

async function startDirectExecutionSession(input: {
	executionChannel: CodingRunExecutionChannel;
	provider: CodingRunProvider;
	promptText: string;
	repositoryOwner: string;
	repositoryName: string;
	targetBranch: string;
	projectName: string;
	organizationName?: string;
	workingDirectory?: string;
	userId: string;
	timeoutMs: number;
	planLabel: string;
}): Promise<WeaveCodingRunResponse> {
	const provider = getCodingExecutionProvider(input.provider);
	const session = await provider.createSession({
		repoOwner: input.repositoryOwner,
		repoName: input.repositoryName,
		projectName: input.projectName,
		organizationName: input.organizationName,
		title: `Weave: ${input.planLabel}`,
		branch: input.targetBranch,
		userId: input.userId,
		workingDirectory: input.workingDirectory,
		promptText: input.promptText,
	});

	await provider.sendPrompt(
		session.sessionId,
		input.promptText,
		input.userId,
	);

	const startedAt = Date.now();
	const pollIntervalMs = 15000;
	const minRemainingTimeMs = 5000; // Minimum time needed for another iteration

	while (Date.now() - startedAt < input.timeoutMs) {
		// Check if we have enough time for another full iteration
		const remainingMs = input.timeoutMs - (Date.now() - startedAt);
		if (remainingMs < minRemainingTimeMs) {
			break;
		}

		const status = await provider.getSessionStatus(session.sessionId);
		const prArtifact = status.artifacts.find(
			(artifact) => artifact.type === "pull_request" && artifact.url,
		);

		if (
			status.status === "completed" ||
			(status.status === "active" && prArtifact?.url)
		) {
			return {
				executionKind: "direct_execution_session",
				executionChannel: input.executionChannel,
				provider: input.provider,
				providerSessionId: session.sessionId,
				externalUrl: session.externalUrl,
				status: "completed",
				pullRequestUrl: prArtifact?.url ?? undefined,
				summary: prArtifact?.url
					? `${getProviderLabel(input.provider)} session completed and opened PR: ${prArtifact.url}`
					: `${getProviderLabel(input.provider)} session ${session.sessionId} completed.`,
			};
		}

		if (status.status === "failed") {
			return {
				executionKind: "direct_execution_session",
				executionChannel: input.executionChannel,
				provider: input.provider,
				providerSessionId: session.sessionId,
				externalUrl: session.externalUrl,
				status: "failed",
				summary: `${getProviderLabel(input.provider)} session ${session.sessionId} failed.`,
			};
		}

		if (status.status === "stopped" || status.status === "archived") {
			return {
				executionKind: "direct_execution_session",
				executionChannel: input.executionChannel,
				provider: input.provider,
				providerSessionId: session.sessionId,
				externalUrl: session.externalUrl,
				status: "cancelled",
				summary: `${getProviderLabel(input.provider)} session ${session.sessionId} stopped before completion.`,
			};
		}

		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	return {
		executionKind: "direct_execution_session",
		executionChannel: input.executionChannel,
		provider: input.provider,
		providerSessionId: session.sessionId,
		externalUrl: session.externalUrl,
		status: "running",
		summary: `${getProviderLabel(input.provider)} session ${session.sessionId} is still running.`,
	};
}

export async function executeWeaveCodingRun(
	input: WeaveCodingRunRequest,
): Promise<WeaveCodingRunResponse> {
	const plan = await db.weavePlan.findFirst({
		where: {
			id: input.planId,
			...tenantWhere(input.userId, input.organizationId),
		},
		include: {
			project: {
				select: {
					id: true,
					name: true,
					organizationId: true,
					repositoryUrl: true,
					repositoryOwner: true,
					repositoryName: true,
					defaultBranch: true,
					implementationDefaultChannel: true,
					implementationDefaultProvider: true,
					implementationDefaultWorkingDirectory: true,
				},
			},
			userStory: {
				select: {
					id: true,
					identifier: true,
					title: true,
					description: true,
					acceptanceCriteria: true,
				},
			},
			storyTask: {
				select: {
					id: true,
					identifier: true,
					title: true,
					description: true,
				},
			},
		},
	});

	if (!plan) {
		throw new Error("Weave plan not found or access denied");
	}

	const linkedWeaveExecutionId =
		input.weaveExecutionId ??
		(
			await db.weaveExecution.findFirst({
				where: {
					planId: input.planId,
					...tenantWhere(input.userId, input.organizationId),
					status: {
						in: ["PENDING", "RUNNING", "PAUSED", "CHECKPOINT"],
					},
				},
				orderBy: { createdAt: "desc" },
				select: { id: true },
			})
		)?.id;

	if (!plan.project.repositoryOwner || !plan.project.repositoryName) {
		throw new Error(
			"Project must have a repository configured to run implementation sessions.",
		);
	}

	const organization = plan.project.organizationId
		? await db.organization.findUnique({
				where: { id: plan.project.organizationId },
				select: { name: true },
			})
		: null;

	const executionPolicy = resolveExecutionPolicy(
		plan.project,
		input.executionProvider,
	);
	const promptText = buildPromptWithModelOverride(
		buildPrompt({
			basePrompt: input.prompt,
			category: input.category,
			projectName: plan.project.name,
			storyIdentifier: plan.userStory?.identifier,
			storyTitle: plan.userStory?.title,
			storyDescription: plan.userStory?.description,
			acceptanceCriteria: plan.userStory?.acceptanceCriteria,
			taskIdentifier: plan.storyTask?.identifier,
			taskTitle: plan.storyTask?.title,
			taskDescription: plan.storyTask?.description,
		}),
		input.modelOverride,
	);

	if (
		executionPolicy.provider === "KANBAN_LOCAL" &&
		!executionPolicy.workingDirectory
	) {
		throw new Error(
			`${getProviderLabel(executionPolicy.provider)} require a default repository root on the project before Weave can launch implementation.`,
		);
	}

	if (!plan.userStory && executionPolicy.provider === "BACKGROUND_AGENTS") {
		throw new Error(
			"Background Agents currently require a feature-linked Weave plan. For standalone plans, use local development or attach the plan to a feature first.",
		);
	}

	if (!plan.userStory) {
		return startDirectExecutionSession({
			executionChannel: executionPolicy.executionChannel,
			provider: executionPolicy.provider,
			promptText,
			repositoryOwner: plan.project.repositoryOwner,
			repositoryName: plan.project.repositoryName,
			targetBranch: plan.project.defaultBranch ?? "main",
			projectName: plan.project.name,
			organizationName: organization?.name ?? undefined,
			workingDirectory: executionPolicy.workingDirectory,
			userId: input.userId,
			timeoutMs: input.timeoutMs ?? 10 * 60 * 1000,
			planLabel: plan.name,
		});
	}

	// Check for active runs using a transaction to prevent race conditions
	const existingActiveRun = await db.$transaction(async (tx) => {
		// plan.userStory is guaranteed to exist here (checked above), but TypeScript needs reassurance
		if (!plan.userStory) {
			return null;
		}

		// First, check for any active runs
		const activeRun = await tx.codingRun.findFirst({
			where: {
				storyId: plan.userStory.id,
				status: { in: [...ACTIVE_CODING_RUN_STATUSES] },
				...tenantWhere(input.userId, input.organizationId),
			},
			orderBy: { createdAt: "desc" },
		});

		if (activeRun) {
			return activeRun;
		}

		// No active run found - return null to indicate we should create one
		return null;
	});

	if (existingActiveRun) {
		if (
			linkedWeaveExecutionId &&
			existingActiveRun.weaveExecutionId !== linkedWeaveExecutionId
		) {
			await db.codingRun.update({
				where: { id: existingActiveRun.id },
				data: { weaveExecutionId: linkedWeaveExecutionId },
			});
		}
		return {
			executionKind: "coding_run",
			executionChannel: existingActiveRun.executionChannel,
			provider: existingActiveRun.provider,
			codingRunId: existingActiveRun.id,
			workflowId:
				existingActiveRun.workflowId ||
				`coding-run-${existingActiveRun.id}`,
			status: "running",
			pullRequestUrl: existingActiveRun.pullRequestUrl || undefined,
			externalUrl: existingActiveRun.externalUrl || undefined,
			summary: `An implementation session is already active for ${plan.userStory.identifier}. Reusing run ${existingActiveRun.id}.`,
		};
	}

	const codingRun = await db.codingRun.create({
		data: {
			projectId: plan.project.id,
			storyId: plan.userStory.id,
			storyTaskId: plan.storyTask?.id,
			userId: input.userId,
			organizationId: input.organizationId ?? undefined,
			weaveExecutionId: linkedWeaveExecutionId,
			executionChannel: executionPolicy.executionChannel,
			provider: executionPolicy.provider,
			repositoryUrl: plan.project.repositoryUrl,
			repositoryOwner: plan.project.repositoryOwner,
			repositoryName: plan.project.repositoryName,
			targetBranch: plan.project.defaultBranch ?? "main",
			workingDirectory: executionPolicy.workingDirectory,
			externalStatus: buildInitialExternalStatus(
				executionPolicy.provider,
			),
			providerMetadata: buildInitialProviderMetadata({
				provider: executionPolicy.provider,
				workingDirectory: executionPolicy.workingDirectory,
			}),
			promptText,
			status: "QUEUED",
		},
	});

	const workflowId = `coding-run-${codingRun.id}`;
	const temporal = await getTemporalClient();
	await temporal.workflow.start("codingRunWorkflow", {
		taskQueue: "agents",
		workflowId,
		args: [
			{
				codingRunId: codingRun.id,
				projectId: plan.project.id,
				storyId: plan.userStory.id,
				storyTaskId: plan.storyTask?.id,
				userId: input.userId,
				organizationId: input.organizationId ?? undefined,
				provider: executionPolicy.provider,
				projectName: plan.project.name,
				organizationName: organization?.name ?? undefined,
				repositoryOwner: plan.project.repositoryOwner,
				repositoryName: plan.project.repositoryName,
				targetBranch: plan.project.defaultBranch ?? "main",
				workingDirectory: executionPolicy.workingDirectory,
				storyTitle: `${plan.userStory.identifier} - ${plan.userStory.title}`,
			},
		],
	});

	await db.codingRun.update({
		where: { id: codingRun.id },
		data: { workflowId },
	});
	const workflowResult = await waitForWorkflowResult(
		workflowId,
		input.timeoutMs ?? 10 * 60 * 1000,
	);
	const refreshedRun = await db.codingRun.findUnique({
		where: { id: codingRun.id },
	});

	if (!workflowResult) {
		return {
			executionKind: "coding_run",
			executionChannel: executionPolicy.executionChannel,
			provider: executionPolicy.provider,
			codingRunId: codingRun.id,
			workflowId,
			status: "running",
			pullRequestUrl: refreshedRun?.pullRequestUrl || undefined,
			externalUrl: refreshedRun?.externalUrl || undefined,
			summary: `${getProviderLabel(executionPolicy.provider)} implementation session ${codingRun.id} started for ${plan.userStory.identifier} and is still running.`,
		};
	}

	if (workflowResult.status === "completed") {
		return {
			executionKind: "coding_run",
			executionChannel: executionPolicy.executionChannel,
			provider: executionPolicy.provider,
			codingRunId: codingRun.id,
			workflowId,
			status: "completed",
			pullRequestUrl: workflowResult.pullRequestUrl,
			externalUrl: refreshedRun?.externalUrl || undefined,
			summary: workflowResult.pullRequestUrl
				? `${getProviderLabel(executionPolicy.provider)} implementation session completed and opened PR: ${workflowResult.pullRequestUrl}`
				: `${getProviderLabel(executionPolicy.provider)} implementation session completed for ${plan.userStory.identifier}.`,
		};
	}

	if (workflowResult.status === "cancelled") {
		return {
			executionKind: "coding_run",
			executionChannel: executionPolicy.executionChannel,
			provider: executionPolicy.provider,
			codingRunId: codingRun.id,
			workflowId,
			status: "cancelled",
			externalUrl: refreshedRun?.externalUrl || undefined,
			summary:
				workflowResult.error ||
				`${getProviderLabel(executionPolicy.provider)} implementation session ${codingRun.id} was cancelled.`,
		};
	}

	return {
		executionKind: "coding_run",
		executionChannel: executionPolicy.executionChannel,
		provider: executionPolicy.provider,
		codingRunId: codingRun.id,
		workflowId,
		status: "failed",
		pullRequestUrl: workflowResult.pullRequestUrl,
		externalUrl: refreshedRun?.externalUrl || undefined,
		summary:
			workflowResult.error ||
			`${getProviderLabel(executionPolicy.provider)} implementation session ${codingRun.id} failed.`,
	};
}
