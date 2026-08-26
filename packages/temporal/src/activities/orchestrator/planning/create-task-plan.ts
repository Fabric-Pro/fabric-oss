/**
 * Task Planning Activity
 *
 * Creates intelligent, context-aware task plans based on user intent.
 * Handles both generalist agent delegation (single-step) and
 * multi-step decomposition for specialist agents.
 *
 * REFACTORED:
 * - Uses semantic search results from routing (matchedAgents, matchedMcpTools)
 * - Respects user intent for explicit capability requests (workspace, workflow, MCP)
 * - Priority-based executor assignment: MCP > Agent > Workflow > LLM > Web
 */

import { generateText } from "@repo/ai";
import { db } from "@repo/database";
import { getTaskPlanningSystemPrompt } from "../../prompts";
import type {
	CapabilityMatch,
	CreateTaskPlanInput,
	TaskPlan,
	TaskStep,
} from "../types";
import {
	createCleanDescription,
	createPlanDescription,
	getAiModel,
	parseMessage,
	safeParseJson,
} from "../utils";
import {
	detectOperationRisk,
	type RiskAssessment,
} from "./operation-risk-detector";
import { assignStepExecutors } from "./step-assigner";

function detectRequestedFrameOutput(
	message: string,
): "frame" | "slideshow" | null {
	const lower = message.toLowerCase();
	const slideshowPatterns = [
		"slideshow",
		"slide deck",
		"slide-deck",
		"presentation",
		"presentation deck",
		"deck",
		"slides",
		"5-slide",
		"5 slide",
	];
	if (slideshowPatterns.some((pattern) => lower.includes(pattern))) {
		return "slideshow";
	}

	const framePatterns = [
		"create a frame",
		"make a frame",
		"build a frame",
		"interactive frame",
		"fabric frame",
		"wireframe",
		"dashboard",
	];
	if (framePatterns.some((pattern) => lower.includes(pattern))) {
		return "frame";
	}

	return null;
}

function deriveFrameTitle(
	message: string,
	kind: "frame" | "slideshow",
): string {
	const cleaned = message
		.replace(/^create\s+(a|an)?\s*/i, "")
		.replace(
			/^(\d+[- ]slide\s+)?(slideshow|slide deck|presentation|deck|frame)\s+(about|for|on)\s+/i,
			"",
		)
		.trim();
	if (!cleaned) {
		return kind === "slideshow" ? "Untitled Slideshow" : "Untitled Frame";
	}
	const base = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	return kind === "slideshow" ? `${base} Slideshow` : `${base} Frame`;
}

/**
 * Creates a task plan based on routing decision and user message.
 *
 * For GENERALIST agents (with complete-task delegation):
 * - Creates a single-step plan that delegates the entire task
 * - Agent handles internal decomposition
 * - Enhanced risk assessment for autonomous execution
 * - BUT: If task requires MCP tools the agent doesn't have, we decompose instead
 *
 * For SPECIALIST agents (with single-step delegation):
 * - Uses LLM to decompose task into multiple steps
 * - Each step is assigned an executor
 * - Risk levels are auto-detected based on operation types
 */
