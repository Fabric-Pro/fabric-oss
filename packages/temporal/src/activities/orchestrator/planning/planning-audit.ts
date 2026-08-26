/**
 * Planning Decision Audit Trail
 *
 * Tracks what influenced each planning decision to provide transparency
 * on why a plan was created in a specific way.
 *
 * Addresses the issue of erratic/inconsistent planning by:
 * 1. Recording all context sources used during planning
 * 2. Tracking memory vs. research decisions
 * 3. Providing visibility into planning rationale
 */

import { logger } from "@repo/logs";

// =============================================================================
// Types
// =============================================================================

export type ContextSourceType =
	| "user_input" // Direct user message
	| "workspace_rag" // RAG from attached workspaces
	| "semantic_memory" // Qdrant vector search results
	| "letta_memory" // Letta keyword memory
	| "trajectory_reuse" // Similar past execution
	| "negative_memory" // Failure avoidance
	| "web_research" // Fresh web research
	| "mcp_tool_discovery" // Discovered MCP tools
	| "agent_capabilities" // Agent capability metadata
	| "policy_enrichment"; // System policy rules

export interface ContextSource {
	type: ContextSourceType;
	/** Human-readable description */
	description: string;
	/** Confidence score if applicable (0-1) */
	confidence?: number;
	/** Specific data or snippet used */
	data?: unknown;
	/** Source identifier (e.g., workspace ID, agent ID) */
	sourceId?: string;
	/** Whether this source was actually used in planning */
	used: boolean;
	/** Why it was/wasn't used */
	usageReason?: string;
}

export interface PlanningDecision {
	/** Unique decision ID */
	id: string;
	/** Decision category */
	category:
		| "task_decomposition" // Whether to break into steps
		| "research_decision" // Whether to research first
		| "executor_selection" // Which agent/tool to use
		| "risk_assessment" // Risk level determination
		| "step_ordering" // Order of execution
		| "approval_requirement" // Which steps need approval
		| "memory_usage"; // Whether to use cached info

	/** The decision made */
	decision: string;
	/** Reasoning behind the decision */
	reasoning: string;
	/** Alternatives considered */
	alternatives?: Array<{
		option: string;
		whyNotChosen: string;
	}>;
	/** Confidence in this decision (0-1) */
	confidence: number;
	/** What influenced this decision */
	influencedBy: string[];
}

export interface PlanningAuditTrail {
	/** Execution ID this audit belongs to */
	executionId: string;
	/** Timestamp when planning started */
	planningStartedAt: Date;
	/** Timestamp when planning completed */
	planningCompletedAt?: Date;
	/** Total planning duration in ms */
	planningDurationMs?: number;

	/** User's original message */
	userMessage: string;
	/** Enriched message after policy */
	enrichedMessage?: string;

	/** All context sources consulted */
	contextSources: ContextSource[];
	/** Key decisions made during planning */
	decisions: PlanningDecision[];

	/** Summary for UI display */
	summary: PlanningAuditSummary;

	/** Raw routing decision for debugging */
	routingDecision?: Record<string, unknown>;
	/** Raw plan for debugging */
	plan?: Record<string, unknown>;
}

export interface PlanningAuditSummary {
	/** One-line summary of how the plan was created */
	headline: string;
	/** Key factors that influenced the plan */
	keyFactors: string[];
	/** Sources of information used */
	sourcesUsed: string[];
	/** Whether memory was consulted */
	usedMemory: boolean;
	/** Whether fresh research was done */
	usedResearch: boolean;
	/** Total context sources consulted */
	totalSourcesConsulted: number;
	/** Total decisions made */
	totalDecisions: number;
}

// =============================================================================
// Planning Audit Builder
// =============================================================================

/**
 * Builder for creating planning audit trails.
 */
export class PlanningAuditBuilder {
	private audit: PlanningAuditTrail;

	constructor(executionId: string, userMessage: string) {
		this.audit = {
			executionId,
			planningStartedAt: new Date(),
			userMessage,
			contextSources: [],
			decisions: [],
			summary: {
				headline: "",
				keyFactors: [],
				sourcesUsed: [],
				usedMemory: false,
				usedResearch: false,
				totalSourcesConsulted: 0,
				totalDecisions: 0,
			},
		};
	}

	/**
	 * Record a context source that was consulted.
	 */
	addContextSource(source: ContextSource): this {
		this.audit.contextSources.push(source);
		return this;
	}

	/**
	 * Record a planning decision.
	 */
	addDecision(decision: PlanningDecision): this {
		this.audit.decisions.push(decision);
		return this;
	}

	/**
	 * Set the enriched message after policy application.
	 */
	setEnrichedMessage(message: string): this {
		this.audit.enrichedMessage = message;
		return this;
	}

	/**
	 * Set the routing decision for debugging.
	 */
	setRoutingDecision(decision: Record<string, unknown>): this {
		this.audit.routingDecision = decision;
		return this;
	}

	/**
	 * Set the final plan for debugging.
	 */
	setPlan(plan: Record<string, unknown>): this {
		this.audit.plan = plan;
		return this;
	}

