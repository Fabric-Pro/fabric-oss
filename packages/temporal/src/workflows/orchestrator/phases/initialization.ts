/**
 * Initialization Phase
 *
 * Handles workflow initialization including:
 * - Resource preloading (MCP tools, agents, preferences) - LOADED ONCE
 * - Orchestrator memory loading (preferences + episodic memory)
 * - Workspace document context retrieval
 * - Letta memory initialization
 * - Hybrid routing suggestions
 * - Policy enrichment
 */

import { log, patched, proxyActivities } from "@temporalio/workflow";
import type * as orchestratorActivities from "../../../activities/orchestrator";
import type * as orchestratorMemoryActivities from "../../../activities/orchestrator-memory";
import type * as projectMetadataActivities from "../../../activities/project-metadata";
import type * as weaveActivities from "../../../activities/weave";
import { formatRepositoryRoleMap } from "../../../lib/repository-role-formatter";
import type {
	OrchestratorWorkflowInput,
	PhaseResult,
	PreloadedResources,
	WorkflowState,
} from "../types";

const {
	// Note: retrieveWorkspaceDocumentsActivity is now called on-demand during execution
	// via the workspace_rag_query tool handler, not during initialization
	initializeLettaMemory,
	getHybridRoutingSuggestions,
	applyPolicyEnrichment,
	applyFabricPatternEnrichment,
	preloadResourcesActivity,
	loadInstanceMemoryActivity,
} = proxyActivities<typeof orchestratorActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

const { loadOrchestratorMemoryActivity, updateRecentActivityActivity } =
	proxyActivities<typeof orchestratorMemoryActivities>({
		startToCloseTimeout: "2 minutes",
		heartbeatTimeout: "30 seconds",
		retry: {
			initialInterval: "500ms",
			backoffCoefficient: 2,
			maximumInterval: "10s",
			maximumAttempts: 2,
		},
	});

const { createSandboxActivity, updateWeaveExecutionActivity } = proxyActivities<
	typeof weaveActivities
>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { getProjectMetadataActivity } = proxyActivities<
	typeof projectMetadataActivities
>({
	startToCloseTimeout: "30 seconds",
	retry: {
		initialInterval: "500ms",
		backoffCoefficient: 2,
		maximumInterval: "5s",
		maximumAttempts: 2,
	},
});

/**
 * Execute initialization phase
 *
 * This phase prepares the workflow by:
 * 1. Preloading all resources (MCP tools, agents, preferences) - ONCE for entire workflow
 * 2. Retrieving workspace document context (RAG)
 * 3. Initializing Letta memory for semantic search
 * 4. Getting hybrid routing suggestions from past executions
 * 5. Applying policy enrichment
 */
export async function executeInitializationPhase(
	state: WorkflowState,
	input: OrchestratorWorkflowInput,
	updateProgress: (phase: string, message: string) => void,
): Promise<
	PhaseResult<{
		workspaceContext: string;
		lettaAgentId: string | null;
		enrichedMessage: string;
		enrichedSystemPrompt: string;
		preloadedResources: PreloadedResources;
	}>
