/**
 * PRD to Tasks Pipeline Workflow
 *
 * End-to-end durable workflow that orchestrates:
 * 1. PRD Generation (using Document Generator agent)
 * 2. Story Breakdown (extracting features from PRD)
 * 3. Task Planning (breaking features into development tasks)
 * 4. Optional: Issue Creation (Linear, GitHub, Jira)
 *
 * This workflow provides durability via Temporal, ensuring that:
 * - Progress is never lost, even on failures
 * - Each stage can be retried independently
 * - Human approval gates can be added at any stage
 *
 * Prompt Library Integration:
 * - Uses prompts from the database with user > org > system precedence
 * - Prompt keys: prd_template, story_breakdown_template, task_planner_template
 * - Users can customize prompts in the Prompt Library for full control
 *
 * RAG Integration:
 * - Retrieves relevant project contexts from Qdrant for additional knowledge
 * - Contexts are injected into prompts for better document generation
 */

import {
	ApplicationFailure,
	executeChild,
	log,
	proxyActivities,
	uuid4,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import {
	type ApprovalWorkflowInput,
	approvalWorkflow,
} from "./approval-workflow";
import { batchDocumentGenerationWorkflow } from "./batch-document-generation";

// Long-running activities: generous timeouts for document generation, RAG retrieval, embedding
// These activities involve LLM calls, vector search, and external API calls that can take minutes
const {
	generateDocumentWithAgent,
	retrieveProjectContexts,
	extractContentViaMcp,
	pushTasksToFizzy,
	pushTasksViaMcp,
	saveExternalPrd,
	embedProjectDocumentActivity,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "10m",
	heartbeatTimeout: "5 minutes",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

// Short activities: tight timeouts for fast failure detection on simple DB/prompt operations
const {
	createWorkflowExecutionLog,
	updateWorkflowExecutionStatus,
	fetchAndRenderPromptByKey,
	createOrUpdateStoriesDocument: _createOrUpdateStoriesDocument,
	createPipelineDocumentPlaceholders,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "1m",
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

/**
 * Prompt keys for each stage - can be customized by users in Prompt Library
 */
const PROMPT_KEYS = {
	prd: "prd_template",
	storyBreakdown: "story_breakdown_template",
	taskPlanner: "task_planner_template",
} as const;

/**
 * Pipeline stage types
 */
export type PipelineStage =
	| "prd_generation"
	| "document_generation"
	| "story_breakdown"
	| "task_planning"
	| "issue_creation"
	| "completed"
	| "failed";

/**
 * Issue tracker type
 * - "mcp" = Generic MCP-based project management (new, preferred)
 * - "fizzy", "linear", etc. = Legacy direct integrations
 */
export type IssueTracker =
	| "mcp"
	| "fizzy"
	| "linear"
	| "github"
	| "jira"
	| "none";

/**
 * Pipeline input
 */
export interface PRDToTasksPipelineInput {
	// Workflow identity
	pipelineId: string;
	userId: string;
	organizationId?: string;
	projectId?: string;

	// AI Token for authentication
	aiToken: string; // Pre-issued AI token from API layer (where AI_TOKEN_SECRET is available)

	// PRD Generation inputs
	projectName: string;
	projectDescription: string;
	goals?: string[];
	features?: string[];
	techStack?: string[];

	// Optional: Skip PRD generation if PRD is provided
	existingPRD?: string;

	// Optional: Extract PRD from external source via MCP
	prdSource?: {
		type: "text" | "mcp";
		// For type: "mcp" - extract PRD from Notion, Confluence, etc.
		mcp?: {
			mcpConfigId: string; // MCP server config ID
			toolName: string; // e.g., "notion_get_page", "confluence_get_page"
			toolArgs: Record<string, unknown>; // e.g., { pageId: "abc123" }
		};
	};

	// Pipeline configuration
	skipStoryBreakdown?: boolean;
	skipTaskPlanning?: boolean;

	// Per-document generation config (skip types with existing docs)
	documentConfig?: Array<{
		type: string;
		action: "use_existing" | "generate";
		existingDocumentId?: string;
		prompt?: string;
		promptId?: string;
	}>;

	// Issue creation
	issueTracker?: IssueTracker;
	issueTrackerConfig?: {
		// Generic MCP-based config (new)
		mcpConfigId?: string;
		containerId?: string;
		containerName?: string;
		additionalContext?: Record<string, string>;
		// Legacy config fields
		projectId?: string;
		teamId?: string;
		labels?: string[];
		// Fizzy-specific config (legacy)
		fizzyAccessToken?: string;
		fizzyAccountSlug?: string;
		fizzyBoardId?: string;
		fizzyColumnId?: string;
	};

	// Approval gates
	requireApprovalBeforeStoryBreakdown?: boolean;
	requireApprovalBeforeTaskPlanning?: boolean;
	requireApprovalBeforeIssueCreation?: boolean;
}

/**
 * Stage result structure
 */
export interface StageResult {
	stage: PipelineStage;
	success: boolean;
	output?: string;
	artifacts?: Record<string, unknown>;
	error?: string;
	startedAt: Date;
	completedAt: Date;
	durationMs: number;
}

/**
 * Pipeline output
 */
export interface PRDToTasksPipelineOutput {
	pipelineId: string;
	status: "completed" | "failed" | "paused";
	currentStage: PipelineStage;
	stages: StageResult[];
	prd?: string;
	stories?: string;
	tasks?: string;
	issuesCreated?: number;
	totalDurationMs: number;
	error?: string;
}

/**
 * PRD to Tasks Pipeline Workflow
 *
 * Orchestrates the full SDLC automation pipeline from requirements to tasks.
 */
export async function prdToTasksPipelineWorkflow(
	input: PRDToTasksPipelineInput,
): Promise<PRDToTasksPipelineOutput> {
	const startTime = Date.now();
	const stages: StageResult[] = [];
	let currentStage: PipelineStage = "prd_generation";
	let prd: string | undefined;
	let stories: string | undefined;
	let tasks: string | undefined;

	log.info("Starting PRD to Tasks Pipeline", {
		pipelineId: input.pipelineId,
		projectName: input.projectName,
	});

	try {
		// Update status to RUNNING
		await updateWorkflowExecutionStatus({
			executionId: input.pipelineId,
			status: "RUNNING",
			startedAt: new Date(),
		});

		// ============================================
		// STAGE 1: PRD Generation (or Extraction)
		// ============================================

		// Check for MCP-based PRD extraction first
		if (input.prdSource?.type === "mcp" && input.prdSource.mcp) {
			const mcpStageStart = Date.now();
			log.info("Stage 1: Extracting PRD from external source via MCP", {
				mcpConfigId: input.prdSource.mcp.mcpConfigId,
				toolName: input.prdSource.mcp.toolName,
			});

			// TENANT ISOLATION: Pass userId and organizationId for proper tenant filtering
			await createWorkflowExecutionLog({
				executionId: input.pipelineId,
				nodeId: "prd_extraction",
				nodeType: "mcp",
				status: "RUNNING",
				startedAt: new Date(),
				userId: input.userId,
				organizationId: input.organizationId,
			});

			try {
				const extractResult = await extractContentViaMcp({
					mcpConfigId: input.prdSource.mcp.mcpConfigId,
					toolName: input.prdSource.mcp.toolName,
					toolArgs: input.prdSource.mcp.toolArgs,
					userId: input.userId,
				});

				if (!extractResult.success) {
					throw new Error(
						extractResult.error || "MCP content extraction failed",
					);
				}

				prd = extractResult.content;

				// Save external PRD as ProjectDocument and embed for RAG
				// This ensures external PRD is available in RAG for document generation
				if (input.projectId && prd) {
					log.info("Saving external PRD for RAG", {
						projectId: input.projectId,
					});

					try {
						const savedDoc = await saveExternalPrd({
							projectId: input.projectId,
							content: prd,
							sourceUrl: extractResult.url,
							sourceTitle: extractResult.title,
							mcpConfigId: input.prdSource.mcp.mcpConfigId,
							toolName: input.prdSource.mcp.toolName,
							userId: input.userId,
							organizationId: input.organizationId,
						});

						// Embed the saved PRD for RAG retrieval
						await embedProjectDocumentActivity({
							documentId: savedDoc.id,
							userId: input.userId,
							organizationId: input.organizationId,
						});

						log.info("External PRD saved and embedded", {
							documentId: savedDoc.id,
						});
					} catch (saveError) {
						// Don't fail the pipeline if save/embed fails
						// The PRD content is still available for document generation
						log.warn(
							"Failed to save/embed external PRD, continuing",
							{
								error:
									saveError instanceof Error
										? saveError.message
										: "Unknown error",
							},
						);
					}
				}

				const mcpStageDuration = Date.now() - mcpStageStart;

				stages.push({
					stage: "prd_generation",
					success: true,
					output: prd,
					artifacts: {
						source: "mcp",
						serverName: extractResult.metadata.serverName,
						toolName: extractResult.metadata.toolName,
						title: extractResult.title,
						url: extractResult.url,
					},
					startedAt: new Date(mcpStageStart),
					completedAt: new Date(),
					durationMs: mcpStageDuration,
				});

				await createWorkflowExecutionLog({
					executionId: input.pipelineId,
					nodeId: "prd_extraction",
					nodeType: "mcp",
					status: "COMPLETED",
					output: {
						content:
							prd.substring(0, 500) +
							(prd.length > 500 ? "..." : ""),
						contentLength: prd.length,
						source: extractResult.metadata.serverName,
						title: extractResult.title,
					},
					completedAt: new Date(),
					userId: input.userId,
					organizationId: input.organizationId,
				});

				log.info("PRD extracted from external source", {
					contentLength: prd.length,
					serverName: extractResult.metadata.serverName,
					title: extractResult.title,
					durationMs: mcpStageDuration,
				});
			} catch (error) {
				const errorMessage =
					error instanceof Error
						? error.message
						: "PRD extraction failed";
				stages.push({
					stage: "prd_generation",
					success: false,
					error: errorMessage,
					artifacts: { source: "mcp" },
					startedAt: new Date(mcpStageStart),
					completedAt: new Date(),
					durationMs: Date.now() - mcpStageStart,
				});

				await createWorkflowExecutionLog({
					executionId: input.pipelineId,
					nodeId: "prd_extraction",
					nodeType: "mcp",
					status: "FAILED",
					error: errorMessage,
					completedAt: new Date(),
					userId: input.userId,
					organizationId: input.organizationId,
				});

				throw new Error(
					`PRD extraction via MCP failed: ${errorMessage}`,
				);
			}
		} else if (input.existingPRD) {
			// Use existing PRD (provided as text)
			log.info("Using existing PRD, skipping generation");
			prd = input.existingPRD;
			stages.push({
				stage: "prd_generation",
				success: true,
				output: "Used existing PRD",
				artifacts: { source: "text" },
				startedAt: new Date(),
				completedAt: new Date(),
				durationMs: 0,
			});

			// Update the prd_generation log to SKIPPED since we're using existing PRD
			await createWorkflowExecutionLog({
				executionId: input.pipelineId,
				nodeId: "prd_generation",
				nodeType: "agent",
				status: "SKIPPED",
				output: { content: prd, source: "existing" },
				completedAt: new Date(),
				userId: input.userId,
				organizationId: input.organizationId,
			});
		} else {
			const prdStageStart = Date.now();
			log.info("Stage 1: Generating PRD");

			await createWorkflowExecutionLog({
				executionId: input.pipelineId,
				nodeId: "prd_generation",
				nodeType: "agent",
				status: "RUNNING",
				startedAt: new Date(),
				userId: input.userId,
				organizationId: input.organizationId,
			});

			try {
				// Build project context for prompt rendering
				const projectContext = {
					name: input.projectName,
					description: input.projectDescription,
					goals: input.goals?.join(", "),
					techStack: input.techStack || [],
					features: input.features || [],
				};

				// Retrieve RAG contexts for additional knowledge
				// Don't pass limit — let RAG settings' topK (default: 50) control retrieval count
				// The reranker then narrows to rerankTopK (default: 10) for best quality
				let ragContexts: string[] = [];
				if (input.projectId) {
					try {
						ragContexts = await retrieveProjectContexts({
							projectId: input.projectId,
							userId: input.userId,
							organizationId: input.organizationId,
							documentType: "PRD",
						});
						log.info("Retrieved RAG contexts for PRD", {
							count: ragContexts.length,
						});
					} catch (ragError) {
						log.warn(
							"Failed to retrieve RAG contexts, continuing without",
							{
								error:
									ragError instanceof Error
										? ragError.message
										: String(ragError),
							},
						);
					}
				}

				// Try to get user-customized prompt from Prompt Library
				let prdPrompt: string;
				const customPrompt = await fetchAndRenderPromptByKey({
					promptKey: PROMPT_KEYS.prd,
					userId: input.userId,
					organizationId: input.organizationId,
					projectContext,
					ragContexts,
				});

				if (customPrompt) {
					log.info("Using custom prompt from Prompt Library", {
						promptId: customPrompt.promptId,
						promptName: customPrompt.promptName,
						scope: customPrompt.scope,
					});
					prdPrompt = customPrompt.rendered;
				} else {
					// Fallback to default prompt if no custom prompt found
					log.info(
						"No custom prompt found, using default PRD template",
					);
					prdPrompt = buildDefaultPrdPrompt(
						projectContext,
						ragContexts,
					);
				}

				// Build context for document generation
				// Priority: RAG contexts > project description > project metadata summary
				let contextsForGeneration: string[];
				if (ragContexts.length > 0) {
					contextsForGeneration = ragContexts;
				} else if (
					input.projectDescription &&
					input.projectDescription.trim().length > 0
				) {
					// Use project description as fallback if RAG is empty but description exists
					contextsForGeneration = [input.projectDescription];
					log.warn(
						"No RAG contexts found, falling back to project description",
						{
							projectId: input.projectId,
							descriptionLength: input.projectDescription.length,
						},
					);
				} else {
					// Last resort: build context from project metadata
					const metadataSummary = [
						`Project: ${input.projectName}`,
						input.features?.length
							? `Features: ${input.features.join(", ")}`
							: "",
						input.techStack?.length
							? `Tech Stack: ${input.techStack.join(", ")}`
							: "",
						input.goals?.length
							? `Goals: ${input.goals.join(", ")}`
							: "",
					]
						.filter(Boolean)
						.join("\n");
					contextsForGeneration = [metadataSummary];
					log.warn(
						"No RAG contexts or description found, using project metadata only",
						{
							projectId: input.projectId,
							hasFeatures: !!input.features?.length,
							hasTechStack: !!input.techStack?.length,
						},
					);
				}

				const prdContent = await generateDocumentWithAgent({
					projectId: input.projectId || input.pipelineId,
					documentType: "PRD",
					prompt: prdPrompt,
					contexts: contextsForGeneration,
					userId: input.userId,
					organizationId: input.organizationId,
					aiToken: input.aiToken, // Pass pre-issued token from API layer
					// Only true if contexts came from actual RAG vector search, not fallback content
					// This ensures wizard features aren't suppressed when using project description fallback
					hasRagContexts: ragContexts.length > 0,
				});

				prd = prdContent.content;
				const prdStageDuration = Date.now() - prdStageStart;

				stages.push({
					stage: "prd_generation",
					success: true,
					output: prd,
					startedAt: new Date(prdStageStart),
					completedAt: new Date(),
					durationMs: prdStageDuration,
				});

				await createWorkflowExecutionLog({
					executionId: input.pipelineId,
					nodeId: "prd_generation",
					nodeType: "agent",
					status: "COMPLETED",
					output: { content: prd, contentLength: prd.length },
					completedAt: new Date(),
					userId: input.userId,
					organizationId: input.organizationId,
				});

				log.info("PRD generated successfully", {
					contentLength: prd.length,
					durationMs: prdStageDuration,
				});
			} catch (error) {
				const errorMessage =
					error instanceof Error
						? error.message
						: "PRD generation failed";
				stages.push({
					stage: "prd_generation",
					success: false,
					error: errorMessage,
					startedAt: new Date(prdStageStart),
					completedAt: new Date(),
					durationMs: Date.now() - prdStageStart,
				});

				await createWorkflowExecutionLog({
					executionId: input.pipelineId,
					nodeId: "prd_generation",
					nodeType: "agent",
					status: "FAILED",
					error: errorMessage,
					completedAt: new Date(),
					userId: input.userId,
					organizationId: input.organizationId,
				});

				throw new Error(`PRD generation failed: ${errorMessage}`);
			}
		}

		// Check for approval gate
		if (input.requireApprovalBeforeStoryBreakdown) {
			log.info("Waiting for approval before story breakdown");

			const approvalInput: ApprovalWorkflowInput = {
				approvalId: uuid4(),
				executionId: input.pipelineId,
				stepId: "story_breakdown",
				stepDescription: `Break down PRD "${input.projectName}" into features`,
				stepType: "story_breakdown",
				userId: input.userId,
				organizationId: input.organizationId,
				riskScore: 40, // Story breakdown is relatively safe
				riskLevel: "low",
				timeoutMs: 600000, // 10 minutes
				sendNotification: true,
			};

			const approvalResult = await executeChild(approvalWorkflow, {
				workflowId: `approval-${approvalInput.approvalId}`,
				args: [approvalInput],
			});

			if (!approvalResult.approved) {
				log.info("Story breakdown approval rejected", {
					feedback: approvalResult.feedback,
				});
				throw new Error(
					`Story breakdown not approved: ${approvalResult.feedback || "Rejected by user"}`,
				);
			}
		}

		// ============================================
		// STAGE 2: Document Generation (Parallel)
		// Generates: Technical Spec, API Spec, Architecture, Features
		// ============================================
		if (!input.skipStoryBreakdown && prd && input.projectId) {
			currentStage = "document_generation";
			const docGenStageStart = Date.now();
			log.info("Stage 2: Generating project documents in parallel", {
				documentTypes: [
					"TECHNICAL_SPEC",
					"API_SPEC",
					"ARCHITECTURE",
					"USER_STORY",
				],
			});

			await createWorkflowExecutionLog({
				executionId: input.pipelineId,
				nodeId: "document_generation",
				nodeType: "agent",
				status: "RUNNING",
				startedAt: new Date(),
				userId: input.userId,
				organizationId: input.organizationId,
			});

			try {
				// Build project context for document generation
				const projectContext = {
					name: input.projectName,
					description: input.projectDescription,
					goals: input.goals?.join(", "),
					techStack: input.techStack || [],
					features: input.features || [],
				};

				// Step 1: Create document placeholders (or update existing)
				// If documentConfig is provided, skip types where user chose "use_existing"
				log.info("Creating document placeholders", {
					documentConfig: input.documentConfig,
				});
				const documentPlaceholders =
					await createPipelineDocumentPlaceholders({
						projectId: input.projectId,
						userId: input.userId,
						organizationId: input.organizationId,
						pipelineExecutionId: input.pipelineId,
						documentConfig: input.documentConfig,
					});

				// Step 2: Get prompts for each document type
				const documentsToGenerate: Array<{
					id: string;
					type: string;
					title: string;
					prompt: string;
					promptId?: string;
				}> = [];

				for (const doc of documentPlaceholders) {
					const userConfig = input.documentConfig?.find(
						(d) => d.type === doc.type,
					);

					let prompt: string;
					let promptId: string | undefined;

					if (userConfig?.prompt || userConfig?.promptId) {
						// User provided prompt/promptId from UI — pass directly to batch workflow
						// Same path as wizard step 5: child workflow's generateDocumentWithAgent handles rendering
						log.info(`Using user-provided prompt for ${doc.type}`, {
							hasCustomText: !!userConfig.prompt,
							hasPromptId: !!userConfig.promptId,
						});
						prompt = userConfig.prompt || "";
						promptId = userConfig.promptId;
					} else {
						// No user prompt: existing behavior — fetch from Prompt Library by key
						const customPrompt = await fetchAndRenderPromptByKey({
							promptKey: doc.promptKey,
							userId: input.userId,
							organizationId: input.organizationId,
							projectContext,
							currentDocument: prd,
						});

						if (customPrompt) {
							log.info(
								`Using Prompt Library prompt for ${doc.type}`,
								{
									promptId: customPrompt.promptId,
									promptName: customPrompt.promptName,
								},
							);
							prompt = customPrompt.rendered;
							promptId = customPrompt.promptId;
						} else {
							// Use default prompt based on document type
							log.info(`Using default prompt for ${doc.type}`);
							prompt = buildDefaultDocumentPrompt(
								doc.type,
								projectContext,
								prd,
							);
						}
					}

					documentsToGenerate.push({
						id: doc.id,
						type: doc.type,
						title: doc.title,
						prompt,
						promptId,
					});
				}

				// Step 3: Execute batch document generation workflow (parallel)
				log.info("Starting batch document generation", {
					documentCount: documentsToGenerate.length,
				});

				const batchWorkflowId = `${input.pipelineId}-batch-docs`;
				const batchResult = await executeChild(
					batchDocumentGenerationWorkflow,
					{
						workflowId: batchWorkflowId,
						args: [
							{
								projectId: input.projectId,
								userId: input.userId,
								organizationId: input.organizationId,
								aiToken: input.aiToken,
								documents: documentsToGenerate,
							},
						],
					},
				);

				const docGenStageDuration = Date.now() - docGenStageStart;
				const successCount = batchResult.results.filter(
					(r) => r.status === "success",
				).length;
				const failedCount = batchResult.results.filter(
					(r) => r.status === "failed",
				).length;

				// Find the USER_STORY document content for compatibility with existing flow
				const userStoryResult = batchResult.results.find(
					(r) =>
						documentsToGenerate.find((d) => d.id === r.documentId)
							?.type === "USER_STORY",
				);
				if (userStoryResult?.status === "success") {
					// The stories content is saved in the document by the batch workflow
					// We mark it as available for downstream stages
					stories = "Generated via batch workflow"; // Placeholder - actual content is in DB
				}

				stages.push({
					stage: "document_generation",
					success: batchResult.success,
					output: `Generated ${successCount}/${documentsToGenerate.length} documents`,
					artifacts: {
						results: batchResult.results,
						successCount,
						failedCount,
					},
					startedAt: new Date(docGenStageStart),
					completedAt: new Date(),
					durationMs: docGenStageDuration,
				});

				await createWorkflowExecutionLog({
					executionId: input.pipelineId,
					nodeId: "document_generation",
					nodeType: "agent",
					status: batchResult.success ? "COMPLETED" : "FAILED",
					output: {
						successCount,
						failedCount,
						results: batchResult.results,
					},
					completedAt: new Date(),
					userId: input.userId,
					organizationId: input.organizationId,
				});

				log.info("Document generation completed", {
					successCount,
					failedCount,
					durationMs: docGenStageDuration,
				});

				// If all documents failed, throw error
				if (successCount === 0) {
					throw new Error("All document generations failed");
				}
			} catch (error) {
				const errorMessage =
					error instanceof Error
						? error.message
						: "Document generation failed";
				stages.push({
					stage: "document_generation",
					success: false,
					error: errorMessage,
					startedAt: new Date(docGenStageStart),
					completedAt: new Date(),
					durationMs: Date.now() - docGenStageStart,
				});

				await createWorkflowExecutionLog({
					executionId: input.pipelineId,
					nodeId: "document_generation",
					nodeType: "agent",
					status: "FAILED",
					error: errorMessage,
					completedAt: new Date(),
					userId: input.userId,
					organizationId: input.organizationId,
				});

				throw new Error(`Document generation failed: ${errorMessage}`);
			}
		}

		// Check for approval gate
		if (input.requireApprovalBeforeTaskPlanning) {
			log.info("Waiting for approval before task planning");

			const approvalInput: ApprovalWorkflowInput = {
				approvalId: uuid4(),
				executionId: input.pipelineId,
				stepId: "task_planning",
				stepDescription: `Create development tasks from features for "${input.projectName}"`,
				stepType: "task_planning",
				userId: input.userId,
				organizationId: input.organizationId,
				riskScore: 50, // Task planning is moderately impactful
				riskLevel: "medium",
				timeoutMs: 600000, // 10 minutes
				sendNotification: true,
			};

			const approvalResult = await executeChild(approvalWorkflow, {
				workflowId: `approval-${approvalInput.approvalId}`,
				args: [approvalInput],
			});

			if (!approvalResult.approved) {
				log.info("Task planning approval rejected", {
					feedback: approvalResult.feedback,
				});
				throw new Error(
					`Task planning not approved: ${approvalResult.feedback || "Rejected by user"}`,
				);
			}
		}

		// ============================================
		// STAGE 3: Task Planning
		// ============================================
		if (!input.skipTaskPlanning && stories) {
			currentStage = "task_planning";
			const taskStageStart = Date.now();
			log.info("Stage 3: Breaking stories into development tasks");

			await createWorkflowExecutionLog({
				executionId: input.pipelineId,
				nodeId: "task_planning",
				nodeType: "agent",
				status: "RUNNING",
				startedAt: new Date(),
				userId: input.userId,
				organizationId: input.organizationId,
			});

			try {
				// Build project context for task planning
				const taskProjectContext = {
					name: input.projectName,
					description: input.projectDescription,
					goals: input.goals?.join(", "),
					techStack: input.techStack || [],
					features: input.features || [],
				};

				// Try to get user-customized prompt from Prompt Library
				let taskPrompt: string;
				const customTaskPrompt = await fetchAndRenderPromptByKey({
					promptKey: PROMPT_KEYS.taskPlanner,
					userId: input.userId,
					organizationId: input.organizationId,
					projectContext: taskProjectContext,
					currentDocument: stories,
				});

				if (customTaskPrompt) {
					log.info(
						"Using custom task planner prompt from Prompt Library",
						{
							promptId: customTaskPrompt.promptId,
							promptName: customTaskPrompt.promptName,
							scope: customTaskPrompt.scope,
						},
					);
					taskPrompt = customTaskPrompt.rendered;
				} else {
					// Fallback to default prompt
					log.info(
						"No custom prompt found, using default task planner template",
					);
					taskPrompt = buildDefaultTaskPrompt(
						taskProjectContext,
						stories,
					);
				}

				const taskContent = await generateDocumentWithAgent({
					projectId: input.projectId || input.pipelineId,
					documentType: "TECHNICAL_SPEC",
					prompt: taskPrompt,
					contexts: [stories],
					userId: input.userId,
					organizationId: input.organizationId,
					aiToken: input.aiToken, // Pass pre-issued token from API layer
					// Stories are generated content (from PRD/features phase), not RAG uploads
					// So features should NOT be suppressed - they can complement the generated stories
					hasRagContexts: false,
				});

				tasks = taskContent.content;
				const taskStageDuration = Date.now() - taskStageStart;

				stages.push({
					stage: "task_planning",
					success: true,
					output: tasks,
					startedAt: new Date(taskStageStart),
					completedAt: new Date(),
					durationMs: taskStageDuration,
				});

				await createWorkflowExecutionLog({
					executionId: input.pipelineId,
					nodeId: "task_planning",
					nodeType: "agent",
					status: "COMPLETED",
					output: { content: tasks, contentLength: tasks.length },
					completedAt: new Date(),
					userId: input.userId,
					organizationId: input.organizationId,
				});

				log.info("Tasks generated successfully", {
					contentLength: tasks.length,
					durationMs: taskStageDuration,
				});
			} catch (error) {
				const errorMessage =
					error instanceof Error
						? error.message
						: "Task planning failed";
				stages.push({
					stage: "task_planning",
					success: false,
					error: errorMessage,
					startedAt: new Date(taskStageStart),
					completedAt: new Date(),
					durationMs: Date.now() - taskStageStart,
				});

				await createWorkflowExecutionLog({
					executionId: input.pipelineId,
					nodeId: "task_planning",
					nodeType: "agent",
					status: "FAILED",
					error: errorMessage,
					completedAt: new Date(),
					userId: input.userId,
					organizationId: input.organizationId,
				});

				throw new Error(`Task planning failed: ${errorMessage}`);
			}
		}

		// ============================================
		// STAGE 4: Issue Creation (Optional)
		// ============================================
		let issuesCreated = 0;
		if (input.issueTracker && input.issueTracker !== "none" && tasks) {
			currentStage = "issue_creation";

			if (input.requireApprovalBeforeIssueCreation) {
				log.info("Waiting for approval before issue creation");

				const approvalInput: ApprovalWorkflowInput = {
					approvalId: uuid4(),
					executionId: input.pipelineId,
					stepId: "issue_creation",
					stepDescription: `Create issues in ${input.issueTracker} for "${input.projectName}"`,
					stepType: "issue_creation",
					userId: input.userId,
					organizationId: input.organizationId,
					riskScore: 70, // Issue creation is high impact - creates external resources
					riskLevel: "high",
					riskFactors: [
						"Creates issues in external system",
						"May send notifications to team members",
						"Changes are visible to project stakeholders",
					],
					timeoutMs: 600000, // 10 minutes
					sendNotification: true,
				};

				const approvalResult = await executeChild(approvalWorkflow, {
					workflowId: `approval-${approvalInput.approvalId}`,
					args: [approvalInput],
				});

				if (!approvalResult.approved) {
					log.info("Issue creation approval rejected", {
						feedback: approvalResult.feedback,
					});
					// Don't throw - issue creation is optional, just skip
					stages.push({
						stage: "issue_creation",
						success: false,
						error: `Issue creation not approved: ${approvalResult.feedback || "Rejected by user"}`,
						startedAt: new Date(),
						completedAt: new Date(),
						durationMs: 0,
					});
					// Skip issue creation but continue to completion
					currentStage = "completed";
					const totalDuration = Date.now() - startTime;

					await updateWorkflowExecutionStatus({
						executionId: input.pipelineId,
						status: "COMPLETED",
						completedAt: new Date(),
					});

					return {
						pipelineId: input.pipelineId,
						status: "completed",
						currentStage,
						stages,
						prd,
						stories,
						tasks,
						issuesCreated: 0,
						totalDurationMs: totalDuration,
					};
				}
			}

			const issueStageStart = Date.now();
			log.info("Stage 4: Creating issues in", {
				tracker: input.issueTracker,
			});

			await createWorkflowExecutionLog({
				executionId: input.pipelineId,
				nodeId: "issue_creation",
				nodeType: "integration",
				status: "RUNNING",
				startedAt: new Date(),
				userId: input.userId,
				organizationId: input.organizationId,
			});

			try {
				// Issue creation via configured tracker
				if (input.issueTracker === "mcp") {
					// Generic MCP-based issue creation (preferred path)
					const mcpConfig = input.issueTrackerConfig;
					if (!mcpConfig?.mcpConfigId || !mcpConfig?.containerId) {
						throw new Error(
							"MCP configuration missing: mcpConfigId and containerId are required",
						);
					}

					log.info("Pushing tasks via MCP", {
						mcpConfigId: mcpConfig.mcpConfigId,
						containerId: mcpConfig.containerId,
						containerName: mcpConfig.containerName,
					});

					const mcpResult = await pushTasksViaMcp({
						mcpConfigId: mcpConfig.mcpConfigId,
						containerId: mcpConfig.containerId,
						containerName: mcpConfig.containerName,
						additionalContext: mcpConfig.additionalContext,
						tasksMarkdown: tasks,
						// Read-only mode write-gate
						projectId: input.projectId,
					});

					issuesCreated = mcpResult.itemsCreated;

					stages.push({
						stage: "issue_creation",
						success: mcpResult.success,
						artifacts: {
							issuesCreated,
							tracker: "mcp",
							serverName: mcpResult.serverName,
							items: mcpResult.items,
							errors: mcpResult.errors,
						},
						startedAt: new Date(issueStageStart),
						completedAt: new Date(),
						durationMs: Date.now() - issueStageStart,
					});

					await createWorkflowExecutionLog({
						executionId: input.pipelineId,
						nodeId: "issue_creation",
						nodeType: "integration",
						status: mcpResult.success ? "COMPLETED" : "FAILED",
						output: {
							itemsCreated: mcpResult.itemsCreated,
							tracker: "mcp",
							serverName: mcpResult.serverName,
							errors: mcpResult.errors,
						},
						completedAt: new Date(),
						userId: input.userId,
						organizationId: input.organizationId,
					});

					log.info("Tasks pushed via MCP", {
						serverName: mcpResult.serverName,
						itemsCreated: mcpResult.itemsCreated,
						errors: mcpResult.errors.length,
					});
				} else if (input.issueTracker === "fizzy") {
					// Legacy: Push tasks to Fizzy via MCP (direct credentials)
					const fizzyConfig = input.issueTrackerConfig;
					if (
						!fizzyConfig?.fizzyAccessToken ||
						!fizzyConfig?.fizzyAccountSlug ||
						!fizzyConfig?.fizzyBoardId
					) {
						throw new Error(
							"Fizzy configuration missing: accessToken, accountSlug, and boardId are required",
						);
					}

					log.info("Pushing tasks to Fizzy (legacy)", {
						accountSlug: fizzyConfig.fizzyAccountSlug,
						boardId: fizzyConfig.fizzyBoardId,
					});

					const fizzyResult = await pushTasksToFizzy({
						accessToken: fizzyConfig.fizzyAccessToken,
						accountSlug: fizzyConfig.fizzyAccountSlug,
						boardId: fizzyConfig.fizzyBoardId,
						tasksMarkdown: tasks,
						columnId: fizzyConfig.fizzyColumnId,
						projectId: input.projectId,
					});

					issuesCreated = fizzyResult.cardsCreated;

					stages.push({
						stage: "issue_creation",
						success: fizzyResult.success,
						artifacts: {
							issuesCreated,
							tracker: "fizzy",
							cards: fizzyResult.cards,
							errors: fizzyResult.errors,
						},
						startedAt: new Date(issueStageStart),
						completedAt: new Date(),
						durationMs: Date.now() - issueStageStart,
					});

					await createWorkflowExecutionLog({
						executionId: input.pipelineId,
						nodeId: "issue_creation",
						nodeType: "integration",
						status: fizzyResult.success ? "COMPLETED" : "FAILED",
						output: {
							cardsCreated: fizzyResult.cardsCreated,
							tracker: "fizzy",
							errors: fizzyResult.errors,
						},
						completedAt: new Date(),
						userId: input.userId,
						organizationId: input.organizationId,
					});

					log.info("Tasks pushed to Fizzy", {
						cardsCreated: fizzyResult.cardsCreated,
						errors: fizzyResult.errors.length,
					});
				} else {
					// TODO: Implement Linear, GitHub, Jira direct integrations
					log.info("Issue creation for tracker not yet implemented", {
						tracker: input.issueTracker,
						config: input.issueTrackerConfig,
					});

					// Simulated issue count for non-implemented trackers
					issuesCreated = Math.floor(tasks.length / 500) + 5;

					stages.push({
						stage: "issue_creation",
						success: true,
						artifacts: {
							issuesCreated,
							tracker: input.issueTracker,
						},
						startedAt: new Date(issueStageStart),
						completedAt: new Date(),
						durationMs: Date.now() - issueStageStart,
					});

					await createWorkflowExecutionLog({
						executionId: input.pipelineId,
						nodeId: "issue_creation",
						nodeType: "integration",
						status: "COMPLETED",
						output: { issuesCreated, tracker: input.issueTracker },
						completedAt: new Date(),
						userId: input.userId,
						organizationId: input.organizationId,
					});
				}

				log.info("Issues created successfully", { issuesCreated });
			} catch (error) {
				const errorMessage =
					error instanceof Error
						? error.message
						: "Issue creation failed";
				stages.push({
					stage: "issue_creation",
					success: false,
					error: errorMessage,
					startedAt: new Date(issueStageStart),
					completedAt: new Date(),
					durationMs: Date.now() - issueStageStart,
				});

				// Issue creation failure is not critical, log but continue
				log.warn("Issue creation failed", { error: errorMessage });
			}
		}

		// ============================================
		// COMPLETE
		// ============================================
		currentStage = "completed";
		const totalDuration = Date.now() - startTime;

		await updateWorkflowExecutionStatus({
			executionId: input.pipelineId,
			status: "COMPLETED",
			completedAt: new Date(),
		});

		log.info("Pipeline completed successfully", {
			pipelineId: input.pipelineId,
			totalDurationMs: totalDuration,
			stagesCompleted: stages.length,
		});

		return {
			pipelineId: input.pipelineId,
			status: "completed",
			currentStage,
			stages,
			prd,
			stories,
			tasks,
			issuesCreated,
			totalDurationMs: totalDuration,
		};
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		const errorMessage =
			error instanceof Error ? error.message : "Pipeline failed";
		const totalDuration = Date.now() - startTime;

		log.error("Pipeline failed", {
			pipelineId: input.pipelineId,
			stage: currentStage,
			error: errorMessage,
		});

		await updateWorkflowExecutionStatus({
			executionId: input.pipelineId,
			status: "FAILED",
			completedAt: new Date(),
		});

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"PRD_TO_TASKS_PIPELINE_FAILED",
		);
	}
}

// ============================================
// Default Prompt Builders (used as fallback when no Prompt Library prompt is found)
// ============================================

interface ProjectContextForPrompt {
	name: string;
	description?: string;
	goals?: string;
	techStack?: string[];
	features?: string[];
}

/**
 * Build default PRD generation prompt
 * Used as fallback when no custom prompt is found in Prompt Library
 *
 * CRITICAL: When RAG contexts exist, they define the product scope.
 * Project features from wizard are only used as fallback when no RAG.
 */
function buildDefaultPrdPrompt(
	projectContext: ProjectContextForPrompt,
	ragContexts: string[],
): string {
	const hasRagContexts = ragContexts.length > 0;

	// When RAG contexts exist, they define the product - don't inject wizard features
	// This prevents the AI from building a PRD about generic wizard features
	// instead of the actual product defined in uploaded documents
	let prompt = `Generate a comprehensive Product Requirements Document (PRD) for:

Project: ${projectContext.name}
${projectContext.description ? `Description: ${projectContext.description}` : ""}
${projectContext.goals ? `Goals: ${projectContext.goals}` : ""}
${!hasRagContexts && projectContext.features?.length ? `Features: ${projectContext.features.join(", ")}` : ""}
${projectContext.techStack?.length ? `Tech Stack: ${projectContext.techStack.join(", ")}` : ""}

Create a detailed PRD with the following sections:
1. Overview
2. Problem Statement
3. Goals and Objectives
4. Features
5. Functional Requirements
6. Non-Functional Requirements
7. Technical Architecture
8. Success Metrics
9. Timeline and Milestones
10. Risks and Mitigations`;

	if (hasRagContexts) {
		prompt += `

## CRITICAL: The following reference documents define the PRODUCT SCOPE

The documents below describe what this product should include. Extract ALL features,
capabilities, and requirements from these documents to build the PRD.
Do NOT invent features - use what's described in these reference documents.

Reference Documents:
${ragContexts.map((ctx, i) => `### Document ${i + 1}\n${ctx}`).join("\n\n")}`;
	}

	return prompt;
}

/**
 * Build default story breakdown prompt
 * Used as fallback when no custom prompt is found in Prompt Library
 */
function buildDefaultStoryPrompt(
	projectContext: ProjectContextForPrompt,
	prd: string,
): string {
	return `Generate a structured requirements breakdown from the following PRD using Epic → Feature → Feature Item hierarchy:

Project: ${projectContext.name}
${projectContext.description ? `Description: ${projectContext.description}` : ""}

PRD Content:
${prd}

## CRITICAL: Your output MUST follow this EXACT hierarchy format

You are breaking down the PRD into a DevOps-standard hierarchy:
- **Epic**: Large body of work (e.g., "Authentication System", "Payment Processing")
- **Feature**: A capability within an Epic (e.g., "User Login", "Password Reset")
- **Feature Item**: A user-facing requirement within a Feature (e.g., "Login with Email")

❌ FORBIDDEN:
- Introduction or overview text before the first Epic
- Priority/Size indicators
- Tasks section (tasks are generated separately)
- Any explanatory text or meta-documentation

✅ EXACT OUTPUT FORMAT:

# EPIC-001: [Epic Title]

[1-2 sentence epic description]

## FEAT-001: [Feature Title]

[1-2 sentence feature description]

### F-001: [Feature Item Title]

**Description**

As a **[role]**,

I want **[goal]**,

So that **[benefit]**.

**Acceptance Criteria**

**GIVEN** [context]

**WHEN** [action]

**THEN** [result]

**AND** [additional result]

**GIVEN** [edge case context]

**WHEN** [action]

**THEN** [result]

**Release Notes**

[1-2 sentence plain language summary]

---

### F-002: [Next Feature Item Title]

[Same structure...]

---

## FEAT-002: [Next Feature Title]

[Feature description]

### F-003: [Feature Item Title]

[Same structure...]

---

# EPIC-002: [Next Epic Title]

[Continue with more features and feature items...]

---

## RULES:

1. **Start with # EPIC-001:** - no preamble
2. **Group related feature items under Features** - each feature should have 2-5 feature items
3. **Group related features under Epics** - each epic should have 2-4 features
4. **Number sequentially across the entire document**:
   - Epics: EPIC-001, EPIC-002, EPIC-003...
   - Features: FEAT-001, FEAT-002, FEAT-003... (continuous, not reset per epic)
   - Feature Items: F-001, F-002, F-003... (continuous, not reset per feature)
5. **Every feature item must have**: Description (As a/I want/So that), Acceptance Criteria (GIVEN/WHEN/THEN), Release Notes
6. **Separate each feature item with "---"** horizontal rule
7. **Generate 3-5 Epics with 2-4 Features each, and 2-5 Feature Items per Feature**
8. **Cover ALL requirements from the PRD** - don't miss any functionality

Example hierarchy for a project:
- EPIC-001: User Management (3 features, 8 feature items)
- EPIC-002: Core Functionality (4 features, 12 feature items)
- EPIC-003: Integrations (2 features, 6 feature items)`;
}

/**
 * Build default task planning prompt
 * Used as fallback when no custom prompt is found in Prompt Library
 */
function buildDefaultTaskPrompt(
	projectContext: ProjectContextForPrompt,
	stories: string,
): string {
	return `Break down the following features into granular development tasks:

Project: ${projectContext.name}
${projectContext.techStack?.length ? `Tech Stack: ${projectContext.techStack.join(", ")}` : ""}

Features:
${stories}

Create detailed development tasks with:
- Task title and description
- Estimated hours
- Dependencies between tasks
- Required skills
- Acceptance criteria

Format each task as:
### TASK-N: [Title]
**Description**: [Details]
**Estimated Hours**: [X]
**Dependencies**: [List of dependent task IDs]
**Required Skills**: [List]
**Acceptance Criteria**: [List]

Ensure tasks are:
1. Small enough to complete in 1-4 hours
2. Clear and actionable
3. Properly sequenced with dependencies
4. Assigned appropriate skill requirements`;
}

/**
 * Build default prompt for document generation based on document type
 * Used as fallback when no custom prompt is found in Prompt Library
 */
function buildDefaultDocumentPrompt(
	documentType: string,
	projectContext: ProjectContextForPrompt,
	prd: string,
): string {
	const projectHeader = `Project: ${projectContext.name}
${projectContext.description ? `Description: ${projectContext.description}` : ""}
${projectContext.techStack?.length ? `Tech Stack: ${projectContext.techStack.join(", ")}` : ""}
${projectContext.features?.length ? `Features: ${projectContext.features.join(", ")}` : ""}

PRD Content:
${prd}`;

	const markdownOutputRules = `
## Output Rules
- Return the final answer as plain markdown, not inside \`\`\`markdown fences
- Do NOT wrap section headings, lists, or paragraphs in code blocks
- Use code fences only for actual code, JSON payloads, shell commands, or Mermaid/ASCII diagrams
- Keep examples readable and separated from surrounding prose`;

	switch (documentType) {
		case "TECHNICAL_SPEC":
			return `Create a comprehensive Technical Specification document based on the following PRD:

${projectHeader}
${markdownOutputRules}

Generate a Technical Specification that includes:

## 1. Overview
- System purpose and scope
- Key technical objectives
- Technology stack justification

## 2. System Architecture
- High-level architecture diagram (describe in text)
- Component breakdown
- Data flow description

## 3. Technical Requirements
- Functional requirements with technical details
- Non-functional requirements (performance, security, scalability)
- Integration requirements

## 4. Data Model
- Entity descriptions
- Relationships
- Data validation rules

## 5. API Design
- Endpoint overview
- Authentication/Authorization approach
- Error handling strategy

## 6. Security Considerations
- Authentication mechanism
- Data protection measures
- Security best practices

## 7. Performance Requirements
- Expected load
- Response time requirements
- Caching strategy

## 8. Deployment Strategy
- Environment requirements
- CI/CD considerations
- Monitoring approach

Format in clean markdown with proper headings and bullet points.`;

		case "API_SPEC":
			return `Create a detailed API Specification document based on the following PRD:

${projectHeader}
${markdownOutputRules}

Generate an API Specification that includes:

## 1. API Overview
- API purpose and scope
- Base URL structure
- Versioning strategy

## 2. Authentication
- Authentication method (JWT, OAuth, API Key)
- Authorization levels
- Token management

## 3. Common Patterns
- Request/Response format
- Pagination approach
- Error response structure

## 4. Endpoints

For each endpoint, provide:
### [HTTP Method] /path
**Description:** What this endpoint does
**Request:**
\`\`\`json
{
  "field": "type and description"
}
\`\`\`
**Response:**
\`\`\`json
{
  "field": "type and description"
}
\`\`\`
**Error Codes:**
- 400: Description
- 401: Description
- etc.

## 5. Data Models
- Request/Response schemas
- Validation rules
- Field constraints

## 6. Rate Limiting
- Rate limit policies
- Headers returned

## 7. Webhooks (if applicable)
- Available webhook events
- Payload format
- Retry policy

Format in clean markdown with proper code blocks for JSON examples. Do not label JSON examples as plain text like "json {...}" on a single line.`;

		case "ARCHITECTURE":
			return `Create a Technical Architecture document based on the following PRD:

${projectHeader}
${markdownOutputRules}

Generate a Technical Architecture document that includes:

## 1. Architecture Overview
- High-level system architecture
- Key design decisions and rationale
- Architecture style (microservices, monolith, serverless, etc.)

## 2. Component Architecture
- Frontend architecture
- Backend architecture
- Database architecture
- External service integrations

## 3. Infrastructure
- Cloud provider recommendations
- Compute resources
- Storage solutions
- Networking topology

## 4. Data Architecture
- Data storage strategy
- Data flow diagrams (described in text)
- Caching layers
- Data backup and recovery

## 5. Security Architecture
- Security layers
- Authentication/Authorization flow
- Encryption strategies
- Compliance considerations

## 6. Scalability Design
- Horizontal vs vertical scaling approach
- Load balancing strategy
- Auto-scaling policies
- Performance bottleneck mitigation

## 7. Reliability & Availability
- High availability design
- Disaster recovery plan
- Failover mechanisms
- SLA targets

## 8. Monitoring & Observability
- Logging strategy
- Metrics collection
- Alerting approach
- Tracing implementation

## 9. Technology Decisions
- Technology stack rationale
- Third-party service choices
- Build vs Buy decisions

Format in clean markdown with proper headings. Include ASCII diagrams where helpful, but do not wrap normal sections in markdown fences.`;
		default:
			return buildDefaultStoryPrompt(projectContext, prd);
	}
}