	/**
	 * Complete the audit and generate summary.
	 */
	complete(): PlanningAuditTrail {
		this.audit.planningCompletedAt = new Date();
		this.audit.planningDurationMs =
			this.audit.planningCompletedAt.getTime() -
			this.audit.planningStartedAt.getTime();

		// Generate summary
		this.audit.summary = this.generateSummary();

		logger.info("[PlanningAudit] Audit complete", {
			executionId: this.audit.executionId,
			sourcesConsulted: this.audit.contextSources.length,
			decisionsRecorded: this.audit.decisions.length,
			planningDurationMs: this.audit.planningDurationMs,
		});

		return this.audit;
	}

	/**
	 * Generate the audit summary.
	 */
	private generateSummary(): PlanningAuditSummary {
		const usedSources = this.audit.contextSources.filter((s) => s.used);
		const sourcesUsed = usedSources.map((s) => this.getSourceLabel(s.type));

		// Check what was used
		const usedMemory = usedSources.some(
			(s) =>
				s.type === "semantic_memory" ||
				s.type === "letta_memory" ||
				s.type === "trajectory_reuse",
		);
		const usedResearch = usedSources.some((s) => s.type === "web_research");

		// Key factors from decisions
		const keyFactors: string[] = [];
		for (const decision of this.audit.decisions) {
			if (decision.confidence >= 0.7) {
				keyFactors.push(decision.decision);
			}
		}

		// Generate headline
		const headline = this.generateHeadline(
			usedSources,
			usedMemory,
			usedResearch,
		);

		return {
			headline,
			keyFactors: keyFactors.slice(0, 5), // Top 5 factors
			sourcesUsed: [...new Set(sourcesUsed)],
			usedMemory,
			usedResearch,
			totalSourcesConsulted: this.audit.contextSources.length,
			totalDecisions: this.audit.decisions.length,
		};
	}

	/**
	 * Generate a headline explaining how the plan was created.
	 */
	private generateHeadline(
		usedSources: ContextSource[],
		usedMemory: boolean,
		usedResearch: boolean,
	): string {
		const parts: string[] = [];

		// Main approach
		if (usedSources.some((s) => s.type === "trajectory_reuse")) {
			parts.push("Reusing similar past execution");
		} else if (usedResearch) {
			parts.push("Created with fresh web research");
		} else if (usedMemory) {
			parts.push("Created using past experience");
		} else if (usedSources.some((s) => s.type === "workspace_rag")) {
			parts.push("Created using workspace knowledge");
		} else {
			parts.push("Created from analysis");
		}

		// Additional context
		const additionalContexts: string[] = [];
		if (usedSources.some((s) => s.type === "mcp_tool_discovery")) {
			additionalContexts.push("available tools");
		}
		if (usedSources.some((s) => s.type === "agent_capabilities")) {
			additionalContexts.push("agent capabilities");
		}
		if (usedSources.some((s) => s.type === "negative_memory")) {
			additionalContexts.push("avoiding past failures");
		}

		if (additionalContexts.length > 0) {
			parts.push(`with ${additionalContexts.join(", ")}`);
		}

		return parts.join(" ");
	}

	/**
	 * Get human-readable label for source type.
	 */
	private getSourceLabel(type: ContextSourceType): string {
		const labels: Record<ContextSourceType, string> = {
			user_input: "User Input",
			workspace_rag: "Workspace Documents",
			semantic_memory: "Past Executions",
			letta_memory: "Keyword Memory",
			trajectory_reuse: "Similar Trajectory",
			negative_memory: "Failure Avoidance",
			web_research: "Web Research",
			mcp_tool_discovery: "Available Tools",
			agent_capabilities: "Agent Capabilities",
			policy_enrichment: "System Policies",
		};
		return labels[type] || type;
	}

