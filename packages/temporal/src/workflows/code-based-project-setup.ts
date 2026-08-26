/**
 * Code-Based Project Setup Workflow
 *
 * Orchestrates the code-based project setup flow:
 * 1. Find repository credentials (GitHub MCP config or GitLab OAuth integration)
 * 2. Update project status to SCANNING
 * 3. Run orchestrator to analyze the repository
 * 4. Save analysis as project context
 * 5. Create 4 document records (PRD, Architecture, Tech Spec, API Spec)
 * 6. Generate all 4 documents in parallel using directContext
 * 7. Update project status to COMPLETED
 *
 * Supports both GitHub (via MCP) and GitLab (via OAuth) repositories.
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

// Activities with standard retry
const {
	findGitHubMcpConfig,
	findGitLabOAuthConfig,
	updateProjectCodeAnalysisStatus,
	saveCodeAnalysisContext,
	createCodeBasedDocumentRecords,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "2m",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

// ============================================================================
// Input / Output
// ============================================================================

export interface CodeBasedProjectSetupInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	aiToken: string;
	/** Repository owner (e.g., "facebook" or "my-group/subgroup") */
	repositoryOwner: string;
	/** Repository name (e.g., "react") */
	repositoryName: string;
	/** Default branch (e.g., "main") */
	defaultBranch?: string;
	/** Project types selected in wizard (e.g., ["web", "saas"]) */
	projectTypes: string[];
	/** Project name from wizard */
	projectName: string;
	/** Repository provider — defaults to "github" for backward compatibility */
	repositoryProvider?: "github" | "gitlab";
	/** Full repository URL (e.g., "https://gitlab.com/group/project") — used for context source detection */
	repositoryUrl?: string;
}

export interface CodeBasedProjectSetupOutput {
	success: boolean;
	documentIds: string[];
	analysisContextId?: string;
	error?: string;
}

// ============================================================================
// Dynamic Prompt Builder
// ============================================================================

function buildCodeAnalysisPrompt(params: {
	owner: string;
	repo: string;
	defaultBranch: string;
	projectTypes: string[];
	projectName: string;
	provider: "github" | "gitlab";
}): string {
	const typeContext = buildTypeContext(params.projectTypes);
	const extraScans = getExtraScansForTypes(params.projectTypes);
	const providerName = params.provider === "gitlab" ? "GitLab" : "GitHub";

	return `You are analyzing a ${providerName} repository to help generate project documentation.
Repository: ${params.owner}/${params.repo} (branch: ${params.defaultBranch})
Project Name: ${params.projectName}
Project Type: ${params.projectTypes.join(", ")}

Using the ${providerName} tools available to you, thoroughly scan this repository and provide a comprehensive PRODUCT-FOCUSED analysis. Your analysis will be used to generate these documents: PRD, Technical Architecture, Technical Specification, and API Specification.
${typeContext}

Scan Strategy:
1. Read the README and any documentation files
2. Examine package.json / requirements.txt / build files for tech stack
3. Browse the directory structure to understand architecture
4. Read key source files (entry points, routers, models, configs)
5. Look for API definitions (routes, controllers, OpenAPI specs)
6. Check for database schemas, migrations
7. Look for test files to understand feature coverage
${extraScans}

Provide your analysis in these sections:

## Project Overview
Product name, purpose, target users, current state

## Tech Stack
Languages, frameworks, databases, infrastructure, key dependencies

## Architecture
System design, key patterns (monolith/microservices/etc), directory structure, data flow

## Features & Capabilities
All features the codebase implements, organized by domain/module

## API Surface
All endpoints/routes with methods, paths, purpose. Include auth patterns.

## Data Model
Database tables/collections, key relationships, schemas

## Integration Points
External services, third-party APIs, webhooks

## Quality & Patterns
Testing approach, error handling, logging, security patterns

Be thorough but focused on PRODUCT value. This analysis drives document generation.`;
}

