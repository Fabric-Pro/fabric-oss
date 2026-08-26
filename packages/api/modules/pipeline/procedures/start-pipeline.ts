/**
 * Start Pipeline Procedure
 *
 * Starts a PRD → Tasks pipeline workflow via Temporal.
 * Creates an execution record and returns immediately while
 * the workflow runs in the background with full durability.
 */

import { ORPCError } from "@orpc/client";
import { issueAIToken } from "@repo/ai-token";
import {
	db,
	getAiProviderApiKey,
	hasProjectAccess,
	hasProviderCredentials,
} from "@repo/database";
import { getTemporalClient, isTemporalAvailable } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const PipelineInputSchema = z.object({
	projectName: z.string().min(1, "Project name is required"),
	projectDescription: z
		.string()
		.min(10, "Description must be at least 10 characters"),
	goals: z.array(z.string()).optional(),
	features: z.array(z.string()).optional(),
	techStack: z.array(z.string()).optional(),
	organizationId: z.string().nullable().optional(),
	projectId: z.string().optional(),

	// Existing documents (skip generation)
	existingPRD: z.string().optional(),

	// Pipeline configuration
	skipStoryBreakdown: z.boolean().optional(),
	skipTaskPlanning: z.boolean().optional(),

	// Generic project management integration (works with any PM tool via MCP)
	projectManagementConfig: z
		.object({
			enabled: z.boolean(),
			mcpConfigId: z.string().optional(), // MCP config ID for the PM tool
			containerId: z.string().optional(), // Board/Project/Team ID
			containerName: z.string().optional(), // Display name
			additionalContext: z.record(z.string(), z.string()).optional(), // Tool-specific context (e.g., accountSlug for Fizzy)
		})
		.optional(),

	// Legacy Fizzy integration (deprecated - use projectManagementConfig instead)
	fizzyConfig: z
		.object({
			enabled: z.boolean(),
			accessToken: z.string().optional(),
			accountSlug: z.string().optional(),
			boardId: z.string().optional(),
			columnId: z.string().optional(),
		})
		.optional(),

	// Per-document generation config (skip types with existing docs)
	documentConfig: z
		.array(
			z.object({
				type: z.enum([
					"TECHNICAL_SPEC",
					"API_SPEC",
					"ARCHITECTURE",
					"USER_STORY",
				]),
				action: z.enum(["use_existing", "generate"]),
				existingDocumentId: z.string().optional(),
				prompt: z.string().optional(),
				promptId: z.string().optional(),
			}),
		)
		.optional(),

	// Approval gates (for future use)
	requireApprovalBeforeStoryBreakdown: z.boolean().optional(),
	requireApprovalBeforeTaskPlanning: z.boolean().optional(),
	requireApprovalBeforeIssueCreation: z.boolean().optional(),
});

const PipelineOutputSchema = z.object({
	pipelineId: z.string(),
	executionId: z.string(),
	temporalWorkflowId: z.string().nullable(),
	status: z.enum(["started", "pending", "failed"]),
	message: z.string().optional(),
});