	/**
	 * Get the current audit state (for streaming updates).
	 */
	getCurrentState(): PlanningAuditTrail {
		return { ...this.audit };
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create audit entries for workspace RAG results.
 */
export function createWorkspaceRagSource(
	workspaceIds: string[],
	documentsFound: number,
	used: boolean,
	usageReason?: string,
): ContextSource {
	return {
		type: "workspace_rag",
		description: `Retrieved ${documentsFound} documents from ${workspaceIds.length} workspace(s)`,
		used,
		usageReason,
		sourceId: workspaceIds.join(","),
		data: { workspaceIds, documentsFound },
	};
}

/**
 * Create audit entry for semantic memory search.
 */
export function createSemanticMemorySource(
	resultsFound: number,
	topSimilarity: number,
	used: boolean,
	usageReason?: string,
): ContextSource {
	return {
		type: "semantic_memory",
		description: `Found ${resultsFound} similar past execution(s)`,
		confidence: topSimilarity,
		used,
		usageReason,
		data: { resultsFound, topSimilarity },
	};
}

/**
 * Create audit entry for Letta memory.
 */
export function createLettaMemorySource(
	suggestionsFound: number,
	used: boolean,
	usageReason?: string,
): ContextSource {
	return {
		type: "letta_memory",
		description: `Found ${suggestionsFound} keyword-based suggestion(s)`,
		used,
		usageReason,
		data: { suggestionsFound },
	};
}

/**
 * Create audit entry for trajectory reuse.
 */
export function createTrajectoryReuseSource(
	trajectoryId: string,
	similarity: number,
	used: boolean,
	usageReason?: string,
): ContextSource {
	return {
		type: "trajectory_reuse",
		description: "Found matching trajectory from past execution",
		confidence: similarity,
		used,
		usageReason,
		sourceId: trajectoryId,
		data: { trajectoryId, similarity },
	};
}

/**
 * Create audit entry for negative memory check.
 */
export function createNegativeMemorySource(
	failuresFound: number,
	used: boolean,
	usageReason?: string,
): ContextSource {
	return {
		type: "negative_memory",
		description: `Found ${failuresFound} similar past failure(s) to avoid`,
		used,
		usageReason,
		data: { failuresFound },
	};
}

/**
 * Create audit entry for MCP tool discovery.
 */
export function createMcpToolSource(
	toolsFound: number,
	toolsUsed: string[],
	used: boolean,
): ContextSource {
	return {
		type: "mcp_tool_discovery",
		description: `Discovered ${toolsFound} available MCP tool(s)`,
		used,
		usageReason: used
			? `Using: ${toolsUsed.join(", ")}`
			: "No matching tools needed",
		data: { toolsFound, toolsUsed },
	};
}

/**
 * Create decision entry for research vs memory choice.
 */
export function createResearchDecision(
	doResearch: boolean,
	reasoning: string,
	confidence: number,
	alternatives?: PlanningDecision["alternatives"],
): PlanningDecision {
	return {
		id: `decision-research-${Date.now()}`,
		category: "research_decision",
		decision: doResearch
			? "Perform fresh web research"
			: "Use existing knowledge",
		reasoning,
		confidence,
		alternatives,
		influencedBy: doResearch
			? [
					"No relevant past executions",
					"Topic requires current information",
				]
			: [
					"Similar past execution found",
					"Topic covered in workspace docs",
				],
	};
}

/**
 * Create decision entry for task decomposition.
 */
export function createDecompositionDecision(
	decompose: boolean,
	stepCount: number,
	reasoning: string,
	confidence: number,
): PlanningDecision {
	return {
		id: `decision-decomposition-${Date.now()}`,
		category: "task_decomposition",
		decision: decompose
			? `Break task into ${stepCount} step(s)`
			: "Execute as single step via generalist agent",
		reasoning,
		confidence,
		influencedBy: decompose
			? ["Complex multi-part task", "Multiple tools/agents needed"]
			: [
					"Simple single-purpose task",
					"Generalist agent can handle entirely",
				],
	};
}

/**
 * Create decision entry for executor selection.
 */
export function createExecutorDecision(
	executor: string,
	executorType: "agent" | "mcp_tool" | "workflow" | "llm",
	reasoning: string,
	confidence: number,
	alternatives?: PlanningDecision["alternatives"],
): PlanningDecision {
	return {
		id: `decision-executor-${Date.now()}`,
		category: "executor_selection",
		decision: `Use ${executorType}: ${executor}`,
		reasoning,
		confidence,
		alternatives,
		influencedBy: [
			"Best match for task type",
			`${executorType} has required capabilities`,
		],
	};
}

// =============================================================================
// Activity Functions
// =============================================================================

/**
 * Create a new planning audit builder.
 */
export function createPlanningAuditBuilder(
	executionId: string,
	userMessage: string,
): PlanningAuditBuilder {
	return new PlanningAuditBuilder(executionId, userMessage);
}

/**
 * Format audit trail for UI display.
 */
export function formatAuditForDisplay(audit: PlanningAuditTrail): {
	headline: string;
	details: Array<{ label: string; value: string; icon?: string }>;
	decisions: Array<{
		title: string;
		description: string;
		confidence: number;
	}>;
} {
	const details: Array<{ label: string; value: string; icon?: string }> = [];

	// Add source information
	for (const source of audit.contextSources.filter((s) => s.used)) {
		details.push({
			label: source.type
				.replace(/_/g, " ")
				.replace(/\b\w/g, (l) => l.toUpperCase()),
			value: source.description,
			icon: getSourceIcon(source.type),
		});
	}

	// Format decisions
	const decisions = audit.decisions.map((d) => ({
		title: d.decision,
		description: d.reasoning,
		confidence: d.confidence,
	}));

	return {
		headline: audit.summary.headline,
		details,
		decisions,
	};
}

function getSourceIcon(type: ContextSourceType): string {
	const icons: Record<ContextSourceType, string> = {
		user_input: "💬",
		workspace_rag: "📁",
		semantic_memory: "🧠",
		letta_memory: "🔑",
		trajectory_reuse: "♻️",
		negative_memory: "⚠️",
		web_research: "🌐",
		mcp_tool_discovery: "🔧",
		agent_capabilities: "🤖",
		policy_enrichment: "📜",
	};
	return icons[type] || "📄";
}
