/**
 * Agent Capability Descriptor
 *
 * Dynamic capability matching system that replaces hardcoded patterns.
 * Uses semantic search (embeddings) and structured capability matrices
 * for intelligent routing decisions.
 *
 * Part of Phase 1: Dynamic Capability Discovery
 */

import type { AgentCardCapabilities, AgentCategory } from "../types";

// =============================================================================
// Agent Capability Descriptor
// =============================================================================

/**
 * Comprehensive descriptor for agent capabilities.
 * Used for semantic matching and intelligent routing.
 */
export interface AgentCapabilityDescriptor {
	// Core identity
	agentId: string;
	name: string;
	displayName: string;
	description: string;

	// Semantic matching
	/** Pre-computed embedding for semantic search */
	descriptionEmbedding?: number[];
	/** When the embedding was last computed */
	embeddingComputedAt?: Date;
	/** Trigger phrases that strongly indicate this agent */
	triggerPhrases: string[];
	/** Keywords for BM25 matching */
	keywords: string[];

	// Capability matrix
	capabilities: AgentCapabilityMatrix;

	// Constraints
	limitations: string[];
	maxOperationRisk: "low" | "medium" | "high" | "critical";
	requiresApproval: boolean;

	// Categories for filtering
	categories: AgentCategory[];

	// Learning signals
	successRate: number;
	avgResponseTimeMs: number;
	lastUsed?: Date;
	usageCount: number;

	// Metadata
	scope: "SYSTEM" | "ORGANIZATION" | "USER";
	userId?: string;
	organizationId?: string;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Structured capability matrix for agent capabilities.
 */
export interface AgentCapabilityMatrix {
	documentGeneration?: {
		enabled: boolean;
		types: string[]; // e.g., ["prd", "technical_spec", "api_doc"]
		confidence: number; // 0-1
	};
	codeExecution?: {
		enabled: boolean;
		languages: string[]; // e.g., ["python", "javascript"]
		sandboxed: boolean;
		confidence: number;
	};
	browserAutomation?: {
		enabled: boolean;
		maxActions: number;
		supportsScreenshot: boolean;
		confidence: number;
	};
	apiIntegration?: {
		enabled: boolean;
		protocols: string[]; // e.g., ["rest", "graphql", "grpc"]
		confidence: number;
	};
	dataProcessing?: {
		enabled: boolean;
		formats: string[]; // e.g., ["json", "csv", "xml"]
		confidence: number;
	};
	taskPlanning?: {
		enabled: boolean;
		maxComplexity: "simple" | "moderate" | "complex";
		confidence: number;
	};
	research?: {
		enabled: boolean;
		sources: string[]; // e.g., ["web", "documents", "apis"]
		confidence: number;
	};
	memoryAccess?: {
		enabled: boolean;
		types: string[]; // e.g., ["short_term", "long_term", "semantic"]
		confidence: number;
	};
}

// =============================================================================
// Tool Capability Descriptor
// =============================================================================

/**
 * Comprehensive descriptor for MCP tool capabilities.
 */
export interface ToolCapabilityDescriptor {
	toolId: string;
	serverId: string;
	serverName: string;
	name: string;
	description: string;

	// Semantic matching
	descriptionEmbedding?: number[];
	embeddingComputedAt?: Date;
	/** Operation verbs (e.g., ["create", "list", "delete"]) */
	operationVerbs: string[];
	/** Resource types (e.g., ["card", "issue", "document"]) */
	resourceTypes: string[];
	/** Keywords for BM25 matching */
	keywords: string[];

	// Risk assessment
	operationType: "read" | "create" | "update" | "delete" | "execute";
	riskLevel: "low" | "medium" | "high" | "critical";
	sideEffects: string[]; // e.g., ["sends email", "charges payment"]
	reversible: boolean;

	// Schema information
	inputSchema?: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;

	// Usage patterns (learned)
	successfulArgsPatterns: Record<string, unknown>[];
	commonErrors: ToolErrorPattern[];

	// Learning signals
	successRate: number;
	avgResponseTimeMs: number;
	lastUsed?: Date;
	usageCount: number;