export async function createTaskPlan(
	input: CreateTaskPlanInput,
): Promise<TaskPlan> {
	const planStartTime = Date.now();
	console.log("[Orchestrator] Creating task plan");

	const requestedFrameOutput =
		input.routingDecision.userIntent?.requestedFrameOutput ??
		detectRequestedFrameOutput(input.message);
	const requestedFrameTool =
		requestedFrameOutput === "slideshow"
			? "fabric_create_slideshow"
			: requestedFrameOutput === "frame"
				? "fabric_create_frame"
				: null;
	const matchedToolNames = new Set(
		(input.routingDecision.matchedMcpTools || []).map(
			(tool) => tool.toolName,
		),
	);
	const canUseRequestedFrameTool =
		requestedFrameTool == null ||
		matchedToolNames.size === 0 ||
		matchedToolNames.has(requestedFrameTool);

	if (
		requestedFrameOutput &&
		requestedFrameTool &&
		canUseRequestedFrameTool
	) {
		const title = deriveFrameTitle(input.message, requestedFrameOutput);
		console.log("[Orchestrator] Using deterministic Fabric Frame plan", {
			requestedFrameOutput,
			requestedFrameTool,
			title,
		});
		return {
			id: `plan-${Date.now()}`,
			description: createPlanDescription(input.message),
			steps: [
				{
					id: "step-1",
					description:
						requestedFrameOutput === "slideshow"
							? "Create the requested slideshow as a first-class Fabric artifact"
							: "Create the requested frame as a first-class Fabric artifact",
					type: "generate",
					status: "pending",
					order: 1,
					executor: requestedFrameTool,
					app: requestedFrameTool,
					capability: "llm",
					riskLevel: "low",
					requiresApproval: false,
					inputs: {
						title,
						description: input.message,
						kind: requestedFrameOutput,
						format: "html",
					},
					expectedOutput:
						requestedFrameOutput === "slideshow"
							? "A persisted first-class slideshow artifact"
							: "A persisted first-class frame artifact",
				},
			],
			riskLevel: "low",
			strategy: "generate",
			createdAt: new Date().toISOString(),
		};
	}

	// ==========================================================================
	// CHECK IF TASK REQUIRES MCP TOOLS
	// Even generalist agents may not have access to all MCP tools
	// ==========================================================================
	const taskRequiresMcp = await checkIfTaskRequiresMcpTools(input);

	// ==========================================================================
	// GENERALIST AGENT SHORTCUT - with MCP check
	// If the primary agent is a generalist with complete-task delegation mode,
	// AND the task doesn't require MCP tools the agent can't use,
	// skip step decomposition and create a single step that delegates the entire task.
	// The generalist agent will handle decomposition internally.
	// ==========================================================================
	const agentCapabilities = input.routingDecision.agentCapabilities || {};
	const agentHasMcpAccess = agentCapabilities.hasMcpAccess === true;

	if (
		input.routingDecision.isGeneralistAgent &&
		input.routingDecision.delegationMode === "complete-task"
	) {
		// If task requires MCP tools and agent doesn't have MCP access, decompose instead
		if (taskRequiresMcp.requiresMcp && !agentHasMcpAccess) {
			console.log(
				"[Orchestrator] Task requires MCP tools but agent doesn't have MCP access - decomposing task",
			);
			console.log(
				`[Orchestrator] MCP tools needed: ${taskRequiresMcp.mcpToolsNeeded.join(", ")}`,
			);
			// Fall through to LLM-based planning
		} else {
			return createGeneralistPlan(input);
		}
	}

	// Use LLM-based planning for task decomposition
	console.log(
		"[Orchestrator] Using LLM-based planning for task decomposition",
	);

	const model = await getAiModel(input.userId, input.organizationId);

	// ==========================================================================
	// OPTIMIZATION: Use matched tools from routing semantic search
	// No need to connect to MCP servers again - routing already found relevant tools
	// This saves ~500ms+ per MCP config connection
	// ==========================================================================
	const matchedMcpTools = input.routingDecision.matchedMcpTools || [];

	// Tool names from semantic search are sufficient for task planning prompt
	const toolNames: string[] = matchedMcpTools.map((t) => t.toolName);

	if (toolNames.length > 0) {
		console.log(
			"[createTaskPlan] Using matched MCP tools from routing (no reconnection needed)",
			{
				toolCount: toolNames.length,
				tools: toolNames.slice(0, 10),
			},
		);
	} else {
		console.log("[createTaskPlan] No matched MCP tools from routing");
	}

	// ==========================================================================
	// USE SEMANTIC SEARCH RESULTS FROM ROUTING
	// Instead of loading all agents from database, use matchedAgents from routing
	// This provides token-efficient planning with only relevant capabilities
	// ==========================================================================
	let agentDescriptions = "";
	const matchedAgents = input.routingDecision.matchedAgents || [];
	// matchedMcpTools already declared above
	const matchedIntegrations = input.routingDecision.matchedIntegrations || [];
	const userIntent = input.routingDecision.userIntent;

	// Build agent descriptions from semantic search results
	if (matchedAgents.length > 0) {
		agentDescriptions = matchedAgents
			.map((agent) => {
				const skillsList =
					agent.skills.length > 0 ? agent.skills.join(", ") : "";
				const limitationsNote = agent.limitations?.length
					? ` [Limitations: ${agent.limitations.join(", ")}]`
					: "";
				return `  - "${agent.agentId}": ${agent.description}${skillsList ? ` (Skills: ${skillsList})` : ""}${limitationsNote} [Confidence: ${Math.round(agent.confidence * 100)}%]`;
			})
			.join("\n");

		console.log(
			"[Orchestrator] Using matched agents from semantic search:",
			{
				count: matchedAgents.length,
				agents: matchedAgents.map((a) => a.agentId),
			},
		);
	} else {
		// Fallback: load from database if no matches from routing
		console.log(
			"[Orchestrator] No matched agents from routing - loading from database",
		);
		try {
			const allAgents = await db.agent.findMany({
				where: {
					OR: [
						{ scope: "SYSTEM" as const },
						...(input.organizationId
							? [
									{
										organizationId: input.organizationId,
										scope: "ORGANIZATION" as const,
									},
								]
							: [
									{
										userId: input.userId,
										organizationId: null,
										scope: "USER" as const,
									},
								]),
					],
					status: "ACTIVE",
				},
				take: 10,
			});

			// Filter by enabled agent IDs if provided
			const filteredAgents = input.enabledAgentIds
				? allAgents.filter((a) =>
						input.enabledAgentIds?.includes(a.agentId),
					)
				: allAgents;

			if (filteredAgents.length > 0) {
				agentDescriptions = filteredAgents
					.map((agent) => {
						const metadata = agent.metadata as Record<
							string,
							unknown
						> | null;
						const skills =
							(metadata?.skills as Array<{
								name: string;
								description?: string;
							}>) || [];
						const skillsList =
							skills.length > 0
								? skills.map((s) => s.name).join(", ")
								: "";
						return `  - "${agent.agentId}": ${agent.description || agent.displayName}${skillsList ? ` (Skills: ${skillsList})` : ""}`;
					})
					.join("\n");
			}
		} catch (e) {
			console.warn(
				"[Orchestrator] Failed to load agents for task planning",
				e,
			);
		}
	}

	// Build MCP tool descriptions from semantic search results
	// IMPORTANT: Include inputSchema so the planner knows what parameters each tool requires
	let mcpToolDescriptions = "";
	if (matchedMcpTools.length > 0) {
		mcpToolDescriptions = matchedMcpTools
			.map((tool) => {
				// Build schema info string if available - this is critical for correct parameter usage
				let schemaInfo = "";
				if (tool.inputSchema) {
					const schema = tool.inputSchema as {
						properties?: Record<string, unknown>;
						required?: string[];
					};
					if (schema.properties) {
						const requiredParams = schema.required || [];
						const paramList = Object.entries(schema.properties)
							.map(([name, def]) => {
								const isRequired =
									requiredParams.includes(name);
								const paramDef = def as {
									type?: string;
									description?: string;
								};
								const typeInfo = paramDef.type || "any";
								const desc = paramDef.description
									? ` - ${paramDef.description}`
									: "";
								// Mark required params clearly so LLM knows which are mandatory
								return `    - ${name}${isRequired ? " [REQUIRED]" : ""}: ${typeInfo}${desc}`;
							})
							.join("\n");
						schemaInfo = `\n  Parameters:\n${paramList}`;
					}
				}
				return `  - "${tool.toolName}": ${tool.description || tool.reason} [Confidence: ${Math.round(tool.confidence * 100)}%]${schemaInfo}`;
			})
			.join("\n\n");

		console.log(
			"[Orchestrator] Using matched MCP tools from semantic search:",
			{
				count: matchedMcpTools.length,
				tools: matchedMcpTools.map((t) => t.toolName),
				hasSchemas: matchedMcpTools.filter((t) => t.inputSchema).length,
			},
		);
	} else if (toolNames.length > 0) {
		// Fallback to basic tool names if no semantic matches
		mcpToolDescriptions = toolNames.slice(0, 20).join(", ");
	}

	// ==========================================================================
	// BUILD INTEGRATION DESCRIPTIONS FROM ROUTING
	// Integrations are connected services like Slack, GitHub, Email that can be
	// used for messaging/notifications. These are DIFFERENT from MCP tools.
	// ==========================================================================
	let integrationDescriptions = "";
	if (matchedIntegrations.length > 0) {
		integrationDescriptions = matchedIntegrations
			.map((integration) => {
				const capabilitiesList = integration.capabilities?.length
					? ` (Capabilities: ${integration.capabilities.slice(0, 5).join(", ")})`
					: "";
				return `  - "${integration.name}" [${integration.provider}]: ${integration.description}${capabilitiesList} [Confidence: ${Math.round(integration.confidence * 100)}%]`;
			})
			.join("\n");

		console.log(
			"[Orchestrator] Using matched integrations from semantic search:",
			{
				count: matchedIntegrations.length,
				integrations: matchedIntegrations.map(
					(i) => `${i.name} (${i.provider})`,
				),
			},
		);
	}

	// Add user intent guidance if detected
	let userIntentGuidance = "";
	if (userIntent) {
		const intentParts: string[] = [];
		if (userIntent.requestedWorkspace) {
			intentParts.push(
				"User explicitly requested WORKSPACE document access - include workspace retrieval step",
			);
		}
		if (userIntent.requestedWorkflow) {
			intentParts.push(
				"User explicitly requested WORKFLOW execution - use workflow trigger step",
			);
		}
		if (userIntent.requestedMcpTools) {
			intentParts.push(
				"User explicitly requested MCP TOOL usage - prioritize MCP tools for execution",
			);
		}
		if (userIntent.requestedAgent) {
			intentParts.push(
				`User explicitly requested agent: ${userIntent.requestedAgent}`,
			);
		}
		if (intentParts.length > 0) {
			userIntentGuidance = `\n\n**USER INTENT (MUST RESPECT):**\n${intentParts.join("\n")}`;
		}
	}

	// Add prioritization guidance if user has starred/prioritized capabilities
	let prioritizationGuidance = "";
	const prioritized = input.routingDecision.prioritizedCapabilities;

	// Also check input-level prioritization (starred tools)
	const hasPrioritizedTools = input.prioritizedToolIds?.length;
	const hasPrioritizedServers = input.prioritizedMcpConfigIds?.length;

	if (prioritized || hasPrioritizedTools || hasPrioritizedServers) {
		const prefParts: string[] = [];
		if (prioritized?.mcpServers?.length) {
			prefParts.push(
				`- STARRED MCP servers: ${prioritized.mcpServers.join(", ")}`,
			);
		}
		if (prioritized?.tools?.length) {
			prefParts.push(`- STARRED tools: ${prioritized.tools.join(", ")}`);
		}
		if (prioritized?.agents?.length) {
			prefParts.push(
				`- STARRED agents: ${prioritized.agents.join(", ")}`,
			);
		}

		// Also add from input if not already in routing decision
		if (hasPrioritizedTools && !prioritized?.tools?.length) {
			prefParts.push(
				`- STARRED tools (IDs): ${input.prioritizedToolIds?.join(", ")}`,
			);
		}

		if (prefParts.length > 0) {
			prioritizationGuidance = `\n\n**⭐ USER STARRED PREFERENCES (MUST USE THESE WHEN APPLICABLE):**\nThe user has STARRED these capabilities - use them preferentially:\n${prefParts.join("\n")}\n\n**IMPORTANT**: When planning steps, ALWAYS use tools from starred MCP servers if they can accomplish the task. Only use other tools if starred tools cannot handle the specific operation.`;
			console.log(
				"[Orchestrator] Added prioritization guidance to planner:",
				{
					prioritized,
					inputPrioritizedTools: input.prioritizedToolIds,
				},
			);
		}
	}

	// Build agent delegation guidance with all matched capabilities
	const agentDelegationGuidance = `
=== AVAILABLE CAPABILITIES (from semantic search) ===
${userIntentGuidance}${prioritizationGuidance}

**Specialized Agents for Delegation:**
${agentDescriptions || "No matched agents available"}

**MCP Tools for Direct Execution:**
${mcpToolDescriptions || "No matched MCP tools available"}

**Workflow Integrations (Messaging/Notifications):**
${integrationDescriptions || "No matched integrations available"}

**Priority Order (follow this):**
1. MCP Tools - Use when direct API calls can accomplish the task (fastest, most deterministic)
2. Workflow Integrations - Use for Slack/email/webhook notifications when integrations are available
3. Specialized Agents - Use when task requires domain expertise (document generation, planning)
4. Workflows - Use when user explicitly requests or task matches pre-defined workflow
5. LLM Generation - Use for simple text generation that doesn't need tools
6. CUGA (Browser/Code) - Use only when browser automation or code execution is required

**IMPORTANT**: When the task involves posting to Slack, sending emails, or notifications:
- ALWAYS check "Workflow Integrations" section first
- Use capability: "integration" with the integration name as "app"
- Do NOT say "would be performed if integration were available" when integrations ARE listed above
`;

	// Load and render the task planning system prompt from templates
	const systemPrompt = getTaskPlanningSystemPrompt({
		agentDelegationGuidance,
		conversationHistory: input.history,
	});

	// Build user prompt - prepend starred preferences if any
	let userMessage = input.message;
	if (prioritized?.mcpServers?.length || prioritized?.tools?.length) {
		const starredParts: string[] = [];
		if (prioritized.mcpServers?.length) {
			starredParts.push(
				`USE servers: ${prioritized.mcpServers.join(", ")}`,
			);
		}
		if (prioritized.tools?.length) {
			starredParts.push(`USE tools: ${prioritized.tools.join(", ")}`);
		}
		userMessage = `[STARRED: ${starredParts.join("; ")}]\n\n${input.message}`;
		console.log(
			"[Orchestrator] Enhanced planning prompt with starred tools:",
			starredParts,
		);
	}

	// Append image context if images are attached
	if (input.attachedImageUrls?.length) {
		userMessage += `\n\n[ATTACHED IMAGES: ${input.attachedImageUrls.length} image(s). Storage paths: ${input.attachedImageUrls.join(", ")}. When planning image editing steps, pass the storage path as inputImage parameter to fabric_generate_image.]`;
	}

	const response = await generateText({
		model,
		system: systemPrompt,
		prompt: `Task: ${userMessage}\nRouting: ${input.routingDecision.primaryAgent} (${input.routingDecision.reasoning})`,
	});

	const content = response.text || "[]";
	const parsed = safeParseJson<TaskStep[]>(content, "array") || [];
	let steps: TaskStep[] = [];

	console.log("[Orchestrator] Task planning response parsed:", {
		rawLength: content.length,
		parsedStepCount: parsed.length,
		firstStepSample: parsed[0]
			? {
					id: parsed[0].id,
					description: parsed[0].description,
					capability: parsed[0].capability,
					app: parsed[0].app,
				}
			: null,
		rawResponseSample: content.slice(0, 500),
	});

	if (parsed.length > 0) {
		steps = parsed.map((step: any, idx: number) =>
			normalizeStep(step, idx, input.routingDecision.primaryAgent),
		);
	}

	// Ensure at least one step
	if (steps.length === 0) {
		steps = [createFallbackStep(input)];
	}

	// ==========================================================================
	// STEP-ASSIGNER: Apply priority-based executor assignment
	// Uses matched capabilities from semantic search to optimize step execution
	// Priority: MCP > Integration > Agent > Workflow > LLM > Web (CUGA)
	// NOTE: Skip presentation/synthesis steps - they should stay as LLM capability
	// ==========================================================================
	if (
		matchedAgents.length > 0 ||
		matchedMcpTools.length > 0 ||
		matchedIntegrations.length > 0
	) {
		const capabilities = buildCapabilityMatches(
			matchedAgents,
			matchedMcpTools,
			matchedIntegrations,
		);
		// Pass original user message for better intent matching
		// This helps when LLM-generated step descriptions don't capture exact user intent
		const assignments = assignStepExecutors(
			steps,
			capabilities,
			input.message,
		);

		// Apply assignments to steps
		for (const assignment of assignments) {
			const step = steps.find((s) => s.id === assignment.stepId);
			if (step && assignment.confidence > 0.4) {
				// Skip presentation/synthesis steps - they should use LLM capability
				const isPresentationStep =
					step.capability === "llm" ||
					step.type === "generate" ||
					step.description.toLowerCase().includes("present") ||
					step.description.toLowerCase().includes("summarize") ||
					step.description.toLowerCase().includes("synthesize") ||
					step.description.toLowerCase().includes("format") ||
					step.description.toLowerCase().includes("display");

				if (isPresentationStep) {
					console.log(
						`[Orchestrator] Step-assigner: Skipping presentation step ${step.id}`,
					);
					continue;
				}

				// Override executor if assignment has higher confidence
				// ALSO override if step is trying to use MCP for something that should be an integration
				const shouldOverride =
					!step.executor ||
					assignment.confidence > 0.6 ||
					// Force override if step mentions an integration name but has mcp capability
					(assignment.assignedExecutor.type === "integration" &&
						(step.capability === "mcp_tool" ||
							step.app?.includes(
								assignment.assignedExecutor.id,
							)));

				if (shouldOverride) {
					step.executor = assignment.assignedExecutor.id;
					step.capability = assignment.assignedExecutor.type as any;
					step.app = assignment.assignedExecutor.id;

					// IMPORTANT: Preserve higher risk levels from step detection
					// The normalizeStep function detects destructive operations (delete, create, update)
					// and assigns appropriate risk levels. The capability-based assignment should NOT
					// override a higher risk level with a lower one.
					const riskOrder: Record<string, number> = {
						low: 1,
						medium: 2,
						high: 3,
						critical: 4,
					};
					const stepRiskValue =
						riskOrder[step.riskLevel || "low"] || 1;
					const assignmentRiskValue =
						riskOrder[assignment.riskLevel || "low"] || 1;

					// Only update risk level if assignment has HIGHER risk
					if (assignmentRiskValue > stepRiskValue) {
						step.riskLevel = assignment.riskLevel;
					}

					// Never override requiresApproval=true with false
					// If step was marked as requiring approval (due to destructive operation), keep it
					if (assignment.requiresApproval && !step.requiresApproval) {
						step.requiresApproval = assignment.requiresApproval;
					}

					console.log(
						`[Orchestrator] Step-assigner: ${step.id} -> ${assignment.assignedExecutor.type}:${assignment.assignedExecutor.id} (confidence: ${(assignment.confidence * 100).toFixed(0)}%, risk: ${step.riskLevel}, approval: ${step.requiresApproval})`,
					);
				}
			}
		}
	}

	// ==========================================================================
	// ENSURE FINAL PRESENTATION STEP
	// Every plan should end with a step that synthesizes and presents results
	// in a user-friendly format (tables, charts, grids, summaries, etc.)
	// This ensures the user always gets a nicely formatted response.
	// ==========================================================================
	steps = ensureFinalPresentationStep(steps, input.message);

	// SECURITY: Use clean description without document content for display/storage
	const cleanDescription = createPlanDescription(input.message);

	const planDurationMs = Date.now() - planStartTime;
	console.log(`[Orchestrator] Task plan created in ${planDurationMs}ms`, {
		steps: steps.length,
		strategy: input.routingDecision.suggestedStrategy,
	});

	return {
		id: `plan-${Date.now()}`,
		description: cleanDescription,
		steps,
		riskLevel: input.routingDecision.riskLevel,
		strategy: input.routingDecision.suggestedStrategy,
		createdAt: new Date().toISOString(),
	};
}

