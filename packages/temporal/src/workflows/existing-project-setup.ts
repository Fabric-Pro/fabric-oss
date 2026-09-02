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

import type { ProjectDocumentType } from "@repo/database";
import {
	ApplicationFailure,
	executeChild,
	log,
	ParentClosePolicy,
	proxyActivities,
	startChild,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import { documentEvalWorkflow } from "./document-eval";
import { documentGenerationChildWorkflow } from "./document-generation-child";
import { orchestratorExecutionWorkflow } from "./orchestrator";

// Activities with bounded retry (max 5 attempts)
const {
	findMcpConfigsForRepos,
	updateProjectCodeAnalysisStatus,
	createAnalysisContextRecord,
	appendAnalysisContentChunk,
	updateProjectRagSettings,
	embedCodeAnalysisContext,
	ingestBacklogForRAG,
	createExistingProjectDocumentRecords,
	logRepoContextAccessedActivity,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "5m",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

// Short activities for status updates (max 5 attempts)
const { updateProjectDocumentStatus } = proxyActivities<typeof activities>({
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

export interface ExistingProjectSetupInput {
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
}

export interface ExistingProjectSetupOutput {
	success: boolean;
	documentIds: string[];
	analysisContextId?: string;
	backlogContextId?: string;
	error?: string;
}

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
		aiToken,
		repoUrls,
		selectedDocumentTypes,
		projectTypes,
		projectName,
		pmMcpConfigId,
		pmContainerId,
		pmAdditionalContext,
		documentPrompts,
	} = input;

	const { workflowId } = workflowInfo();

	log.info("Existing project setup started", {
		projectId,
		repoUrls,
		selectedDocumentTypes,
		hasPmConfig: !!pmMcpConfigId,
	});

	try {
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

		// ================================================================
		// Phase 1: Parallel — Code Analysis + Backlog Ingest
		// Both tasks must succeed before Phase 2 starts.
		// ================================================================
		log.info("Phase 1: Starting parallel code analysis and backlog ingest");

		let analysisContextId: string | undefined;
		let backlogContextId: string | undefined;

		const hasRepos = repoUrls.length > 0;
		const hasPmConfig = !!pmMcpConfigId && !!pmContainerId;

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

					// Run orchestrator
					const orchestratorResult = await executeChild(
						orchestratorExecutionWorkflow,
						{
							workflowId: `${workflowId}-orchestrator`,
							taskQueue: "fabric-orchestrator",
							args: [
								{
									executionId: `existing-setup-analysis-${projectId}-${Date.now()}`,
									message: analysisPrompt,
									history: [],
									userId,
									organizationId,
									executionMode: "balanced" as const,
									enabledMcpConfigIds: allMcpConfigIds,
								},
							],
							workflowExecutionTimeout: "30m",
						},
					);

					if (
						orchestratorResult.status !== "completed" ||
						!orchestratorResult.response
					) {
						throw new Error(
							`Orchestrator failed: ${orchestratorResult.error || orchestratorResult.status}`,
						);
					}

					const rawAnalysisContent = orchestratorResult.response;
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
			for (let i = 0; i < results.length; i++) {
				const result = results[i];
				const label = phase1Labels[i];

				if (result.status === "fulfilled" && result.value) {
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
				});

				throw ApplicationFailure.nonRetryable(
					errorMessage,
					"EXISTING_PROJECT_SETUP_PHASE1_FAILED",
				);
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

		// Create all document records
		const { documents } = await createExistingProjectDocumentRecords({
			projectId,
			userId,
			organizationId,
			documentTypes: orderedTypes,
		});

		log.info("Document records created", {
			count: documents.length,
			types: documents.map((d) => d.type),
		});

		// Generate documents sequentially
		const documentIds: string[] = [];

		for (const doc of documents) {
			log.info("Generating document", {
				documentId: doc.id,
				documentType: doc.type,
			});

			try {
				// Update status
				await updateProjectDocumentStatus({
					documentId: doc.id,
					status: "GENERATING",
					progress: 5,
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
								// No directContext — use RAG path
								// RAG retrieval finds code analysis + backlog + previously generated docs
							},
						],
						workflowExecutionTimeout: "20m",
					},
				);

				// If we reach here, child succeeded (child throws on failure)
				// Mark complete
				await updateProjectDocumentStatus({
					documentId: doc.id,
					status: "COMPLETE",
					progress: 100,
				});

				documentIds.push(doc.id);

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
				const errorMessage =
					docError instanceof Error
						? docError.message
						: "Unknown error";

				log.error("Document generation threw exception", {
					documentId: doc.id,
					documentType: doc.type,
					error: errorMessage,
				});

				try {
					await updateProjectDocumentStatus({
						documentId: doc.id,
						status: "FAILED",
						progress: 0,
						error: errorMessage,
					});
				} catch {
					// Best effort
				}
			}
		}

		// Step final: Update project status
		const allFailed = documentIds.length === 0 && documents.length > 0;
		await updateProjectCodeAnalysisStatus({
			projectId,
			status: allFailed ? "FAILED" : "COMPLETED",
		});

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
			});
		} catch {
			// Best effort
		}

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"EXISTING_PROJECT_SETUP_FAILED",
		);
	}
}