	// Metadata
	configId: string;
	userId?: string;
	organizationId?: string;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Common error pattern for tool learning.
 */
export interface ToolErrorPattern {
	pattern: string;
	errorMessage: string;
	solution?: string;
	occurrences: number;
	lastOccurrence: Date;
}

// =============================================================================
// Capability Match Result
// =============================================================================

/**
 * Result of capability matching.
 */
export interface CapabilityMatchResult {
	// Agent matches
	agentMatches: AgentMatchResult[];
	// Tool matches
	toolMatches: ToolMatchResult[];
	// Recommended routing
	recommendation: {
		primaryCapability: "agent" | "tool" | "llm";
		primaryId: string;
		confidence: number;
		reasoning: string;
	};
}

export interface AgentMatchResult {
	descriptor: AgentCapabilityDescriptor;
	/** Overall match score (0-1) */
	score: number;
	/** Semantic similarity score (0-1) */
	semanticScore: number;
	/** Keyword/BM25 score (0-1) */
	keywordScore: number;
	/** Capability matrix match score (0-1) */
	capabilityScore: number;
	/** Why this agent matched */
	matchReasons: string[];
	/** Potential concerns */
	warnings: string[];
}

export interface ToolMatchResult {
	descriptor: ToolCapabilityDescriptor;
	/** Overall match score (0-1) */
	score: number;
	/** Semantic similarity score (0-1) */
	semanticScore: number;
	/** Keyword/BM25 score (0-1) */
	keywordScore: number;
	/** Why this tool matched */
	matchReasons: string[];
	/** Suggested arguments based on patterns */
	suggestedArgs?: Record<string, unknown>;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Extract trigger phrases from agent description and skills.
 */
export function extractTriggerPhrases(
	description: string,
	skills?: Array<{ name: string; description?: string }>,
): string[] {
	const phrases: string[] = [];

	// Extract action phrases from description
	const descLower = description.toLowerCase();

	// Common action patterns
	const actionPatterns = [
		/(?:can|able to|helps? with|specializes? in|designed for)\s+(.+?)(?:\.|,|$)/gi,
		/(?:generate|create|build|write|produce)\s+(.+?)(?:\.|,|$)/gi,
		/(?:execute|run|perform)\s+(.+?)(?:\.|,|$)/gi,
	];

	for (const pattern of actionPatterns) {
		const matches = descLower.matchAll(pattern);
		for (const match of matches) {
			if (match[1] && match[1].length > 3 && match[1].length < 50) {
				phrases.push(match[1].trim());
			}
		}
	}

	// Add skill names as trigger phrases
	if (skills) {
		for (const skill of skills) {
			phrases.push(skill.name.toLowerCase());
			if (skill.description) {
				// Extract first sentence of skill description
				const firstSentence = skill.description.split(/[.!?]/)[0];
				if (
					firstSentence &&
					firstSentence.length > 5 &&
					firstSentence.length < 100
				) {
					phrases.push(firstSentence.toLowerCase().trim());
				}
			}
		}
	}

	// Deduplicate and filter
	return [...new Set(phrases)].filter((p) => p.length > 3);
}

/**
 * Extract keywords from text for BM25 matching.
 */
export function extractKeywords(text: string): string[] {
	const stopWords = new Set([
		"the",
		"a",
		"an",
		"and",
		"or",
		"but",
		"in",
		"on",
		"at",
		"to",
		"for",
		"of",
		"with",
		"by",
		"from",
		"as",
		"is",
		"was",
		"are",
		"were",
		"been",
		"be",
		"have",
		"has",
		"had",
		"do",
		"does",
		"did",
		"will",
		"would",
		"could",
		"should",
		"may",
		"might",
		"must",
		"shall",
		"can",
		"this",
		"that",
		"these",
		"those",
		"it",
		"its",
		"they",
		"them",
		"their",
	]);

	const words = text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !stopWords.has(w));

	// Extract n-grams (bigrams)
	const bigrams: string[] = [];
	for (let i = 0; i < words.length - 1; i++) {
		bigrams.push(`${words[i]} ${words[i + 1]}`);
	}