/**
 * Builds CapabilityMatch array from semantic search results.
 * Used by step-assigner for priority-based executor assignment.
 */
function buildCapabilityMatches(
	matchedAgents: Array<{
		agentId: string;
		displayName: string;
		description: string;
		skills: string[];
		limitations?: string[];
		confidence: number;
		reason: string;
	}>,
	matchedMcpTools: Array<{
		configId: string;
		toolName: string;
		description?: string;
		confidence: number;
		reason: string;
	}>,
	matchedIntegrations: Array<{
		integrationId: string;
		name: string;
		provider: string;
		description: string;
		confidence: number;
		reason: string;
		capabilities: string[];
	}> = [],
): CapabilityMatch[] {
	const matches: CapabilityMatch[] = [];

	// Add MCP tools (highest priority)
	for (const tool of matchedMcpTools) {
		matches.push({
			capability: {
				id: tool.toolName,
				type: "mcp_tool",
				name: tool.toolName,
				description: tool.description || tool.reason,
				skills: [],
				inputTypes: [],
				outputTypes: [],
				riskLevel: "medium",
				requiresApproval: false,
				isAvailable: true,
				healthStatus: "healthy",
			},
			score: tool.confidence,
			matchedNeeds: [tool.reason],
			suggestedUse: tool.reason,
		});
	}

	// Add integrations (second priority - for messaging/notifications)
	for (const integration of matchedIntegrations) {
		matches.push({
			capability: {
				id: integration.name,
				type: "integration",
				name: integration.name,
				description: integration.description,
				skills: integration.capabilities,
				inputTypes: [],
				outputTypes: [],
				riskLevel: "low",
				requiresApproval: false,
				isAvailable: true,
				healthStatus: "healthy",
			},
			score: integration.confidence,
			matchedNeeds: integration.capabilities,
			suggestedUse: integration.reason,
		});
	}

	// Add agents (third priority)
	for (const agent of matchedAgents) {
		matches.push({
			capability: {
				id: agent.agentId,
				type: "agent",
				name: agent.displayName,
				description: agent.description,
				skills: agent.skills,
				inputTypes: [],
				outputTypes: [],
				riskLevel: agent.agentId === "cuga_generalist" ? "high" : "low",
				requiresApproval: agent.agentId === "cuga_generalist",
				isAvailable: true,
				healthStatus: "healthy",
				agentCapabilities: {
					limitations: agent.limitations,
				},
			},
			score: agent.confidence,
			matchedNeeds: agent.skills,
			suggestedUse: agent.reason,
		});
	}

	return matches;
}