function buildTypeContext(types: string[]): string {
	const contexts: string[] = [];
	if (types.includes("web")) {
		contexts.push(
			"This is a web application - focus on frontend architecture, routing, state management, and UI patterns.",
		);
	}
	if (types.includes("mobile")) {
		contexts.push(
			"This is a mobile application - focus on mobile architecture, navigation patterns, offline capabilities, and platform-specific code.",
		);
	}
	if (types.includes("api")) {
		contexts.push(
			"This is an API service - focus heavily on endpoint documentation, request/response schemas, authentication, and rate limiting.",
		);
	}
	if (types.includes("saas")) {
		contexts.push(
			"This is a SaaS product - focus on multi-tenancy, subscription/billing, user management, and tenant isolation.",
		);
	}
	if (types.includes("ecommerce")) {
		contexts.push(
			"This is an e-commerce platform - focus on product catalog, cart/checkout, payment processing, and order management.",
		);
	}
	return contexts.length > 0
		? `\nProject Type Context:\n${contexts.join("\n")}`
		: "";
}

function getExtraScansForTypes(types: string[]): string {
	const extras: string[] = [];
	if (types.includes("mobile")) {
		extras.push(
			"8. Check for mobile-specific configs (Android manifest, iOS plist, React Native/Flutter configs)",
		);
	}
	if (types.includes("ecommerce")) {
		extras.push(
			"8. Look for payment integration, product models, cart/checkout flows",
		);
	}
	if (types.includes("saas")) {
		extras.push(
			"8. Check for multi-tenant patterns, subscription models, billing integration",
		);
	}
	return extras.length > 0 ? `${extras.join("\n")}\n` : "";
}

// ============================================================================
// Workflow
// ============================================================================

