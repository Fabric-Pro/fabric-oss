/**
 * Existing Project Setup Workflow
 *
 * Orchestrates the full setup flow for existing projects:
 *
 * Phase 1 (parallel):
 *   A: Run orchestrator code analysis on all repos → save + embed as RAG
 *   B: Ingest backlog items from PM tool → save + embed as RAG
 *
 * Phase 2 (sequential) — ONLY runs if ALL attempted Phase 1 tasks succeed:
 *   Generate documents in order (PRD → Proposal → Architecture → Tech Spec → API Spec).
 *   Each document is embedded for RAG before the next starts, so context grows sequentially.
 *
 * The project page receives updates via polling (codeAnalysisStatus + document statuses).
 *
 * Task Queue: "project-documents"
 */

import type { AiJobKey } from "@repo/ai";
import type { ProjectDocumentType } from "@repo/database";
import {
	ApplicationFailure,
	executeChild,
	log,
	ParentClosePolicy,
	patched,
	proxyActivities,
	startChild,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import {
	isSupersededGenerationFailure,
	liveRunIdOfGenerationFailure,
} from "../lib/proposal-artifact/failures";
import {
	PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
	PROJECT_EMBEDDING_TASK_QUEUE,
} from "../task-queues";
import { documentEvalWorkflow } from "./document-eval";
import { documentGenerationChildWorkflow } from "./document-generation-child";
import {
	type BulkRunInputExtras,
	claimBulkRunResume,
	pauseBulkRun,
} from "./lib/bulk-run-pause";
import {
	BULK_RUN_PAUSE_BEYOND_MS,
	BULK_RUN_PAUSE_PATCH,
	type ChatGptPlanPause,
	chatGptPlanPauseOf,
	planSpentFailureAsError,
	untilRunDeadline,
	withChatGptPlanWait,
} from "./lib/chatgpt-plan-wait";
import { orchestratorExecutionWorkflow } from "./orchestrator";

// Activities with bounded retry (max 5 attempts)
const {
	findMcpConfigsForRepos,
	updateProjectCodeAnalysisStatus,
	createAnalysisContextRecord,
	appendAnalysisContentChunk,
	updateProjectRagSettings,
	createExistingProjectDocumentRecords,
	logRepoContextAccessedActivity,
	createAgentTask,
	updateAgentTaskWorkflow,
	updateAgentTaskStatus,
	issueGenerationToken,
} = proxyActivities<typeof activities>({
	taskQueue: PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "5m",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

const { embedCodeAnalysisContext, ingestBacklogForRAG } = proxyActivities<
	typeof activities
>({
	taskQueue: PROJECT_EMBEDDING_TASK_QUEUE,
	startToCloseTimeout: "5m",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

// Asks whether every shared ChatGPT plan the run may use is spent, after the
// code analysis failed without saying why (Fizzy #2770).
const { assertSharedPlansNotSpentActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "1 minute",
	retry: { maximumAttempts: 3, initialInterval: "2s" },
});

/** Gates the shared-plan probe above on runs recorded after it existed. */
const SETUP_PLAN_PROBE_PATCH = "existing-setup-chatgpt-plan-probe-v1";

const ORCHESTRATOR_TIMEOUT_MS = 30 * 60_000;

const DOCUMENT_CHILD_TIMEOUT_MS = 20 * 60_000;

/**
 * Left after a ChatGPT plan wait: the analysis again, saving and embedding
 * it, and every document Phase 2 generates. The execution timeout cannot be
 * caught, so a wait that overran it would leave the project's analysis
 * status RUNNING.
 */
function analysisPlanWaitReserveMs(documentCount: number): number {
	return (
		ORCHESTRATOR_TIMEOUT_MS +
		10 * 60_000 +
		documentCount * DOCUMENT_CHILD_TIMEOUT_MS
	);
}

// Short activities for status updates (max 5 attempts)
const { updateProjectDocumentStatus } = proxyActivities<typeof activities>({
	taskQueue: PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "30s",
	retry: {
		initialInterval: "1s",
		maximumInterval: "10s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

// ============================================================================
// Input / Output
// ============================================================================

export interface ExistingProjectSetupInput extends BulkRunInputExtras {
	projectId: string;
	userId: string;
	organizationId?: string;
	aiToken: string;
	repoUrls: string[];
	selectedDocumentTypes: string[];
	projectTypes: string[];
	projectName: string;
	pmMcpConfigId?: string;
	pmContainerId?: string;
	pmAdditionalContext?: Record<string, string>;
	documentPrompts?: Record<
		string,
		{ promptId?: string; customInstructions?: string }
	>;
	/**
	 * The background job the run is (`project-setup` when a person starts
	 * it), stamped into the job-type header by the client interceptor so its
	 * AI steps run on the organization's shared plans (Fizzy #2770). The
	 * workflow itself never reads it.
	 */
	jobType?: AiJobKey;
}

export interface ExistingProjectSetupOutput {
	success: boolean;
	documentIds: string[];
	analysisContextId?: string;
	backlogContextId?: string;
	error?: string;
	/** Paused for a ChatGPT plan reset; a resume run starts at `resumesAt`. */
	paused?: boolean;
	resumesAt?: string;
}

/**
 * What a setup finished before it paused for a ChatGPT plan reset (Fizzy
 * #2770), so its resume redoes none of it. Ids only, never a credential.
 */
interface SetupPauseProgress {
	analysisDone?: boolean;
	analysisContextId?: string;
	backlogDone?: boolean;
	backlogContextId?: string;
	/** The document records, once Phase 2 created them. */
	documents?: Array<{ id: string; type: string }>;
	/** Documents generated. */
	documentIds?: string[];
	/** Documents that ended either way: never generated again. */
	finishedDocumentIds?: string[];
}

/** The `agentId` of the setup's run row (`PROJECT_SETUP_AGENT_ID`). */
const SETUP_RUN_AGENT_ID = "project_setup";

/** A resumed setup's agent token: the run's own lifetime, as at its start. */
const RESUME_TOKEN_EXPIRY_SECONDS = 7200;

// ============================================================================
// Prompt Builder (multi-repo)
// ============================================================================

function buildMultiRepoAnalysisPrompt(params: {
	repoUrls: string[];
	projectTypes: string[];
	projectName: string;
}): string {
	const repoList = params.repoUrls
		.map((url, i) => `${i + 1}. ${url}`)
		.join("\n");

	const typeContext =
		params.projectTypes.length > 0
			? `\nProject Type: ${params.projectTypes.join(", ")}`
			: "";

	return `Analyze ${params.repoUrls.length > 1 ? "these repositories" : "this repository"} and produce a concise project summary for documentation generation.

Project Name: ${params.projectName}${typeContext}

Repositories:
${repoList}

CRITICAL INSTRUCTIONS — READ CAREFULLY:
- Call search_tools ONCE at the start to discover available tools, then use them directly.
- Be EFFICIENT: use at most 5-8 tool calls total. Do NOT read files one by one.
- Work at the SUMMARY level: read the README, scan config/build files (package.json, *.csproj, pom.xml, etc.), and get the directory structure. That is enough.
- Do NOT dump raw source code. Summarize what you find in your own words.
- Do NOT exhaustively search every file. Get the big picture from a few strategic reads.
- If a tool returns a large result, extract the key facts and move on.

Provide your analysis in these sections:

## Project Overview
Product name, purpose, target users, current state${params.repoUrls.length > 1 ? ", how services relate" : ""}

## Tech Stack
Languages, frameworks, databases, infrastructure, key dependencies

## Architecture
System design, patterns (monolith/microservices/etc), directory layout, data flow

## Features & Capabilities
Main features organized by domain/module

## API Surface
Key endpoints/routes with methods and purpose. Include auth patterns if visible.

## Data Model
Database tables/collections, key relationships

## Integration Points
External services, third-party APIs, webhooks${params.repoUrls.length > 1 ? ", inter-service APIs" : ""}

## Quality & Patterns
Testing approach, error handling, logging, security patterns

Each section should contain concrete details from the codebase. If you cannot determine something, say so briefly and move on.`;
}

// ============================================================================
// Quality Validation
// ============================================================================

/** Placeholder phrases that indicate the agent couldn't extract real data */
const PLACEHOLDER_PATTERNS = [
	"unable to determine",
	"could not be determined",
	"not available",
	"no information available",
	"further investigation needed",
	"requires further analysis",
	"unknown at this time",
	"not enough information",
	"could not access",
	"failed to retrieve",
	"n/a",
];

/**
 * Validates the quality of a code analysis response.
 * Returns { passed, reason } — if not passed, Phase 2 should be skipped.
 */
function validateAnalysisQuality(content: string): {
	passed: boolean;
	reason?: string;
} {
	// Check minimum length (a useful analysis should be at least 500 chars)
	if (content.length < 500) {
		return {
			passed: false,
			reason: `Analysis too short (${content.length} chars). The agent likely failed to read the repository.`,
		};
	}

	// Count placeholder phrases
	const lowerContent = content.toLowerCase();
	let placeholderCount = 0;
	for (const pattern of PLACEHOLDER_PATTERNS) {
		const regex = new RegExp(pattern, "gi");
		const matches = lowerContent.match(regex);
		if (matches) {
			placeholderCount += matches.length;
		}
	}

	// Count expected sections that have actual content (case-insensitive to
	// tolerate minor formatting differences from the agent)
	const sectionPatterns = [
		"project overview",
		"tech stack",
		"architecture",
		"features",
		"api surface",
		"data model",
	];
	let emptySections = 0;
	for (let i = 0; i < sectionPatterns.length; i++) {
		const pattern = sectionPatterns[i];
		const sectionStart = lowerContent.indexOf(`## ${pattern}`);
		if (sectionStart === -1) {
			emptySections++;
			continue;
		}
		// Check content between this section and the next
		const nextPattern = sectionPatterns[i + 1];
		const sectionEnd = nextPattern
			? lowerContent.indexOf(`## ${nextPattern}`)
			: content.length;
		const sectionContent = content
			.slice(
				sectionStart + pattern.length + 3,
				sectionEnd > sectionStart ? sectionEnd : content.length,
			)
			.trim();
		// A section with less than 50 chars of content is effectively empty
		if (sectionContent.length < 50) {
			emptySections++;
		}
	}

	// If more than half the sections are empty/missing, quality is too low
	if (emptySections > sectionPatterns.length / 2) {
		return {
			passed: false,
			reason: `Analysis has ${emptySections}/${sectionPatterns.length} empty or missing sections. The agent failed to extract meaningful data.`,
		};
	}

	// If there are too many placeholder phrases relative to content
	// (more than 1 placeholder per 200 chars of content is suspicious)
	if (placeholderCount > 5 && placeholderCount > content.length / 200) {
		return {
			passed: false,
			reason: `Analysis contains ${placeholderCount} placeholder phrases indicating the agent couldn't access the codebase.`,
		};
	}

	return { passed: true };
}

// ============================================================================
// Workflow
// ============================================================================

/** Ordered document generation sequence */
const DOCUMENT_GENERATION_ORDER: ProjectDocumentType[] = [
	"BUSINESS_CASE",
	"DESIGN_SYSTEM",
	"PRD",
	"PROPOSAL",
	"ARCHITECTURE",
	"TECHNICAL_SPEC",
	"USER_STORY",
	"API_SPEC",
];

export async function existingProjectSetupWorkflow(
	input: ExistingProjectSetupInput,
): Promise<ExistingProjectSetupOutput> {
	const {
		projectId,
		userId,
		organizationId,
		repoUrls,
		selectedDocumentTypes,
		projectTypes,
		projectName,
		pmMcpConfigId,
		pmContainerId,
		pmAdditionalContext,
		documentPrompts,
	} = input;

	const { workflowId, runId } = workflowInfo();

	log.info("Existing project setup started", {
		projectId,
		repoUrls,
		selectedDocumentTypes,
		hasPmConfig: !!pmMcpConfigId,
		resumeOf: input.resumeOf?.runId,
	});

	// Pause and resume for a ChatGPT plan reset (Fizzy #2770). A setup with a
	// run row to record it on pauses when every shared plan is spent for long,
	// instead of failing, and a resume run continues from what it finished.
	let aiToken = input.aiToken;
	let setupRunId: string | undefined;
	let progress: SetupPauseProgress = {};
	// A resumed setup writes the project's analysis status only while it is
	// still this setup's: a setup started since owns it.
	const ownsAnalysis = input.resumeOf
		? { onlyIfWorkflowId: input.resumeOf.workflowIdBase }
		: {};

	try {
		if (input.resumeOf) {
			const claim = await claimBulkRunResume<SetupPauseProgress>(
				"PROJECT_SETUP",
				{ ...input, resumeOf: input.resumeOf },
			);
			if (!claim.claimed) {
				return { success: false, documentIds: [] };
			}
			setupRunId = input.resumeOf.runId;
			progress = claim.progress ?? {};
			// The run's own token expired during the wait.
			({ aiToken } = await issueGenerationToken({
				userId,
				organizationId,
				expirySeconds: RESUME_TOKEN_EXPIRY_SECONDS,
			}));
		} else if (patched(BULK_RUN_PAUSE_PATCH)) {
			// `patched()` is REQUIRED: the run row's activities are new
			// commands on a path recorded histories already took.
			try {
				const task = await createAgentTask({
					agentId: SETUP_RUN_AGENT_ID,
					userId,
					organizationId,
					status: "PENDING",
					stage: "initializing",
					input: {
						projectId,
						documentTypes: selectedDocumentTypes,
					},
					framework: "temporal",
				});
				await updateAgentTaskWorkflow({
					id: task.id,
					workflowId,
					runId,
				});
				await updateAgentTaskStatus({ id: task.id, status: "RUNNING" });
				setupRunId = task.id;
			} catch (error) {
				log.warn(
					"Failed to create the setup's run row; it cannot pause",
					{
						error:
							error instanceof Error
								? error.message
								: "Unknown error",
					},
				);
			}
		}
		const pausable = setupRunId !== undefined;

		if (!input.resumeOf) {
			// Step 1: Update status to SCANNING
			await updateProjectCodeAnalysisStatus({
				projectId,
				status: "SCANNING",
				workflowId,
			});

			// Step 2: Set optimal RAG settings
			await updateProjectRagSettings({
				projectId,
				topK: 50,
				rerankTopK: 20,
				enableReranking: true,
			});
		}

		// ================================================================
		// Phase 1: Parallel — Code Analysis + Backlog Ingest
		// Both tasks must succeed before Phase 2 starts.
		// ================================================================
		log.info("Phase 1: Starting parallel code analysis and backlog ingest");

		let analysisContextId = progress.analysisContextId;
		let backlogContextId = progress.backlogContextId;
		let analysisDone = progress.analysisDone === true;
		let backlogDone = progress.backlogDone === true;

		/**
		 * Saves what the setup finished and ends it until the plans reset.
		 * Throws `BulkRunPauseFailed` at the pause cap or when the run was
		 * cancelled meanwhile.
		 */
		const pauseSetup = async (
			pause: ChatGptPlanPause,
			saved: SetupPauseProgress,
			queuedDocumentIds?: string[],
		): Promise<ExistingProjectSetupOutput> => {
			const paused = await pauseBulkRun({
				kind: "PROJECT_SETUP",
				runId: setupRunId as string,
				// Never a credential on the saved input: the resume mints its own.
				input: { ...input, aiToken: "" },
				pause,
				progress: saved,
				...(queuedDocumentIds && { queuedDocumentIds }),
			});
			log.info("Project setup paused for a ChatGPT plan reset", {
				projectId,
				setupRunId,
				resumesAt: paused.resumesAt,
			});
			return {
				success: false,
				documentIds: saved.documentIds ?? [],
				analysisContextId,
				backlogContextId,
				paused: true,
				resumesAt: paused.resumesAt,
			};
		};

		const hasRepos = repoUrls.length > 0 && !analysisDone;
		const hasPmConfig = !!pmMcpConfigId && !!pmContainerId && !backlogDone;

		// Build parallel tasks — only include tasks that should run
		const phase1Tasks: Array<Promise<string | null>> = [];
		const phase1Labels: string[] = [];

		if (hasRepos) {
			phase1Labels.push("code-analysis");
			phase1Tasks.push(
				(async () => {
					log.info("Phase 1A: Running code analysis", {
						repoCount: repoUrls.length,
					});

					// Find MCP configs for all repos (checks project-level integrations first)
					const {
						allMcpConfigIds,
						mappings,
						usedProjectCredentials,
					} = await findMcpConfigsForRepos({
						repoUrls,
						userId,
						organizationId,
						projectId,
					});

					// Audit log: record that project-level credentials were used (once per workflow)
					if (usedProjectCredentials) {
						await logRepoContextAccessedActivity({
							projectId,
							userId,
							organizationId,
							repoUrls: mappings
								.filter((m) => m.projectIntegrationId)
								.map((m) => m.repoUrl),
						});
					}

					if (allMcpConfigIds.length === 0 && mappings.length === 0) {
						log.warn(
							"No MCP configs or project integrations found for any repos, skipping code analysis",
						);
						return null;
					}

					// Build analysis prompt
					const analysisPrompt = buildMultiRepoAnalysisPrompt({
						repoUrls: mappings.map((m) => m.repoUrl),
						projectTypes,
						projectName,
					});

					// Run orchestrator. Its agents run on the organization's
					// shared ChatGPT plans; when the analysis fails while every
					// one is spent, it waits for the reset and runs once more
					// (Fizzy #2770), within this run's own deadline.
					// An agent's failure does not say why, so the shared plans
					// are asked: spent, it fails with the plan's own error and
					// the wait fires. `patched()` is REQUIRED — the probe is a
					// new activity on a path histories already recorded.
					const failIfSharedPlansSpent = async () => {
						if (patched(SETUP_PLAN_PROBE_PATCH)) {
							await assertSharedPlansNotSpentActivity({
								userId,
								organizationId,
							});
						}
					};
					let analysisAttempts = 0;
					const runAnalysis = async () => {
						const attempt = analysisAttempts++;
						let result: Awaited<
							ReturnType<typeof orchestratorExecutionWorkflow>
						>;
						try {
							result = await executeChild(
								orchestratorExecutionWorkflow,
								{
									workflowId:
										attempt === 0
											? `${workflowId}-orchestrator`
											: `${workflowId}-orchestrator-after-plan-wait`,
									taskQueue: "fabric-orchestrator",
									args: [
										{
											executionId: `existing-setup-analysis-${projectId}-${Date.now()}`,
											message: analysisPrompt,
											history: [],
											userId,
											organizationId,
											executionMode: "balanced" as const,
											enabledMcpConfigIds:
												allMcpConfigIds,
										},
									],
									workflowExecutionTimeout:
										ORCHESTRATOR_TIMEOUT_MS,
								},
							);
						} catch (error) {
							await failIfSharedPlansSpent();
							throw error;
						}
						if (result.status !== "completed" || !result.response) {
							await failIfSharedPlansSpent();
							throw new Error(
								`Orchestrator failed: ${result.error || result.status}`,
							);
						}
						return result.response;
					};
					const rawAnalysisContent = await withChatGptPlanWait(
						runAnalysis,
						{
							organizationId,
							// A bulk run never uses the clicker's own plan, so
							// its reset cannot help.
							userId: null,
							maxWaitMs: untilRunDeadline(
								analysisPlanWaitReserveMs(
									selectedDocumentTypes.length,
								),
							),
							// A setup that may pause ends with the pause
							// instead of waiting long or failing.
							...(pausable && {
								pauseBeyondMs: BULK_RUN_PAUSE_BEYOND_MS,
							}),
						},
					).catch((error: unknown) => {
						// Name the plan rather than "Activity task failed".
						throw planSpentFailureAsError(error) ?? error;
					});

					log.info("Code analysis complete", {
						responseLength: rawAnalysisContent.length,
					});

					// Validate analysis quality before saving
					const qualityCheck =
						validateAnalysisQuality(rawAnalysisContent);
					if (!qualityCheck.passed) {
						log.error("Code analysis quality check failed", {
							reason: qualityCheck.reason,
							contentLength: rawAnalysisContent.length,
						});
						throw new Error(
							`Code analysis quality too low: ${qualityCheck.reason}`,
						);
					}
					log.info("Code analysis quality check passed");

					const analysisContent = rawAnalysisContent;

					// Extract repo info for context title
					const repoNames = repoUrls.map((url) => {
						const match = url.match(/\/([^/]+?)(?:\.git)?\/?$/);
						return match?.[1] ?? url;
					});

					// Step A: Create empty DB record (tiny payload — just metadata)
					const { contextId } = await createAnalysisContextRecord({
						projectId,
						userId,
						organizationId,
						repositoryOwner:
							repoNames.length > 1
								? "multi-repo"
								: (repoUrls[0]?.match(
										/[/:]([^/]+)\/[^/]+$/,
									)?.[1] ?? "unknown"),
						repositoryName: repoNames.join("+"),
						repoUrls,
					});

					// Step B: Append content in chunks, well under Temporal's 2MB limit.
					// Use 400K chars (~400KB ASCII, ~800KB worst-case UTF-8 with
					// multi-byte characters) to stay safe for non-ASCII content.
					const CHUNK_SIZE = 400_000;
					const totalChunks = Math.ceil(
						analysisContent.length / CHUNK_SIZE,
					);
					log.info("Saving analysis in chunks", {
						contentLength: analysisContent.length,
						totalChunks,
					});

					for (let i = 0; i < totalChunks; i++) {
						const chunk = analysisContent.slice(
							i * CHUNK_SIZE,
							(i + 1) * CHUNK_SIZE,
						);
						const isFinal = i === totalChunks - 1;
						await appendAnalysisContentChunk({
							contextId,
							chunk,
							isFinal,
						});
					}

					// Step C: Embed into Qdrant — reads full content from DB
					await embedCodeAnalysisContext({
						contextId,
						projectId,
						userId,
						organizationId,
					});

					log.info("Code analysis saved and embedded", { contextId });
					return contextId;
				})(),
			);
		}

		if (hasPmConfig) {
			phase1Labels.push("backlog-ingest");
			phase1Tasks.push(
				(async () => {
					log.info("Phase 1B: Ingesting backlog items for RAG");

					const result = await ingestBacklogForRAG({
						projectId,
						userId,
						organizationId,
						mcpConfigId: pmMcpConfigId,
						containerId: pmContainerId,
						additionalContext: pmAdditionalContext,
					});

					log.info("Backlog items ingested for RAG", {
						contextId: result.contextId,
						itemCounts: result.itemCounts,
					});

					return result.contextId;
				})(),
			);
		}

		// Run all Phase 1 tasks — use Promise.allSettled so we can report which failed
		if (phase1Tasks.length > 0) {
			const results = await Promise.allSettled(phase1Tasks);

			// Check for failures
			const failures: string[] = [];
			let phase1Pause: ChatGptPlanPause | null = null;
			for (let i = 0; i < results.length; i++) {
				const result = results[i];
				const label = phase1Labels[i];

				if (result.status === "fulfilled") {
					if (label === "code-analysis") {
						analysisDone = true;
					} else if (label === "backlog-ingest") {
						backlogDone = true;
					}
				}
				const phasePause =
					pausable && result.status === "rejected"
						? chatGptPlanPauseOf(result.reason)
						: null;
				if (phasePause) {
					// The analysis paused for a plan reset: not a failure.
					phase1Pause = phasePause;
				} else if (result.status === "fulfilled" && result.value) {
					if (label === "code-analysis") {
						analysisContextId = result.value;
					} else if (label === "backlog-ingest") {
						backlogContextId = result.value;
					}
				} else if (result.status === "rejected") {
					const errorMsg =
						result.reason instanceof Error
							? result.reason.message
							: String(result.reason);
					log.error(`Phase 1 task failed: ${label}`, {
						error: errorMsg,
					});
					failures.push(`${label}: ${errorMsg}`);
				}
			}

			// If ANY attempted Phase 1 task failed, abort before Phase 2
			if (failures.length > 0) {
				const errorMessage = `Phase 1 failed: ${failures.join("; ")}`;
				log.error(
					"Aborting workflow — Phase 1 had failures, will not proceed to document generation",
					{ failures },
				);

				await updateProjectCodeAnalysisStatus({
					projectId,
					status: "FAILED",
					...ownsAnalysis,
				});

				throw ApplicationFailure.nonRetryable(
					errorMessage,
					"EXISTING_PROJECT_SETUP_PHASE1_FAILED",
				);
			}

			// What finished (the backlog, typically) is kept; the resume
			// runs the analysis again.
			if (phase1Pause) {
				return await pauseSetup(phase1Pause, {
					analysisDone,
					analysisContextId,
					backlogDone,
					backlogContextId,
				});
			}
		}

		log.info("Phase 1 complete — all tasks succeeded", {
			hasCodeAnalysis: !!analysisContextId,
			hasBacklog: !!backlogContextId,
		});

		// ================================================================
		// Phase 2: Sequential Document Generation
		// ================================================================
		log.info("Phase 2: Starting sequential document generation", {
			selectedDocumentTypes,
		});

		// Order selected types according to the defined sequence
		const orderedTypes = DOCUMENT_GENERATION_ORDER.filter((type) =>
			selectedDocumentTypes.includes(type),
		);

		// Create all document records — once: a resume finds the paused
		// run's own.
		const documents =
			progress.documents ??
			(
				await createExistingProjectDocumentRecords({
					projectId,
					userId,
					organizationId,
					documentTypes: orderedTypes,
				})
			).documents.map((d) => ({ id: d.id, type: d.type }));

		log.info("Document records created", {
			count: documents.length,
			types: documents.map((d) => d.type),
		});

		// Generate documents sequentially
		const documentIds: string[] = [...(progress.documentIds ?? [])];
		const finishedDocumentIds: string[] = [
			...(progress.finishedDocumentIds ?? []),
		];
		// Set when a document's child paused for a plan reset: every
		// document from there on waits for the setup's resume.
		let pause: ChatGptPlanPause | null = null;
		const pendingDocs: typeof documents = [];

		for (const doc of documents) {
			if (finishedDocumentIds.includes(doc.id)) {
				continue;
			}
			if (pause) {
				pendingDocs.push(doc);
				continue;
			}
			log.info("Generating document", {
				documentId: doc.id,
				documentType: doc.type,
			});

			try {
				// Update status. It starts the document's attempt, as the batch
				// parent's does (Fizzy #2801): its identity scopes a coordinated
				// Proposal child's takeover, and a previous run's ownership ends.
				const attempt = await updateProjectDocumentStatus({
					documentId: doc.id,
					status: "GENERATING",
					progress: 5,
					startsAttempt: true,
				});

				// Execute child workflow — NO directContext, always use RAG
				// Each previous document is already embedded, so RAG context grows
				const docPrompt = documentPrompts?.[doc.type];
				const childResult = await executeChild(
					documentGenerationChildWorkflow,
					{
						workflowId: `${workflowId}-doc-${doc.id}`,
						args: [
							{
								projectId,
								documentId: doc.id,
								documentType: doc.type,
								userId,
								organizationId,
								aiToken,
								promptId: docPrompt?.promptId,
								prompt: docPrompt?.customInstructions,
								// Bulk work on the shared ChatGPT plans: a spent
								// plan waits for its reset, within this child's
								// own timeout (Fizzy #2770). Only the child's
								// input changes, which replay does not compare.
								waitForPlanReset: true,
								// A setup that may pause: a long wait ends the
								// child with the pause, and the setup saves its
								// place (Fizzy #2770).
								...(pausable && { pauseOnPlanSpent: true }),
								...(attempt?.generationStartedAt && {
									generationStartedAt:
										attempt.generationStartedAt,
								}),
								// No directContext — use RAG path
								// RAG retrieval finds code analysis + backlog + previously generated docs
							},
						],
						workflowExecutionTimeout: DOCUMENT_CHILD_TIMEOUT_MS,
					},
				);

				// If we reach here, child succeeded (child throws on failure)
				// Mark complete — under a coordinated Proposal child's run
				// token when it hands one back (Fizzy #2801), so a newer
				// generation that took the document over keeps its status.
				// Same replay argument as the batch parent.
				await updateProjectDocumentStatus({
					documentId: doc.id,
					status: "COMPLETE",
					progress: 100,
					...(childResult.liveRunId !== undefined && {
						liveRunId: childResult.liveRunId,
					}),
				});

				documentIds.push(doc.id);
				finishedDocumentIds.push(doc.id);

				log.info("Document generated successfully", {
					documentId: doc.id,
					documentType: doc.type,
					wordCount: childResult.metrics.wordCount,
				});

				// Fire-and-forget eval
				if (childResult.documentContent) {
					try {
						await startChild(documentEvalWorkflow, {
							workflowId: `${workflowId}-eval-${doc.id}`,
							parentClosePolicy:
								ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
							args: [
								{
									projectDocumentId: doc.id,
									documentContent:
										childResult.documentContent,
									documentVersion: 1,
									documentType:
										doc.type as ProjectDocumentType,
									userId,
									organizationId,
									threshold: 70,
								},
							],
						});
					} catch (evalError) {
						log.warn("Failed to start eval workflow (non-fatal)", {
							documentId: doc.id,
							error:
								evalError instanceof Error
									? evalError.message
									: "Unknown error",
						});
					}
				}
			} catch (docError) {
				// The child paused for a plan reset (Fizzy #2770): the
				// document waits for the setup's resume instead of failing.
				const childPause = pausable
					? chatGptPlanPauseOf(docError)
					: null;
				if (childPause) {
					pause = childPause;
					pendingDocs.push(doc);
					continue;
				}
				finishedDocumentIds.push(doc.id);
				const errorMessage =
					docError instanceof Error
						? docError.message
						: "Unknown error";

				log.error("Document generation threw exception", {
					documentId: doc.id,
					documentType: doc.type,
					error: errorMessage,
				});

				// A coordinated Proposal run that a newer generation
				// superseded (Fizzy #2801) leaves the document to that run:
				// this write has no guard and would stamp FAILED onto it.
				// Replay-safe without `patched()`: only a child of this
				// release ends with that type, so every recorded history
				// takes the write.
				if (isSupersededGenerationFailure(docError)) {
					log.info(
						"Document superseded by a newer generation; left to it",
						{ documentId: doc.id, documentType: doc.type },
					);
					continue;
				}

				try {
					// Guarded by a coordinated Proposal child's run token
					// when its failure carries one, as in the batch parent.
					const liveRunId = liveRunIdOfGenerationFailure(docError);
					await updateProjectDocumentStatus({
						documentId: doc.id,
						status: "FAILED",
						progress: 0,
						error: errorMessage,
						...(liveRunId !== undefined && { liveRunId }),
					});
				} catch {
					// Best effort
				}
			}
		}

		if (pause) {
			try {
				return await pauseSetup(
					pause,
					{
						analysisDone: true,
						analysisContextId,
						backlogDone: true,
						backlogContextId,
						documents,
						documentIds,
						finishedDocumentIds,
					},
					pendingDocs.map((doc) => doc.id),
				);
			} catch (error) {
				// The pause cap, or a run cancelled meanwhile: the documents
				// still waiting fail with the reason.
				const message =
					error instanceof Error ? error.message : "Unknown error";
				for (const doc of pendingDocs) {
					await updateProjectDocumentStatus({
						documentId: doc.id,
						status: "FAILED",
						progress: 0,
						error: message,
					});
					finishedDocumentIds.push(doc.id);
				}
			}
		}

		// Step final: Update project status
		const allFailed = documentIds.length === 0 && documents.length > 0;
		await updateProjectCodeAnalysisStatus({
			projectId,
			status: allFailed ? "FAILED" : "COMPLETED",
			...ownsAnalysis,
		});
		if (setupRunId) {
			await updateAgentTaskStatus({
				id: setupRunId,
				status: allFailed ? "FAILED" : "COMPLETED",
				result: {
					documentCount: documents.length,
					successCount: documentIds.length,
				},
				completedAt: new Date(),
			});
		}

		log.info("Existing project setup complete", {
			projectId,
			totalDocuments: documents.length,
			successCount: documentIds.length,
			failedCount: documents.length - documentIds.length,
		});

		return {
			success: documentIds.length > 0 || documents.length === 0,
			documentIds,
			analysisContextId,
			backlogContextId,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		log.error("Existing project setup failed", {
			projectId,
			error: errorMessage,
		});

		// Update status to FAILED
		try {
			await updateProjectCodeAnalysisStatus({
				projectId,
				status: "FAILED",
				...ownsAnalysis,
			});
		} catch {
			// Best effort
		}
		if (setupRunId) {
			await updateAgentTaskStatus({
				id: setupRunId,
				status: "FAILED",
				error: errorMessage,
				completedAt: new Date(),
			});
		}

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"EXISTING_PROJECT_SETUP_FAILED",
		);
	}
}