/**
 * Creates a single-step plan for generalist agents.
 * Includes enhanced risk assessment for autonomous execution.
 */
function createGeneralistPlan(input: CreateTaskPlanInput): TaskPlan {
	console.log(
		`[Orchestrator] Generalist agent detected (${input.routingDecision.primaryAgent}) - skipping step decomposition`,
	);
	console.log(
		"[Orchestrator] Creating single-step plan for complete-task delegation",
	);

	const capabilities = input.routingDecision.agentCapabilities || {};

	// Enhanced risk assessment for generalist delegation
	const riskFactors: string[] = [
		...(input.routingDecision.riskFactors || []),
	];
	let adjustedRiskLevel = input.routingDecision.riskLevel;
	let requiresApproval = false;

	// Factor 1: Code execution capability increases risk
	if (capabilities.codeExecution) {
		riskFactors.push("Agent can execute arbitrary code");
		if (adjustedRiskLevel === "low") {
			adjustedRiskLevel = "medium";
		}
	}

	// Factor 2: Browser automation capability increases risk
	if (capabilities.browserAutomation) {
		riskFactors.push("Agent can interact with web browsers");
		if (adjustedRiskLevel === "low") {
			adjustedRiskLevel = "medium";
		}
	}

	// Factor 3: Task-level autonomy
	if (
		capabilities.maxAutonomyLevel === "task" ||
		capabilities.maxAutonomyLevel === "session"
	) {
		riskFactors.push(
			`Agent has ${capabilities.maxAutonomyLevel}-level autonomy`,
		);
	}

	// Factor 4: Check task description for high-risk operations
	const taskLower = input.message.toLowerCase();
	if (
		taskLower.includes("delete") ||
		taskLower.includes("remove") ||
		taskLower.includes("destroy")
	) {
		riskFactors.push("Task involves deletion operations");
		adjustedRiskLevel = "critical";
		requiresApproval = true;
	} else if (
		taskLower.includes("create") ||
		taskLower.includes("add") ||
		taskLower.includes("insert")
	) {
		riskFactors.push("Task involves creation operations");
		if (adjustedRiskLevel !== "critical") {
			adjustedRiskLevel = "high";
		}
		requiresApproval = true;
	} else if (
		taskLower.includes("update") ||
		taskLower.includes("modify") ||
		taskLower.includes("edit")
	) {
		riskFactors.push("Task involves modification operations");
		if (adjustedRiskLevel === "low") {
			adjustedRiskLevel = "medium";
		}
		requiresApproval = true;
	}

	// Factor 5: Financial or sensitive operations
	if (
		taskLower.includes("payment") ||
		taskLower.includes("billing") ||
		taskLower.includes("invoice")
	) {
		riskFactors.push("Task involves financial operations");
		adjustedRiskLevel = "critical";
		requiresApproval = true;
	}

	// Factor 6: Multi-tenancy awareness
	if (!capabilities.multiTenancyAware) {
		riskFactors.push(
			"Agent is not multi-tenancy aware - data isolation not guaranteed",
		);
	}

	// Require approval for high/critical risk
	if (adjustedRiskLevel === "high" || adjustedRiskLevel === "critical") {
		requiresApproval = true;
	}

	console.log("[Orchestrator] Generalist delegation risk assessment:", {
		originalRisk: input.routingDecision.riskLevel,
		adjustedRisk: adjustedRiskLevel,
		riskFactors,
		requiresApproval,
	});

	// SECURITY: Parse message to separate user intent from document content
	// User intent is used for display/storage, full message for execution
	const parsed = parseMessage(input.message);
	const cleanDescription = createCleanDescription(parsed.userIntent, 200);

	// Build steps: execution step + presentation step
	const executionStep: TaskStep = {
		id: "complete-task-delegation",
		description: cleanDescription,
		type: "generate",
		status: "pending",
		order: 1,
		executor: input.routingDecision.primaryAgent,
		riskLevel: adjustedRiskLevel,
		requiresApproval,
		inputs: {
			delegationMode: "complete-task",
			preserveContext: capabilities.contextPreservation || false,
			agentCapabilities: capabilities,
			// IMPORTANT: Full message with documents is passed here for execution
			originalTaskDescription: input.message,
			riskFactors,
		},
	};

	// Add presentation step to ensure nicely formatted output
	const presentationStep: TaskStep = {
		id: "present-results",
		description:
			"Present results: Format and summarize the output for the user",
		type: "generate",
		status: "pending",
		order: 2,
		executor: undefined, // LLM handles presentation
		capability: "llm",
		riskLevel: "low",
		requiresApproval: false,
		inputs: {
			instructions:
				"Take the results from the previous step and present them in a clear, user-friendly format. Use markdown formatting including tables for structured data, bullet points for lists, code blocks for technical content, and clear section headings. Ensure the response directly addresses what the user asked for.",
		},
		expectedOutput:
			"A well-formatted response that clearly presents the results to the user",
	};

	return {
		id: `plan-${Date.now()}`,
		description: cleanDescription,
		steps: [executionStep, presentationStep],
		riskLevel: adjustedRiskLevel,
		strategy: input.routingDecision.suggestedStrategy,
		createdAt: new Date().toISOString(),
		metadata: {
			isGeneralistDelegation: true,
			delegationMode: "complete-task",
			agentCapabilities: capabilities,
			riskAssessment: {
				originalRisk: input.routingDecision.riskLevel,
				adjustedRisk: adjustedRiskLevel,
				riskFactors,
			},
		},
	};
}