export async function codeBasedProjectSetupWorkflow(
	input: CodeBasedProjectSetupInput,
): Promise<CodeBasedProjectSetupOutput> {
	const {
		projectId,
		userId,
		organizationId,
		aiToken,
		repositoryOwner,
		repositoryName,
		defaultBranch = "main",
		projectTypes,
		projectName,
		repositoryProvider = "github",
		repositoryUrl,
	} = input;

	const { workflowId } = workflowInfo();
	const providerName = repositoryProvider === "gitlab" ? "GitLab" : "GitHub";

	log.info("Code-based project setup started", {
		projectId,
		repo: `${repositoryOwner}/${repositoryName}`,
		projectTypes,
		repositoryProvider,
	});

	try {
		// Step 1: Find MCP config / OAuth integration for the repository provider
		log.info(`Step 1: Finding ${providerName} config`);
		let mcpConfigId: string;
		if (repositoryProvider === "gitlab") {
			const result = await findGitLabOAuthConfig({
				userId,
				organizationId,
			});
			mcpConfigId = result.oauthConfigId;
		} else {
			const result = await findGitHubMcpConfig({
				userId,
				organizationId,
			});
			mcpConfigId = result.mcpConfigId;
		}
		log.info(`${providerName} config found`, { mcpConfigId });

		// Step 2: Update status to SCANNING
		log.info("Step 2: Updating project status to SCANNING");
		await updateProjectCodeAnalysisStatus({
			projectId,
			status: "SCANNING",
			workflowId,
		});

		// Step 3: Run orchestrator to analyze the codebase
		log.info("Step 3: Running orchestrator for code analysis", {
			repo: `${repositoryOwner}/${repositoryName}`,
			branch: defaultBranch,
		});

		const analysisPrompt = buildCodeAnalysisPrompt({
			owner: repositoryOwner,
			repo: repositoryName,
			defaultBranch,
			projectTypes,
			projectName,
			provider: repositoryProvider,
		});

		const orchestratorResult = await executeChild(
			orchestratorExecutionWorkflow,
			{
				workflowId: `${workflowId}-orchestrator`,
				taskQueue: "fabric-orchestrator",
				args: [
					{
						executionId: `code-analysis-${projectId}-${Date.now()}`,
						message: analysisPrompt,
						history: [],
						userId,
						organizationId,
						executionMode: "accurate" as const,
						enabledMcpConfigIds: [mcpConfigId],
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

		const analysisContent = orchestratorResult.response;
		log.info("Orchestrator code analysis complete", {
			responseLength: analysisContent.length,
			toolCallCount: orchestratorResult.toolCalls?.length ?? 0,
		});

		// Step 4: Save analysis as project context
		log.info("Step 4: Saving code analysis as project context");
		const repoUrl =
			repositoryUrl ??
			`https://${repositoryProvider === "gitlab" ? "gitlab.com" : "github.com"}/${repositoryOwner}/${repositoryName}`;
		const { contextId } = await saveCodeAnalysisContext({
			projectId,
			userId,
			organizationId,
			analysisContent,
			repositoryOwner,
			repositoryName,
			repoUrls: [repoUrl],
		});
		log.info("Code analysis context saved", { contextId });

		// Step 5: Create document records
		log.info("Step 5: Creating document records");
		const { documents } = await createCodeBasedDocumentRecords({
			projectId,
			userId,
			organizationId,
		});
		log.info("Document records created", {
			count: documents.length,
			types: documents.map((d) => d.type),
		});

		// Step 6: Generate all 4 documents in parallel using directContext
		log.info("Step 6: Generating documents in parallel", {
			documentCount: documents.length,
		});

		const documentResults = await Promise.allSettled(
			documents.map(async (doc) => {
				const childWorkflowId = `${workflowId}-doc-${doc.id}`;

				log.info("Starting document generation child workflow", {
					documentId: doc.id,
					documentType: doc.type,
					childWorkflowId,
				});

				return executeChild(documentGenerationChildWorkflow, {
					workflowId: childWorkflowId,
					args: [
						{
							projectId,
							documentId: doc.id,
							documentType: doc.type,
							userId,
							organizationId,
							aiToken,
							directContext: [analysisContent],
						},
					],
					workflowExecutionTimeout: "20m",
				});
			}),
		);

		// Log results — child workflows now throw on failure, so rejected = failed
		const succeeded = documentResults.filter(
			(r) => r.status === "fulfilled",
		);
		const failed = documentResults.filter((r) => r.status === "rejected");

		log.info("Document generation complete", {
			succeeded: succeeded.length,
			failed: failed.length,
		});

		// Step 6b: Start document evaluation for each successful document (fire-and-forget)
		for (const result of documentResults) {
			if (result.status !== "fulfilled") {
				continue;
			}
			const childResult = result.value;
			const docContent = childResult.documentContent;
			if (!docContent) {
				continue;
			}

			const doc = documents.find((d) => d.id === childResult.documentId);
			try {
				await startChild(documentEvalWorkflow, {
					workflowId: `${workflowId}-eval-${childResult.documentId}`,
					parentClosePolicy:
						ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
					args: [
						{
							projectDocumentId: childResult.documentId,
							documentContent: docContent,
							documentVersion: 1,
							documentType: (doc?.type ??
								"PRD") as ProjectDocumentType,
							userId,
							organizationId,
							threshold: 70,
						},
					],
				});
				log.info("Started eval workflow for document", {
					documentId: childResult.documentId,
					documentType: doc?.type,
				});
			} catch (evalError) {
				log.warn("Failed to start eval workflow (non-fatal)", {
					documentId: childResult.documentId,
					error:
						evalError instanceof Error
							? evalError.message
							: "Unknown error",
				});
			}
		}

		// Step 7: Update status to COMPLETED
		await updateProjectCodeAnalysisStatus({
			projectId,
			status:
				failed.length > 0 && succeeded.length === 0
					? "FAILED"
					: "COMPLETED",
		});

		return {
			success: succeeded.length > 0,
			documentIds: documents.map((d) => d.id),
			analysisContextId: contextId,
			error:
				failed.length > 0
					? `${failed.length} of ${documents.length} documents failed to generate`
					: undefined,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		log.error("Code-based project setup failed", {
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
			// Best effort — don't mask the original error
		}

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"CODE_PROJECT_SETUP_FAILED",
		);
	}
}