export const startPipelineProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/pipeline/start",
		tags: ["Pipeline"],
		summary: "Start PRD → Tasks pipeline",
		description:
			"Starts a durable pipeline workflow that generates PRD, stories, tasks, and optionally pushes to Fizzy",
	})
	.input(PipelineInputSchema)
	.output(PipelineOutputSchema)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// TENANT ISOLATION (SOC 2 CC6.1/CC6.3): projectId is caller-supplied and
		// flows into the PRD read below AND into the pipeline workflow, which
		// writes generated stories/tasks back into that project. Verify the
		// caller can access it before doing either.
		if (input.projectId) {
			const hasAccess = await hasProjectAccess(
				input.projectId,
				user.id,
				organizationId,
			);
			if (!hasAccess) {
				throw new ORPCError("FORBIDDEN", {
					message: "You don't have access to this project",
				});
			}
		}

		// Pre-flight check: Validate AI provider is configured for this context
		// This gives a clear error upfront instead of failing deep in the workflow
		const aiProviderConfig = await getAiProviderApiKey({
			userId: user.id,
			organizationId,
		});

		// Use the shared predicate, not `!apiKey`: a Databricks service-principal
		// config stores no API key and would otherwise fail this preflight
		// despite being correctly configured.
		if (
			!aiProviderConfig.provider ||
			!hasProviderCredentials(aiProviderConfig)
		) {
			const contextType = organizationId
				? "organization"
				: "personal account";
			const settingsPath = organizationId
				? "organization settings (Settings → AI Providers)"
				: "personal settings (Settings → AI Providers)";

			throw new ORPCError("PRECONDITION_FAILED", {
				message: `No AI provider configured for this ${contextType}. Please configure an AI provider in ${settingsPath} before running the pipeline.`,
			});
		}

		const pipelineId = `pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		// Determine if issue creation is enabled (either via new PM config or legacy Fizzy config)
		const issueCreationEnabled =
			input.projectManagementConfig?.enabled ||
			input.fizzyConfig?.enabled;

		// Create a workflow execution record to track this pipeline
		// Using pipelineId field for pipeline-specific tracking (workflowId is null for pipelines)
		const execution = await db.workflowExecution.create({
			data: {
				pipelineId, // Pipeline identifier for tracking
				version: 1,
				status: "PENDING",
				triggerType: "MANUAL",
				triggerInput: {
					projectName: input.projectName,
					projectDescription: input.projectDescription,
					goals: input.goals,
					features: input.features,
					techStack: input.techStack,
					projectManagementConfig: input.projectManagementConfig,
					fizzyConfig: input.fizzyConfig, // Keep for backward compatibility
				},
				userId: user.id,
				organizationId,
			},
		});

		// Create initial stage logs
		const stages = ["prd_generation", "story_breakdown", "task_planning"];
		if (issueCreationEnabled) {
			stages.push("issue_creation");
		}

		await db.workflowExecutionLog.createMany({
			data: stages.map((stage) => ({
				executionId: execution.id,
				nodeId: stage,
				nodeType: "agent",
				status: "PENDING" as const,
			})),
		});

		// Check if Temporal is available
		const temporalAvailable = await isTemporalAvailable();

		if (!temporalAvailable) {
			// Update execution status
			await db.workflowExecution.update({
				where: { id: execution.id },
				data: {
					status: "FAILED",
					error: "Temporal workflow service is not available",
					completedAt: new Date(),
				},
			});

			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Temporal workflow service is not available",
			});
		}

		try {
			const client = await getTemporalClient();

			// Issue AI token in the API layer where AI_TOKEN_SECRET is available
			// This token will be passed to Temporal activities for agent authentication
			// Use very long expiry for pipeline (60 minutes) as it involves multiple stages
			const aiToken = await issueAIToken({
				userId: user.id,
				organizationId,
				source: "prd-to-tasks-pipeline",
				expirySeconds: 3600,
			});

			// Determine issue tracker type based on config
			// New PM config takes precedence over legacy Fizzy config
			let issueTracker: "none" | "fizzy" | "mcp" = "none";
			let issueTrackerConfig: Record<string, unknown> | undefined;

			if (input.projectManagementConfig?.enabled) {
				// New generic MCP-based project management
				issueTracker = "mcp";
				issueTrackerConfig = {
					mcpConfigId: input.projectManagementConfig.mcpConfigId,
					containerId: input.projectManagementConfig.containerId,
					containerName: input.projectManagementConfig.containerName,
					additionalContext:
						input.projectManagementConfig.additionalContext,
				};
			} else if (input.fizzyConfig?.enabled) {
				// Legacy Fizzy config (backward compatibility)
				issueTracker = "fizzy";
				issueTrackerConfig = {
					fizzyAccessToken: input.fizzyConfig.accessToken,
					fizzyAccountSlug: input.fizzyConfig.accountSlug,
					fizzyBoardId: input.fizzyConfig.boardId,
					fizzyColumnId: input.fizzyConfig.columnId,
				};
			}

			let existingPRD = input.existingPRD;

			if (input.projectId && !existingPRD) {
				// Get existing PRD from Fabric ProjectDocument
				const prdDoc = await db.projectDocument.findFirst({
					where: { projectId: input.projectId, type: "PRD" },
					select: { content: true },
				});
				if (prdDoc?.content) {
					existingPRD = prdDoc.content;
				}
			}

			// Start the Temporal workflow
			const handle = await client.workflow.start(
				"prdToTasksPipelineWorkflow",
				withCorrelationMemo({
					taskQueue: "fabric-worker",
					workflowId: `prd-pipeline-${execution.id}`,
					args: [
						{
							pipelineId: execution.id,
							userId: user.id,
							organizationId,
							projectId: input.projectId,
							aiToken, // Pass pre-issued token to workflow
							projectName: input.projectName,
							projectDescription: input.projectDescription,
							goals: input.goals,
							features: input.features,
							techStack: input.techStack,
							existingPRD,
							prdSource: undefined,
							skipStoryBreakdown: input.skipStoryBreakdown,
							skipTaskPlanning: input.skipTaskPlanning,
							documentConfig: input.documentConfig,
							issueTracker,
							issueTrackerConfig,
							requireApprovalBeforeStoryBreakdown:
								input.requireApprovalBeforeStoryBreakdown,
							requireApprovalBeforeTaskPlanning:
								input.requireApprovalBeforeTaskPlanning,
							requireApprovalBeforeIssueCreation:
								input.requireApprovalBeforeIssueCreation,
						},
					],
				}),
			);

			// Update execution with Temporal run ID
			await db.workflowExecution.update({
				where: { id: execution.id },
				data: {
					temporalRunId: handle.workflowId,
					status: "RUNNING",
					startedAt: new Date(),
				},
			});

			return {
				pipelineId: execution.id,
				executionId: execution.id,
				temporalWorkflowId: handle.workflowId,
				status: "started",
				message: "Pipeline started successfully",
			};
		} catch (error) {
			console.error(
				"[Pipeline] Failed to start Temporal workflow:",
				error,
			);

			// Update execution status
			await db.workflowExecution.update({
				where: { id: execution.id },
				data: {
					status: "FAILED",
					error:
						error instanceof Error
							? error.message
							: "Failed to start workflow",
					completedAt: new Date(),
				},
			});

			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to start pipeline: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	});