/**
 * Normalizes a step from LLM output, auto-detecting risk levels.
 * Uses the centralized operation-risk-detector for robust detection.
 */
function normalizeStep(
	step: any,
	idx: number,
	_defaultExecutor: string,
): TaskStep {
	// Log incoming step for debugging
	if (!step.description) {
		console.warn(`[normalizeStep] Step ${idx + 1} missing description:`, {
			rawStep: JSON.stringify(step).slice(0, 300),
			stepKeys: Object.keys(step),
		});
	}

	// Build a meaningful description from available step data
	let description = step.description;
	if (
		!description ||
		description.trim() === "" ||
		/^Step \d+$/.test(description)
	) {
		// Try to construct a description from other fields
		const parts: string[] = [];
		if (step.capability) {
			parts.push(`Use ${step.capability}`);
		}
		if (step.app) {
			parts.push(`via ${step.app}`);
		}
		if (step.expectedOutput) {
			parts.push(`to ${step.expectedOutput}`);
		}

		if (parts.length > 0) {
			description = parts.join(" ");
		} else {
			description = `Step ${idx + 1}`;
		}

		console.warn(
			`[normalizeStep] Constructed description for step ${idx + 1}: "${description}"`,
		);
	}

	const executor = step.executor ? String(step.executor) : null;
	const stepType = step.type || "api";

	// Use centralized risk detector for robust, defense-in-depth detection
	// This handles negation, word boundaries, tool patterns, and defaults to safe behavior
	const riskAssessment: RiskAssessment = detectOperationRisk({
		description,
		executor,
		toolNames: step.toolsToUse || [],
		stepType,
	});

	// Log risk assessment for debugging and audit
	console.log(
		`[normalizeStep] Step "${description.substring(0, 50)}..." risk assessment:`,
		{
			operationType: riskAssessment.operationType,
			riskLevel: riskAssessment.riskLevel,
			requiresApproval: riskAssessment.requiresApproval,
			confidence: riskAssessment.confidence,
			matchedPatterns: riskAssessment.matchedPatterns,
		},
	);

	// Use detected values, but allow LLM to override to HIGHER risk (never lower)
	let detectedRiskLevel = riskAssessment.riskLevel;
	let requiresApproval = riskAssessment.requiresApproval;

	// If LLM specified a risk level, use the HIGHER of the two (defense in depth)
	if (step.riskLevel) {
		const riskPriority: Record<string, number> = {
			critical: 4,
			high: 3,
			medium: 2,
			low: 1,
		};
		const llmRisk = step.riskLevel.toLowerCase();
		if (
			(riskPriority[llmRisk] || 0) >
			(riskPriority[detectedRiskLevel] || 0)
		) {
			detectedRiskLevel = llmRisk as typeof detectedRiskLevel;
		}
	}

	// If LLM says approval is required, always respect that (can only escalate, not de-escalate)
	if (step.requiresApproval === true) {
		requiresApproval = true;
	}

	// Research steps should NOT have an agent executor
	const finalExecutor =
		stepType === "research" ? undefined : executor || undefined;

	// Determine capability
	let capability = step.capability;
	if (!capability) {
		if (finalExecutor) {
			capability = "agent";
		} else if (stepType === "research") {
			capability = step.toolsToUse?.some(
				(t: string) => t.includes("firecrawl") || t.includes("scrape"),
			)
				? "web"
				: "mcp_tool";
		} else if (stepType === "generate" && !finalExecutor) {
			capability = "llm";
		} else {
			capability = "mcp_tool";
		}
	}

	return {
		id: step.id || `step-${idx + 1}`,
		description: step.description || `Step ${idx + 1}`,
		type: stepType,
		status: "pending" as const,
		order: step.order || idx + 1,
		executor: finalExecutor,
		inputs: step.inputs,
		riskLevel: detectedRiskLevel,
		requiresApproval,
		capability,
		app: step.app || finalExecutor || step.toolsToUse?.[0],
		toolsToUse: step.toolsToUse,
		expectedOutput: step.expectedOutput,
		iterateOver: step.iterateOver,
	};
}