	return [...new Set([...words, ...bigrams])];
}

/**
 * Determine operation type from tool name.
 */
export function inferOperationType(
	toolName: string,
): "read" | "create" | "update" | "delete" | "execute" {
	const nameLower = toolName.toLowerCase();

	if (
		nameLower.includes("delete") ||
		nameLower.includes("remove") ||
		nameLower.includes("destroy")
	) {
		return "delete";
	}

	if (
		nameLower.includes("create") ||
		nameLower.includes("add") ||
		nameLower.includes("insert") ||
		nameLower.includes("post") ||
		nameLower.includes("new")
	) {
		return "create";
	}

	if (
		nameLower.includes("update") ||
		nameLower.includes("modify") ||
		nameLower.includes("edit") ||
		nameLower.includes("patch") ||
		nameLower.includes("put") ||
		nameLower.includes("change")
	) {
		return "update";
	}

	if (
		nameLower.includes("execute") ||
		nameLower.includes("run") ||
		nameLower.includes("trigger") ||
		nameLower.includes("invoke")
	) {
		return "execute";
	}

	// Default to read for get, list, search, etc.
	return "read";
}

/**
 * Determine risk level from operation type and tool characteristics.
 */
export function inferRiskLevel(
	operationType: "read" | "create" | "update" | "delete" | "execute",
	sideEffects: string[],
	reversible: boolean,
): "low" | "medium" | "high" | "critical" {
	// Base risk from operation type
	const baseRisk: Record<string, number> = {
		read: 1,
		create: 3,
		update: 2,
		delete: 4,
		execute: 3,
	};

	let riskScore = baseRisk[operationType];

	// Increase for side effects
	riskScore += sideEffects.length * 0.5;

	// Increase if not reversible
	if (!reversible && operationType !== "read") {
		riskScore += 1;
	}

	// Map to risk level
	if (riskScore <= 1) {
		return "low";
	}
	if (riskScore <= 2.5) {
		return "medium";
	}
	if (riskScore <= 3.5) {
		return "high";
	}
	return "critical";
}

/**
 * Infer side effects from tool name and description.
 */
export function inferSideEffects(
	toolName: string,
	description?: string,
): string[] {
	const sideEffects: string[] = [];
	const combined = `${toolName} ${description || ""}`.toLowerCase();

	if (combined.includes("email") || combined.includes("send")) {
		sideEffects.push("sends email");
	}
	if (
		combined.includes("payment") ||
		combined.includes("charge") ||
		combined.includes("billing")
	) {
		sideEffects.push("charges payment");
	}
	if (
		combined.includes("notification") ||
		combined.includes("notify") ||
		combined.includes("alert")
	) {
		sideEffects.push("sends notification");
	}
	if (combined.includes("publish") || combined.includes("deploy")) {
		sideEffects.push("publishes content");
	}
	if (combined.includes("webhook") || combined.includes("callback")) {
		sideEffects.push("triggers webhook");
	}

	return sideEffects;
}

/**
 * Check if operation is reversible based on type and context.
 */
export function isOperationReversible(
	operationType: "read" | "create" | "update" | "delete" | "execute",
	toolName: string,
): boolean {
	// Read operations don't change state
	if (operationType === "read") {
		return true;
	}

	// Delete is generally not reversible
	if (operationType === "delete") {
		return false;
	}

	// Check for specific non-reversible patterns
	const nameLower = toolName.toLowerCase();
	if (
		nameLower.includes("purge") ||
		nameLower.includes("destroy") ||
		nameLower.includes("permanent")
	) {
		return false;
	}

	// Create and update are typically reversible
	return operationType === "create" || operationType === "update";
}

/**
 * Convert AgentCardCapabilities to AgentCapabilityDescriptor.
 */
export function cardCapabilitiesToDescriptor(
	agentId: string,
	displayName: string,
	description: string,
	capabilities: AgentCardCapabilities,
	scope: "SYSTEM" | "ORGANIZATION" | "USER",
	userId?: string,
	organizationId?: string,
): AgentCapabilityDescriptor {
	const now = new Date();

	// Build capability matrix
	const matrix: AgentCapabilityMatrix = {};

	if (capabilities.taskDecomposition || capabilities.autonomousExecution) {
		matrix.taskPlanning = {
			enabled: true,
			maxComplexity:
				capabilities.maxAutonomyLevel === "task"
					? "complex"
					: "moderate",
			confidence: 0.8,
		};
	}

	if (capabilities.codeExecution) {
		matrix.codeExecution = {
			enabled: true,
			languages: ["python", "javascript"], // Default, should come from agent card
			sandboxed: capabilities.sandboxed ?? true,
			confidence: 0.9,
		};
	}

	if (capabilities.browserAutomation) {
		matrix.browserAutomation = {
			enabled: true,
			maxActions: 50, // Default
			supportsScreenshot: true,
			confidence: 0.85,
		};
	}

	if (capabilities.apiOrchestration || capabilities.hasMcpAccess) {
		matrix.apiIntegration = {
			enabled: true,
			protocols: ["rest"],
			confidence: 0.8,
		};
	}

	if (capabilities.memoryEnabled) {
		matrix.memoryAccess = {
			enabled: true,
			types: ["short_term", "semantic"],
			confidence: 0.7,
		};
	}

	// Infer document generation from skills/tags
	const tags = capabilities.tags || [];
	const skills = capabilities.skills || [];
	if (
		tags.some((t) => t.includes("document") || t.includes("generate")) ||
		skills.some(
			(s) => s.name.includes("document") || s.name.includes("generate"),
		)
	) {
		matrix.documentGeneration = {
			enabled: true,
			types: ["general"],
			confidence: 0.75,
		};
	}

	return {
		agentId,
		name: agentId,
		displayName,
		description,
		triggerPhrases: extractTriggerPhrases(description, skills),
		keywords: extractKeywords(description),
		capabilities: matrix,
		limitations: capabilities.limitations || [],
		maxOperationRisk:
			capabilities.codeExecution || capabilities.browserAutomation
				? "high"
				: "medium",
		requiresApproval:
			capabilities.codeExecution ||
			capabilities.browserAutomation ||
			false,
		categories: capabilities.categories || ["general"],
		successRate: 1.0, // Initial value
		avgResponseTimeMs: 5000, // Initial estimate
		usageCount: 0,
		scope,
		userId,
		organizationId,
		createdAt: now,
		updatedAt: now,
	};
}