> {
	const { executionId } = state;

	log.info("Starting initialization phase", {
		executionId,
		userId: input.userId,
	});

	try {
		// ======================================================================
		// Step 0: Preload ALL Resources (MCP tools, agents, preferences)
		// This is loaded ONCE and reused for ALL steps - critical for performance
		// ======================================================================
		updateProgress(
			"routing",
			"Preloading resources (MCP tools, agents)...",
		);

		const preloadedResources = await preloadResourcesActivity({
			userId: input.userId,
			organizationId: input.organizationId,
			instanceId: input.instanceId,
			projectId: input.projectId,
			enabledMcpConfigIds: input.enabledMcpConfigIds ?? undefined,
			enabledAgentIds: input.enabledAgentIds ?? undefined,
			enabledIntegrationIds: input.enabledIntegrationIds ?? undefined,
		});

		log.info("Resources preloaded", {
			mcpServers: preloadedResources.mcpTools.length,
			totalTools: Object.keys(preloadedResources.toolMap).length,
			agents: preloadedResources.agents.length,
			loadDurationMs: preloadedResources.loadDurationMs,
		});

		// Store in state for use by all subsequent phases
		state.preloadedResources = preloadedResources;

		// ======================================================================
		// Step 0.5: Load Orchestrator Memory (User Preferences + Episodic Memory)
		// This provides personalized context based on past interactions
		// ======================================================================
		updateProgress("routing", "Loading orchestrator memory...");

		let orchestratorMemoryPrompt = "";

		try {
			// Extract project/workspace context from input
			const projectId = input.projectId ?? null;
			const workspaceId = input.workspaceIds?.[0] ?? null;

			const memoryResult = await loadOrchestratorMemoryActivity({
				userId: input.userId,
				organizationId: input.organizationId,
				projectId,
				workspaceId,
				currentQuery: input.message,
			});

			orchestratorMemoryPrompt = memoryResult.memoryContextPrompt;

			// Track in planning audit
			if (memoryResult.memoryContextPrompt.length > 0) {
				state.planningAudit.contextSources.push({
					type: "orchestrator_memory",
					description: `Loaded user preferences and ${memoryResult.relevantEpisodes.length + memoryResult.recentEpisodes.length} relevant past conversations`,
					used: true,
					usageReason: "Personalizing response based on user history",
				});

				log.info("[Initialization] Orchestrator memory loaded", {
					hasPreferences: !!memoryResult.preferences.responseStyle,
					recentEpisodeCount: memoryResult.recentEpisodes.length,
					relevantEpisodeCount: memoryResult.relevantEpisodes.length,
					promptLength: orchestratorMemoryPrompt.length,
				});
			} else {
				state.planningAudit.contextSources.push({
					type: "orchestrator_memory",
					description: "No prior memory context available",
					used: false,
					usageReason: "New user or no relevant past interactions",
				});

				log.info(
					"[Initialization] No orchestrator memory context available",
				);
			}

			// Update recent activity if project/workspace is being used
			if (projectId || workspaceId) {
				// Fire and forget - don't block initialization
				updateRecentActivityActivity({
					userId: input.userId,
					organizationId: input.organizationId,
					projectId: projectId ?? undefined,
					workspaceId: workspaceId ?? undefined,
				}).catch((err) => {
					log.warn(
						"[Initialization] Failed to update recent activity",
						{
							error:
								err instanceof Error
									? err.message
									: "Unknown error",
						},
					);
				});
			}
		} catch (error) {
			log.warn(
				"[Initialization] Failed to load orchestrator memory, continuing without",
				{
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
			);
			state.planningAudit.contextSources.push({
				type: "orchestrator_memory",
				description: "Failed to load memory context",
				used: false,
				usageReason:
					error instanceof Error ? error.message : "Unknown error",
			});
			// Issue #9: Track degraded capability
			state.degradedCapabilities.orchestratorMemory = true;
		}

		// ======================================================================
		// Step 1: Workspace Document Context (RAG) - DEFERRED TO EXECUTION
		// ======================================================================
		// NOTE: Workspace RAG is now handled dynamically during execution phase
		// via the workspace_rag_query tool. This avoids:
		// - Retrieving documents for queries that don't need them
		// - Using raw user message as query (execution can use refined queries)
		// - Blocking initialization with expensive vector searches
		//
		// The workspace_rag_query tool is discovered via semantic search and
		// executed on-demand when the planner determines workspace docs are needed.
		const workspaceIds = input.workspaceIds || [];

		if (workspaceIds.length > 0) {
			log.info("[Initialization] Workspace documents available", {
				workspaceCount: workspaceIds.length,
				workspaceIds,
				note: "RAG will be performed on-demand during execution via workspace_rag_query tool",
			});

			// Track that workspaces are available (not yet used)
			state.planningAudit.contextSources.push({
				type: "workspace_rag",
				description: `${workspaceIds.length} workspace(s) available for on-demand RAG`,
				used: false,
				usageReason: "Will be queried during execution if needed",
			});
		}

		// ======================================================================
		// Step 2: Initialize Letta Memory (Semantic Memory & Caching)
		// ======================================================================
		let lettaAgentId: string | null = null;

		try {
			updateProgress("routing", "Initializing semantic memory...");

			const lettaMemory = await initializeLettaMemory({
				userId: input.userId,
				organizationId: input.organizationId,
				availableAgents: input.enabledAgentIds?.map((id) => ({
					id,
					name: id,
					description: `Agent ${id}`,
					capabilities: [],
				})),
			});

			if (lettaMemory) {
				lettaAgentId = lettaMemory.agentId;
				log.info("Letta memory initialized", {
					agentId: lettaAgentId,
					isNew: lettaMemory.isNew,
					message: lettaMemory.isNew
						? "Created new memory agent"
						: "Using existing memory agent",
				});
			}

			// Get hybrid routing suggestions
			await getHybridRoutingSuggestionsAndUpdate(
				state,
				input,
				lettaAgentId,
				updateProgress,
			);
		} catch (error) {
			log.warn(
				"Memory initialization failed, continuing without memory",
				{
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
			);
			// Issue #9: Track degraded capability
			state.degradedCapabilities.memory = true;
		}

		// ======================================================================
		// Step 3: Apply Policy Enrichment
		// ======================================================================
		updateProgress("routing", "Applying policy enrichment...");

		let enrichedMessage = input.message;
		// Start with custom system prompt from input (e.g., agent template instructions)
		let enrichedSystemPrompt = input.systemPrompt || "";

		// Inject current date/time so the LLM knows "today"
		// Use explicit UTC formatting for Temporal workflow determinism
		// (toLocaleDateString/toLocaleTimeString depend on ICU/locale data)
		const now = new Date();
		const days = [
			"Sunday",
			"Monday",
			"Tuesday",
			"Wednesday",
			"Thursday",
			"Friday",
			"Saturday",
		];
		const months = [
			"January",
			"February",
			"March",
			"April",
			"May",
			"June",
			"July",
			"August",
			"September",
			"October",
			"November",
			"December",
		];
		const dayName = days[now.getUTCDay()];
		const monthName = months[now.getUTCMonth()];
		const day = now.getUTCDate();
		const year = now.getUTCFullYear();
		const hours = now.getUTCHours();
		const minutes = now.getUTCMinutes();
		const ampm = hours >= 12 ? "PM" : "AM";
		const h12 = hours % 12 || 12;
		const mm = String(minutes).padStart(2, "0");
		const currentDateTimeStr = `${dayName}, ${monthName} ${day}, ${year}, ${String(h12).padStart(2, "0")}:${mm} ${ampm} UTC`;
		enrichedSystemPrompt = `Today is ${currentDateTimeStr}.\n\n${enrichedSystemPrompt}`;

		// Track custom system prompt in audit
		if (input.systemPrompt) {
			log.info("[Initialization] Custom system prompt provided", {
				promptLength: input.systemPrompt.length,
				instanceId: input.instanceId,
			});
			state.planningAudit.contextSources.push({
				type: "agent_template",
				description: input.instanceId
					? `Agent template instructions (instance: ${input.instanceId})`
					: "Custom agent instructions",
				used: true,
				usageReason:
					"Custom instructions provided for this agent instance",
			});
		}

		if (input.policyContext) {
			const enrichment = await applyPolicyEnrichment({
				message: input.message,
				userId: input.userId,
				organizationId: input.organizationId,
				policyContext: input.policyContext,
			});

			if (enrichment.blocked) {
				state.planningAudit.contextSources.push({
					type: "policy_enrichment",
					description: "Policy blocked this request",
					used: true,
					usageReason: enrichment.blockReason || "Blocked by policy",
				});
				return {
					success: false,
					error: enrichment.blockReason || "Blocked by policy",
					shouldContinue: false,
				};
			}

			enrichedMessage = enrichment.enrichedMessage || input.message;
			// Append policy additions to existing system prompt (don't overwrite custom instructions)
			if (enrichment.systemPromptAdditions) {
				enrichedSystemPrompt = enrichedSystemPrompt
					? `${enrichedSystemPrompt}\n\n${enrichment.systemPromptAdditions}`
					: enrichment.systemPromptAdditions;
			}

			if (
				enrichment.enrichedMessage !== input.message ||
				enrichment.systemPromptAdditions
			) {
				state.planningAudit.contextSources.push({
					type: "policy_enrichment",
					description: "Applied system policies to request",
					used: true,
					usageReason: "Message was enhanced with policy context",
				});
			}
		}

		// NOTE: Workspace context is no longer appended here.
		// RAG is now performed on-demand during execution via workspace_rag_query tool.
		// This provides better query refinement and only retrieves when needed.

		// ======================================================================
		// Step 3.25: Project Context (Metadata Injection + Deferred RAG)
		// Inject project metadata into system prompt so the AI is project-aware.
		// Detailed project context is fetched on-demand via project_rag_query tool.
		// ======================================================================
		if (input.projectId) {
			log.info("[Initialization] Loading project metadata", {
				projectId: input.projectId,
			});
			try {
				const projectMetadata = await getProjectMetadataActivity(
					input.projectId,
					{
						userId: input.userId,
						organizationId: input.organizationId ?? null,
					},
				);
				if (projectMetadata) {
					const projectContext = [
						"<project_context>",
						`Project: ${projectMetadata.name}`,
						projectMetadata.description
							? `Description: ${projectMetadata.description}`
							: null,
						projectMetadata.goals
							? `Goals: ${projectMetadata.goals}`
							: null,
						projectMetadata.techStack?.length
							? `Tech Stack: ${projectMetadata.techStack.join(", ")}`
							: null,
						projectMetadata.features?.length
							? `Features: ${projectMetadata.features.join(", ")}`
							: null,
						patched("orchestrator-repository-role-prompt-v1")
							? projectMetadata.repositoryRoles?.length
								? formatRepositoryRoleMap(
										projectMetadata.repositoryRoles,
									)
								: projectMetadata.repositoryUrls?.length
									? `Repositories: ${projectMetadata.repositoryUrls.join(", ")}`
									: null
							: projectMetadata.repositoryUrls?.length
								? `Repositories: ${projectMetadata.repositoryUrls.join(", ")}`
								: projectMetadata.repositoryUrl
									? `Repository: ${projectMetadata.repositoryUrl}`
									: null,
						projectMetadata.codeAnalysisStatus
							? `Code Analysis: ${projectMetadata.codeAnalysisStatus}`
							: null,
						`Available contexts: ${projectMetadata.contextCount}, Generated documents: ${projectMetadata.documentCount}`,
						"Use the project_rag_query tool to search for detailed project context when needed.",
						"</project_context>",
					]
						.filter(Boolean)
						.join("\n");

					enrichedSystemPrompt = enrichedSystemPrompt
						? `${enrichedSystemPrompt}\n\n${projectContext}`
						: projectContext;

					state.planningAudit.contextSources.push({
						type: "project_context",
						description: `Project "${projectMetadata.name}" attached — metadata injected, RAG available via project_rag_query tool`,
						used: true,
						usageReason:
							"Project metadata in system prompt; on-demand RAG for detailed queries",
					});

					log.info("[Initialization] Project metadata injected", {
						projectId: input.projectId,
						projectName: projectMetadata.name,
						contextCount: projectMetadata.contextCount,
						documentCount: projectMetadata.documentCount,
					});
				} else {
					log.warn(
						"[Initialization] Project not found, skipping metadata injection",
						{ projectId: input.projectId },
					);
				}
			} catch (error) {
				log.warn(
					"[Initialization] Failed to load project metadata, continuing without",
					{
						projectId: input.projectId,
						error:
							error instanceof Error
								? error.message
								: "Unknown error",
					},
				);
			}
		}

		// ======================================================================
		// Step 3.5: Load Instance Memory (Skills, AGENTS.md, Knowledge)
		// When an agent instanceId is provided, inject its procedural memory
		// and skills into the system prompt so the agent can use them.
		// ======================================================================
		if (input.instanceId) {
			try {
				updateProgress("routing", "Loading agent memory and skills...");

				const instanceMemory = await loadInstanceMemoryActivity({
					instanceId: input.instanceId,
					userId: input.userId,
					organizationId: input.organizationId,
				});

				if (instanceMemory.fileCount > 0) {
					enrichedSystemPrompt = enrichedSystemPrompt
						? `${enrichedSystemPrompt}${instanceMemory.memoryPrompt}`
						: instanceMemory.memoryPrompt.trim();

					state.planningAudit.contextSources.push({
						type: "agent_template",
						description: `Loaded ${instanceMemory.fileCount} agent memory file(s) (skills, knowledge)`,
						used: true,
						usageReason:
							"Agent instance memory injected into system prompt",
					});

					log.info("[Initialization] Instance memory loaded", {
						instanceId: input.instanceId,
						fileCount: instanceMemory.fileCount,
					});
				}
			} catch (error) {
				log.warn(
					"[Initialization] Failed to load instance memory, continuing without",
					{
						error:
							error instanceof Error
								? error.message
								: "Unknown error",
					},
				);
				// Issue #9: Track degraded capability
				state.degradedCapabilities.instanceMemory = true;
			}
		}

		// ======================================================================
		// Step 4: Apply Fabric AI Pattern Enrichment (Strategy → Context → Pattern)
		// Auto-detects appropriate patterns based on user message
		// ======================================================================
		updateProgress("routing", "Applying Fabric AI pattern enrichment...");

		try {
			const fabricEnrichment = await applyFabricPatternEnrichment({
				message: input.message,
				userId: input.userId,
				organizationId: input.organizationId,
				basePrompt: enrichedSystemPrompt,
				enableAutoDetection: true,
			});

			if (fabricEnrichment.fabricAvailable) {
				if (
					fabricEnrichment.components.pattern ||
					fabricEnrichment.components.strategy ||
					fabricEnrichment.components.context
				) {
					enrichedSystemPrompt = fabricEnrichment.composedPrompt;

					log.info("Fabric AI pattern enrichment applied", {
						strategy: fabricEnrichment.components.strategy,
						context: fabricEnrichment.components.context,
						pattern: fabricEnrichment.components.pattern,
						cacheHits: fabricEnrichment.cacheHits,
						promptLength: enrichedSystemPrompt.length,
					});

					state.planningAudit.contextSources.push({
						type: "fabric_pattern",
						description: `Applied Fabric: ${[
							fabricEnrichment.components.strategy &&
								`strategy=${fabricEnrichment.components.strategy}`,
							fabricEnrichment.components.context &&
								`context=${fabricEnrichment.components.context}`,
							fabricEnrichment.components.pattern &&
								`pattern=${fabricEnrichment.components.pattern}`,
						]
							.filter(Boolean)
							.join(", ")}`,
						used: true,
						usageReason:
							"System prompt enhanced with Fabric AI composition",
					});
				} else {
					log.info(
						"Fabric AI available but no patterns matched for this request",
					);
					state.planningAudit.contextSources.push({
						type: "fabric_pattern",
						description: "Fabric AI available, no patterns matched",
						used: false,
						usageReason:
							"Request did not match any auto-detection rules",
					});
				}
			} else {
				log.info(
					"Fabric AI server not available, skipping pattern enrichment",
				);
			}
		} catch (error) {
			log.warn(
				"Fabric AI pattern enrichment failed, continuing without",
				{
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
			);
			// Issue #9: Track degraded capability
			state.degradedCapabilities.patterns = true;
		}

		// ======================================================================
		// Step 4b: Inject workflow guidance from connected integrations/MCPs
		// The preload activity collects workflowGuidance from all account definitions
		// (mcp-registry) and stores it in preloadedResources.workflowGuidance.
		// This is generic — works for all current and future integrations.
		// ======================================================================
		if (preloadedResources.workflowGuidance) {
			enrichedSystemPrompt = enrichedSystemPrompt
				? `${enrichedSystemPrompt}\n\n${preloadedResources.workflowGuidance}`
				: preloadedResources.workflowGuidance;
		}

		// ======================================================================
		// Step 5: Append Orchestrator Memory Context
		// Add user preferences and relevant past conversations to system prompt
		// ======================================================================
		if (orchestratorMemoryPrompt.length > 0) {
			enrichedSystemPrompt = enrichedSystemPrompt
				? `${enrichedSystemPrompt}\n\n${orchestratorMemoryPrompt}`
				: orchestratorMemoryPrompt;

			log.info(
				"[Initialization] Orchestrator memory added to system prompt",
				{
					totalPromptLength: enrichedSystemPrompt.length,
					memoryPromptLength: orchestratorMemoryPrompt.length,
				},
			);
		}

		// ======================================================================
		// Weave Mode: Create Background Agents sandbox only when needed
		// ======================================================================
		if (
			input.executionMode === "weave" &&
			input.weavePlanId &&
			(input.weaveImplementationProvider ?? "BACKGROUND_AGENTS") ===
				"BACKGROUND_AGENTS"
		) {
			updateProgress("routing", "Creating weave sandbox...");

			// Resolve repo URL from project metadata
			let repoUrl = "";
			const branch = "main";
			if (input.projectId) {
				try {
					const projectMeta = await getProjectMetadataActivity(
						input.projectId,
						{
							userId: input.userId,
							organizationId: input.organizationId ?? null,
						},
					);
					if (projectMeta?.repositoryUrl) {
						repoUrl = projectMeta.repositoryUrl;
					}
				} catch {
					log.warn("Failed to load project metadata for sandbox");
				}
			}

			try {
				const sandbox = await createSandboxActivity({
					userId: input.userId,
					organizationId: input.organizationId ?? null,
					repoUrl,
					branch,
				});

				state.variables["weave.sandboxSessionId"] = {
					name: "weave.sandboxSessionId",
					value: sandbox.sessionId,
					setBy: "orchestrator",
					setAt: new Date().toISOString(),
					scope: "workflow",
					readonly: true,
				};

				log.info("Weave sandbox created", {
					sessionId: sandbox.sessionId,
				});

				// Persist sandboxSessionId to the weave_execution DB record
				if (input.weaveExecutionId) {
					try {
						await updateWeaveExecutionActivity({
							executionId: input.weaveExecutionId,
							userId: input.userId,
							organizationId: input.organizationId,
							sandboxSessionId: sandbox.sessionId,
						});
					} catch (e) {
						log.warn(
							"Failed to persist sandboxSessionId to execution",
							{
								error:
									e instanceof Error ? e.message : String(e),
							},
						);
					}
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				// A weave BACKGROUND_AGENTS run without a sandbox is doomed —
				// the shuttle step has no session to talk to. Fail fast with
				// an actionable error instead of swallowing and proceeding.
				// Gated by patched() so pre-patch histories (which swallowed
				// and continued) still replay deterministically. Patch id is
				// workflow-scoped: never reuse or rename.
				if (patched("weave-sandbox-failfast-v1")) {
					log.error(
						"Weave sandbox creation failed — failing execution",
						{ error: message },
					);
					return {
						success: false,
						error:
							`Could not start the Background Agents sandbox: ${message}. ` +
							"Check that the project repository URL is set and that the Background Agents " +
							"service (BACKGROUND_AGENTS_URL) is configured for the worker.",
						shouldContinue: false,
					};
				}
				// pre-patch histories: preserve old behavior exactly
				log.warn(
					"Weave sandbox creation failed — continuing without sandbox",
					{ error: message },
				);
			}
		}

		if (
			input.executionMode === "weave" &&
			input.weavePlanId &&
			(input.weaveImplementationProvider ?? "BACKGROUND_AGENTS") !==
				"BACKGROUND_AGENTS"
		) {
			log.info(
				"Skipping weave sandbox creation for generalized implementation delegation",
				{
					provider: input.weaveImplementationProvider,
					weavePlanId: input.weavePlanId,
					weaveExecutionId: input.weaveExecutionId,
				},
			);
		}

		return {
			success: true,
			data: {
				workspaceContext: "", // RAG is now done on-demand during execution
				lettaAgentId,
				enrichedMessage,
				enrichedSystemPrompt,
				preloadedResources,
			},
			shouldContinue: true,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		log.error("Initialization phase failed", { error: errorMessage });
		return {
			success: false,
			error: errorMessage,
			shouldContinue: false,
		};
	}
}

/**
 * Get hybrid routing suggestions and update planning audit
 */
async function getHybridRoutingSuggestionsAndUpdate(
	state: WorkflowState,
	input: OrchestratorWorkflowInput,
	lettaAgentId: string | null,
	updateProgress: (phase: string, message: string) => void,
): Promise<void> {
	updateProgress("routing", "Analyzing past execution patterns...");

	// SECURITY: Credentials are fetched internally by the activity
	// API keys are NOT passed in workflow inputs to avoid storing them in Temporal history
	const hybridRouting = await getHybridRoutingSuggestions({
		task: input.message,
		lettaAgentId,
		userId: input.userId,
		organizationId: input.organizationId,
		includeFailureWarnings: true,
	});

	if (hybridRouting.suggestions.length > 0) {
		log.info("Hybrid routing suggestions available", {
			count: hybridRouting.suggestions.length,
			topSuggestion: hybridRouting.suggestions[0],
			sources: hybridRouting.suggestions.map((s) => s.source),
			stats: hybridRouting.stats,
		});

		// Track semantic memory in planning audit
		const semanticSuggestions = hybridRouting.suggestions.filter(
			(s) => s.source === "qdrant",
		);
		if (semanticSuggestions.length > 0) {
			state.planningAudit.contextSources.push({
				type: "semantic_memory",
				description: `Found ${semanticSuggestions.length} similar past execution(s)`,
				confidence: semanticSuggestions[0]?.confidence || 0,
				used: true,
				usageReason: "Will influence agent selection and planning",
			});
		}

		// Track Letta memory
		const lettaSuggestions = hybridRouting.suggestions.filter(
			(s) => s.source === "letta",
		);
		if (lettaSuggestions.length > 0) {
			state.planningAudit.contextSources.push({
				type: "letta_memory",
				description: `Found ${lettaSuggestions.length} keyword-based suggestion(s)`,
				used: true,
				usageReason: "Keyword patterns will inform routing",
			});
		}
	} else {
		state.planningAudit.contextSources.push({
			type: "semantic_memory",
			description: "No similar past executions found",
			used: false,
			usageReason: "Task appears to be new",
		});
	}

	// Log failure warnings (negative memory)
	if (hybridRouting.warnings.length > 0) {
		log.warn("Similar past failures detected", {
			warningCount: hybridRouting.warnings.length,
			warnings: hybridRouting.warnings.map((w) => ({
				task: w.failedTask.slice(0, 50),
				similarity: w.similarity,
				error: w.errorSummary,
			})),
		});

		state.planningAudit.contextSources.push({
			type: "negative_memory",
			description: `Found ${hybridRouting.warnings.length} similar past failure(s) to avoid`,
			confidence: hybridRouting.warnings[0]?.similarity || 0,
			used: true,
			usageReason: "Will adjust plan to avoid similar failures",
		});
	}
}