/**
 * Creates a fallback step when no steps could be parsed.
 */
function createFallbackStep(input: CreateTaskPlanInput): TaskStep {
	// SECURITY: Use clean description without document content
	const parsed = parseMessage(input.message);
	const userIntentLower = parsed.userIntent.toLowerCase();
	const cleanDescription = createCleanDescription(parsed.userIntent, 150);

	const isWriteOperation =
		userIntentLower.includes("create") ||
		userIntentLower.includes("add") ||
		userIntentLower.includes("insert") ||
		userIntentLower.includes("post") ||
		userIntentLower.includes("update") ||
		userIntentLower.includes("modify") ||
		userIntentLower.includes("edit") ||
		userIntentLower.includes("change") ||
		userIntentLower.includes("delete") ||
		userIntentLower.includes("remove");

	let fallbackRiskLevel: "low" | "medium" | "high" | "critical" =
		input.routingDecision.riskLevel;
	let fallbackRequiresApproval = false;

	if (
		userIntentLower.includes("delete") ||
		userIntentLower.includes("remove") ||
		userIntentLower.includes("destroy")
	) {
		fallbackRiskLevel = "critical";
		fallbackRequiresApproval = true;
	} else if (
		userIntentLower.includes("create") ||
		userIntentLower.includes("add") ||
		userIntentLower.includes("new")
	) {
		fallbackRiskLevel = "high";
		fallbackRequiresApproval = true;
	} else if (
		userIntentLower.includes("update") ||
		userIntentLower.includes("modify") ||
		userIntentLower.includes("edit")
	) {
		fallbackRiskLevel = "medium";
		fallbackRequiresApproval = true;
	} else if (isWriteOperation) {
		fallbackRiskLevel = "medium";
		fallbackRequiresApproval = true;
	}

	return {
		id: "step-1",
		description: isWriteOperation
			? `Execute: ${cleanDescription}`
			: "Execute task",
		type: input.routingDecision.suggestedStrategy,
		status: "pending",
		order: 1,
		executor: input.routingDecision.primaryAgent,
		riskLevel: fallbackRiskLevel,
		requiresApproval: fallbackRequiresApproval,
	};
}

