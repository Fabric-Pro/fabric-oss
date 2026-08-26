/**
 * Default Configuration
 *
 * Default values for various orchestrator components.
 */

import type { CapabilityType } from "../../../workflows/orchestrator/types";

/**
 * Default risk levels for different operation types.
 */
export const DEFAULT_RISK_LEVELS: Record<string, number> = {
	low: 1,
	medium: 2,
	high: 3,
	critical: 4,
} as const;

/**
 * Capability execution priority (lower = higher priority).
 * Used by step assigner to determine execution order.
 */
export const DEFAULT_CAPABILITY_PRIORITY: Record<CapabilityType, number> = {
	workflow: 1, // Highest - pre-defined, tested workflows
	integration: 1.5, // Configured service integrations (already authenticated)
	mcp_tool: 2, // Direct tool execution
	agent: 3, // Agent delegation
	llm: 4, // Simple LLM generation
	web: 5, // Web browsing (often slowest)
} as const;

/**
 * Handler priority for the handler registry (lower = checked first).
 * Maps handler types to their evaluation priority.
 */
export const HANDLER_PRIORITY = {
	/** Unified search - searches all project knowledge sources in parallel */
	UNIFIED_SEARCH: 4,
	/** Workspace RAG tools - checked first for document queries */
	WORKSPACE_RAG: 5,
	/** Project RAG tools - checked for project-specific document queries */
	PROJECT_RAG: 6,
	/** Code search tools - repository code search, file retrieval, tree listing */
	CODE_SEARCH: 7,
	/** Decisions-tab handlers - checked before the generic Fabric AI handler */
	DECISION_CONTEXT: 8,
	/** Security findings handler - checked before the generic Fabric AI handler */
	SECURITY_FINDINGS: 8,
	/** Fabric AI tools (YouTube, scraping, patterns) - checked first for specific URLs */
	FABRIC_AI: 10,
	/** Pre-defined Temporal workflows */
	WORKFLOW: 20,
	/** Configured service integrations (Slack, GitHub, etc.) - checked before LLM/agents */
	INTEGRATION: 25,
	/** Pure LLM generation without tools (fast path) */
	LLM: 30,
	/** Agent delegation via A2A protocol */
	AGENT: 40,
	/** Web browsing capabilities */
	WEB: 50,
	/** MCP tool execution (default fallback) */
	MCP_TOOL: 100,
} as const;

/**
 * Default confidence thresholds for matching.
 */
export const DEFAULT_CONFIDENCE_THRESHOLDS = {
	/** Minimum confidence for tool matching */
	TOOL_MATCH: 0.4,
	/** Minimum confidence for agent matching */
	AGENT_MATCH: 0.3,
	/** Minimum confidence for workflow matching */
	WORKFLOW_MATCH: 0.5,
	/** Boost for prioritized items */
	PRIORITY_BOOST: 0.2,
} as const;

/**
 * Default search limits.
 */
export const DEFAULT_SEARCH_LIMITS = {
	/** Maximum tools to return from search */
	MAX_TOOLS: 10,
	/** Maximum agents to return from search */
	MAX_AGENTS: 5,
	/** Maximum workflows to return from search */
	MAX_WORKFLOWS: 5,
} as const;