/**
 * Checks if a task requires MCP tools based on semantic tool search results.
 *
 * REFACTORED: Removed hardcoded pattern matching. Now relies entirely on
 * the semantic tool search performed during routing (analyze-and-route.ts).
 * This provides more accurate matching and supports any MCP server without
 * requiring code changes.
 *
 * The routing phase uses the Tool Search Tool to find relevant MCP tools
 * based on semantic similarity, and stores matches in matchedMcpTools.
 */
async function checkIfTaskRequiresMcpTools(
	input: CreateTaskPlanInput,
): Promise<{ requiresMcp: boolean; mcpToolsNeeded: string[] }> {
	const mcpToolsNeeded: string[] = [];

	// Use matched MCP tools from semantic search in routing phase
	// matchedMcpTools is populated by searchAvailableTools() in analyze-and-route.ts
	if (
		input.routingDecision.matchedMcpTools &&
		input.routingDecision.matchedMcpTools.length > 0
	) {
		for (const tool of input.routingDecision.matchedMcpTools) {
			mcpToolsNeeded.push(tool.toolName);
		}
	}

	// Check if routing determined MCP direct mode should be used
	if (input.routingDecision.useMcpDirect) {
		// The routing already determined MCP tools should be used directly
		// If no specific tools matched, this indicates the semantic search
		// found high-confidence MCP tool matches
		if (mcpToolsNeeded.length === 0) {
			mcpToolsNeeded.push("mcp-direct");
		}
	}

	const requiresMcp = mcpToolsNeeded.length > 0;

	if (requiresMcp) {
		console.log("[Orchestrator] Task requires MCP tools:", mcpToolsNeeded);
	}

	return { requiresMcp, mcpToolsNeeded };
}

/**
 * Ensures the plan has a final presentation step.
 *
 * Every plan should end with a step that synthesizes and presents results
 * in a user-friendly format. This ensures users always get nicely formatted
 * responses with tables, charts, grids, or other appropriate visualizations.
 *
 * The presentation step:
 * - Analyzes the output type of previous steps
 * - Formats data appropriately (tables for lists, charts for metrics, etc.)
 * - Provides a clear summary of what was accomplished
 * - Uses markdown formatting for readability
 *
 * @param steps - The current plan steps
 * @param userMessage - The original user message to understand intent
 * @returns Updated steps array with presentation step
 */
function ensureFinalPresentationStep(
	steps: TaskStep[],
	userMessage: string,
): TaskStep[] {
	if (steps.length === 0) {
		return steps;
	}

	// Check if the last step is already a presentation/synthesis step
	const lastStep = steps[steps.length - 1];
	const isPresentationStep =
		lastStep.type === "generate" ||
		lastStep.description.toLowerCase().includes("present") ||
		lastStep.description.toLowerCase().includes("summarize") ||
		lastStep.description.toLowerCase().includes("synthesize") ||
		lastStep.description.toLowerCase().includes("format") ||
		lastStep.description.toLowerCase().includes("display") ||
		lastStep.description.toLowerCase().includes("show") ||
		lastStep.description.toLowerCase().includes("report") ||
		lastStep.description.toLowerCase().includes("output");

	// If already has a presentation step, return as-is
	if (isPresentationStep && steps.length >= 2) {
		console.log("[Orchestrator] Plan already has a presentation step");
		return steps;
	}

	// Determine the appropriate presentation format based on the task
	const messageLower = userMessage.toLowerCase();
	let presentationFormat = "formatted summary";
	let presentationHint =
		"Format the results clearly with appropriate headings and structure";

	if (
		messageLower.includes("list") ||
		messageLower.includes("show all") ||
		messageLower.includes("get all")
	) {
		presentationFormat = "table";
		presentationHint =
			"Present the results in a clean table format with relevant columns";
	} else if (
		messageLower.includes("compare") ||
		messageLower.includes("difference") ||
		messageLower.includes("versus")
	) {
		presentationFormat = "comparison table";
		presentationHint =
			"Create a side-by-side comparison table highlighting key differences";
	} else if (
		messageLower.includes("metric") ||
		messageLower.includes("stats") ||
		messageLower.includes("analytics") ||
		messageLower.includes("trend")
	) {
		presentationFormat = "metrics dashboard";
		presentationHint =
			"Present metrics with clear labels, using bullet points or a grid layout";
	} else if (
		messageLower.includes("timeline") ||
		messageLower.includes("history") ||
		messageLower.includes("log")
	) {
		presentationFormat = "timeline";
		presentationHint =
			"Present items in chronological order with dates and descriptions";
	} else if (
		messageLower.includes("search") ||
		messageLower.includes("find")
	) {
		presentationFormat = "search results";
		presentationHint =
			"Present search results with titles, descriptions, and relevance indicators";
	} else if (
		messageLower.includes("status") ||
		messageLower.includes("health") ||
		messageLower.includes("check")
	) {
		presentationFormat = "status report";
		presentationHint =
			"Present status with clear indicators (success/warning/error) and details";
	}

	// Create the presentation step
	const presentationStep: TaskStep = {
		id: `step-${steps.length + 1}`,
		description: `Present results: Synthesize and format the output as a ${presentationFormat}`,
		type: "generate",
		status: "pending",
		order: steps.length + 1,
		executor: undefined, // LLM will handle this
		capability: "llm",
		riskLevel: "low",
		requiresApproval: false,
		inputs: {
			presentationFormat,
			presentationHint,
			instructions: `Take the results from the previous steps and present them in a clear, user-friendly format. ${presentationHint}. Use markdown formatting including:
- Tables for structured data
- Bullet points for lists
- Code blocks for technical content
- Bold/italic for emphasis
- Clear section headings
Ensure the response directly addresses what the user asked for.`,
		},
		expectedOutput: `A well-formatted ${presentationFormat} that clearly presents the results to the user`,
	};

	// If we only have 1 step, add the presentation step
	// If the last step is not a presentation step, add one
	if (!isPresentationStep) {
		console.log("[Orchestrator] Adding final presentation step", {
			format: presentationFormat,
			totalSteps: steps.length + 1,
		});
		return [...steps, presentationStep];
	}

	// If we have a single presentation-type step, keep it but ensure minimum 2 steps
	// by marking the original task as step 1 and presentation as step 2
	if (steps.length === 1 && isPresentationStep) {
		// The single step is already presentation-like, which is fine for simple queries
		// But we should still ensure the response is well-formatted
		console.log(
			"[Orchestrator] Single presentation step detected, keeping as-is",
		);
		return steps;
	}

	return steps;
}
