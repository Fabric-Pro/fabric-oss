/**
 * Capability Matcher
 *
 * Intelligent capability matching using semantic search and structured analysis.
 * Replaces hardcoded pattern matching with dynamic, learning-based routing.
 *
 * Part of Phase 1: Dynamic Capability Discovery
 */

import { logger } from "@repo/logs";
import {
	cosineSimilarity,
	getOrGenerateEmbedding,
} from "../tools/capability-embeddings";
import type {
	AgentCapabilityDescriptor,
	AgentCapabilityMatrix,
	AgentMatchResult,
	CapabilityMatchResult,
	ToolCapabilityDescriptor,
	ToolMatchResult,
} from "./capability-descriptor";
import { extractKeywords } from "./capability-descriptor";

// =============================================================================
// Types
// =============================================================================

export interface CapabilityMatcherOptions {
	/** Minimum score to include in results */
	minScore: number;
	/** Maximum results to return */
	limit: number;
	/** Weight for semantic similarity (0-1) */
	semanticWeight: number;
	/** Weight for keyword matching (0-1) */
	keywordWeight: number;
	/** Weight for capability matrix matching (0-1) */
	capabilityWeight: number;
	/** API key for embedding generation */
	apiKey: string;
	/** User ID for caching */
	userId?: string;
	/** Organization ID for caching */
	organizationId?: string;
}

export interface TaskAnalysis {
	/** Original task text */
	task: string;
	/** Extracted keywords */
	keywords: string[];
	/** Detected operation type */
	operationType:
		| "read"
		| "create"
		| "update"
		| "delete"
		| "execute"
		| "generate"
		| "research";
	/** Detected complexity */
	complexity: "simple" | "moderate" | "complex";
	/** Required capabilities */
	requiredCapabilities: RequiredCapability[];
	/** Detected risk factors */
	riskFactors: string[];
	/** Whether task explicitly mentions specific tools/agents */
	explicitMentions: {
		agents: string[];
		tools: string[];
	};
}

export interface RequiredCapability {
	type: keyof AgentCapabilityMatrix;
	importance: "required" | "preferred" | "optional";
	reason: string;
}

// =============================================================================
// Task Analysis
// =============================================================================

/**
 * Analyze a task to extract semantic information for matching.
 */
export function analyzeTask(task: string): TaskAnalysis {
	const taskLower = task.toLowerCase();
	const keywords = extractKeywords(task);

	// Detect operation type
	const operationType = detectOperationType(taskLower);

	// Detect complexity
	const complexity = detectComplexity(task);

	// Extract required capabilities
	const requiredCapabilities = extractRequiredCapabilities(taskLower);

	// Detect risk factors
	const riskFactors = detectRiskFactors(taskLower);

	// Detect explicit mentions
	const explicitMentions = detectExplicitMentions(taskLower);

	return {
		task,
		keywords,
		operationType,
		complexity,
		requiredCapabilities,
		riskFactors,
		explicitMentions,
	};
}

function detectOperationType(
	taskLower: string,
):
	| "read"
	| "create"
	| "update"
	| "delete"
	| "execute"
	| "generate"
	| "research" {
	// Generation patterns
	if (
		taskLower.includes("generate") ||
		taskLower.includes("write") ||
		taskLower.includes("create a document") ||
		taskLower.includes("draft") ||
		taskLower.includes("compose") ||
		taskLower.includes("prd") ||
		taskLower.includes("spec") ||
		taskLower.includes("report")
	) {
		return "generate";
	}

	// Research patterns
	if (
		taskLower.includes("research") ||
		taskLower.includes("find out") ||
		taskLower.includes("investigate") ||
		taskLower.includes("analyze") ||
		taskLower.includes("look up") ||
		taskLower.includes("search for information")
	) {
		return "research";
	}

	// Delete patterns
	if (
		taskLower.includes("delete") ||
		taskLower.includes("remove") ||
		taskLower.includes("destroy")
	) {
		return "delete";
	}

	// Create patterns
	if (
		taskLower.includes("create") ||
		taskLower.includes("add") ||
		taskLower.includes("new") ||
		taskLower.includes("insert") ||
		taskLower.includes("post")
	) {
		return "create";
	}

	// Update patterns
	if (
		taskLower.includes("update") ||
		taskLower.includes("modify") ||
		taskLower.includes("edit") ||
		taskLower.includes("change") ||
		taskLower.includes("move")
	) {
		return "update";
	}

	// Execute patterns
	if (
		taskLower.includes("execute") ||
		taskLower.includes("run") ||
		taskLower.includes("trigger") ||
		taskLower.includes("automate")
	) {
		return "execute";
	}

	// Default to read
	return "read";
}

function detectComplexity(task: string): "simple" | "moderate" | "complex" {
	// Count complexity indicators
	let complexityScore = 0;

	// Length-based
	if (task.length > 500) {
		complexityScore += 2;
	} else if (task.length > 200) {
		complexityScore += 1;
	}

	// Multi-step indicators
	const multiStepPatterns = [
		/then/gi,
		/after that/gi,
		/next/gi,
		/finally/gi,
		/first.*then/gi,
		/step \d+/gi,
		/\d+\./g, // Numbered lists
	];
	for (const pattern of multiStepPatterns) {
		if (pattern.test(task)) {
			complexityScore += 1;
		}
	}

	// Multiple entities
	const entityPatterns = [
		/all/gi,
		/each/gi,
		/every/gi,
		/multiple/gi,
		/several/gi,
	];
	for (const pattern of entityPatterns) {
		if (pattern.test(task)) {
			complexityScore += 0.5;
		}
	}

	// Conditional logic
	const conditionalPatterns = [
		/if/gi,
		/when/gi,
		/unless/gi,
		/based on/gi,
		/depending on/gi,
	];
	for (const pattern of conditionalPatterns) {
		if (pattern.test(task)) {
			complexityScore += 0.5;
		}
	}

	if (complexityScore <= 1) {
		return "simple";
	}
	if (complexityScore <= 3) {
		return "moderate";
	}
	return "complex";
}

function extractRequiredCapabilities(taskLower: string): RequiredCapability[] {
	const capabilities: RequiredCapability[] = [];

	// Document generation
	if (
		taskLower.includes("prd") ||
		taskLower.includes("document") ||
		taskLower.includes("spec") ||
		taskLower.includes("report") ||
		taskLower.includes("write")
	) {
		capabilities.push({
			type: "documentGeneration",
			importance: "required",
			reason: "Task requires document generation",
		});
	}

	// Code execution
	if (
		taskLower.includes("run code") ||
		taskLower.includes("execute") ||
		taskLower.includes("python") ||
		taskLower.includes("javascript") ||
		taskLower.includes("script")
	) {
		capabilities.push({
			type: "codeExecution",
			importance: "required",
			reason: "Task requires code execution",
		});
	}

	// Browser automation
	if (
		taskLower.includes("browser") ||
		taskLower.includes("click") ||
		taskLower.includes("navigate") ||
		taskLower.includes("website") ||
		taskLower.includes("scrape")
	) {
		capabilities.push({
			type: "browserAutomation",
			importance: "required",
			reason: "Task requires browser interaction",
		});
	}

	// API integration
	if (
		taskLower.includes("api") ||
		taskLower.includes("slack") ||
		taskLower.includes("github") ||
		taskLower.includes("jira") ||
		taskLower.includes("linear") ||
		taskLower.includes("fizzy")
	) {
		capabilities.push({
			type: "apiIntegration",
			importance: "required",
			reason: "Task requires API integration",
		});
	}

	// Task planning
	if (
		taskLower.includes("plan") ||
		taskLower.includes("break down") ||
		taskLower.includes("decompose") ||
		taskLower.includes("steps")
	) {
		capabilities.push({
			type: "taskPlanning",
			importance: "preferred",
			reason: "Task may benefit from planning",
		});
	}

	// Research
	if (
		taskLower.includes("research") ||
		taskLower.includes("find") ||
		taskLower.includes("search") ||
		taskLower.includes("look up")
	) {
		capabilities.push({
			type: "research",
			importance: "required",
			reason: "Task requires information gathering",
		});
	}

	return capabilities;
}

function detectRiskFactors(taskLower: string): string[] {
	const riskFactors: string[] = [];

	// Destructive operations
	if (taskLower.includes("delete") || taskLower.includes("remove")) {
		riskFactors.push("Destructive operation detected");
	}

	// Bulk operations
	if (
		taskLower.includes("all") ||
		taskLower.includes("bulk") ||
		taskLower.includes("batch")
	) {
		riskFactors.push("Bulk operation detected");
	}

	// External communications
	if (
		taskLower.includes("send email") ||
		taskLower.includes("post to") ||
		taskLower.includes("notify")
	) {
		riskFactors.push("External communication detected");
	}

	// Financial
	if (
		taskLower.includes("payment") ||
		taskLower.includes("billing") ||
		taskLower.includes("charge")
	) {
		riskFactors.push("Financial operation detected");
	}

	// Code execution
	if (
		taskLower.includes("execute code") ||
		taskLower.includes("run script")
	) {
		riskFactors.push("Code execution requested");
	}

	return riskFactors;
}

function detectExplicitMentions(taskLower: string): {
	agents: string[];
	tools: string[];
} {
	const agents: string[] = [];
	const tools: string[] = [];

	// Agent patterns
	const agentPatterns = [
		{ pattern: /use\s+cuga/i, id: "cuga_generalist" },
		{ pattern: /cuga\s+agent/i, id: "cuga_generalist" },
		{ pattern: /browser\s+agent/i, id: "cuga_generalist" },
		{ pattern: /generate\s+prd/i, id: "project_document_generator" },
		{ pattern: /create\s+prd/i, id: "project_document_generator" },
		{ pattern: /prd\s+document/i, id: "project_document_generator" },
		{ pattern: /task\s+planner/i, id: "task_planner" },
		{ pattern: /story\s+breakdown/i, id: "story_breakdown" },
		{ pattern: /user\s+stories/i, id: "story_breakdown" },
	];

	for (const { pattern, id } of agentPatterns) {
		if (pattern.test(taskLower) && !agents.includes(id)) {
			agents.push(id);
		}
	}

	// Tool patterns (from common MCP servers)
	const toolPatterns = [
		{ pattern: /fizzy/i, id: "fizzy" },
		{ pattern: /slack/i, id: "slack" },
		{ pattern: /github/i, id: "github" },
		{ pattern: /linear/i, id: "linear" },
		{ pattern: /jira/i, id: "jira" },
		{ pattern: /confluence/i, id: "confluence" },
		{ pattern: /notion/i, id: "notion" },
		{ pattern: /firecrawl/i, id: "firecrawl" },
	];

	for (const { pattern, id } of toolPatterns) {
		if (pattern.test(taskLower) && !tools.includes(id)) {
			tools.push(id);
		}
	}

	return { agents, tools };
}

// =============================================================================
// Capability Matching
// =============================================================================

/**
 * Match capabilities to a task using semantic and structural analysis.
 */
export async function matchCapabilities(
	task: string,
	agentDescriptors: AgentCapabilityDescriptor[],
	toolDescriptors: ToolCapabilityDescriptor[],
	options: CapabilityMatcherOptions,
): Promise<CapabilityMatchResult> {
	const {
		minScore,
		limit,
		semanticWeight,
		keywordWeight,
		capabilityWeight,
		apiKey,
		userId,
		organizationId,
	} = options;

	logger.info(
		`[CapabilityMatcher] Matching task: "${task.slice(0, 100)}..."`,
	);

	// Analyze the task
	const taskAnalysis = analyzeTask(task);

	// Generate task embedding
	const taskEmbedding = await getOrGenerateEmbedding(
		task,
		`task:${task.slice(0, 100)}`,
		apiKey,
		userId,
		organizationId,
	);

	// Match agents
	const agentMatches = await matchAgents(
		taskAnalysis,
		taskEmbedding,
		agentDescriptors,
		{ semanticWeight, keywordWeight, capabilityWeight, minScore, limit },
	);

	// Match tools
	const toolMatches = await matchTools(
		taskAnalysis,
		taskEmbedding,
		toolDescriptors,
		{ semanticWeight, keywordWeight, minScore, limit },
	);

	// Determine recommendation
	const recommendation = determineRecommendation(
		taskAnalysis,
		agentMatches,
		toolMatches,
	);

	logger.info("[CapabilityMatcher] Match complete", {
		agentMatchCount: agentMatches.length,
		toolMatchCount: toolMatches.length,
		recommendation: recommendation.primaryId,
		confidence: recommendation.confidence,
	});

	return {
		agentMatches,
		toolMatches,
		recommendation,
	};
}

async function matchAgents(
	taskAnalysis: TaskAnalysis,
	taskEmbedding: number[],
	descriptors: AgentCapabilityDescriptor[],
	options: {
		semanticWeight: number;
		keywordWeight: number;
		capabilityWeight: number;
		minScore: number;
		limit: number;
	},
): Promise<AgentMatchResult[]> {
	const results: AgentMatchResult[] = [];

	for (const descriptor of descriptors) {
		// Calculate semantic score
		let semanticScore = 0;
		if (descriptor.descriptionEmbedding) {
			semanticScore = cosineSimilarity(
				taskEmbedding,
				descriptor.descriptionEmbedding,
			);
		}

		// Calculate keyword score
		const keywordScore = calculateKeywordScore(
			taskAnalysis.keywords,
			descriptor.keywords,
		);

		// Calculate capability score
		const capabilityScore = calculateCapabilityScore(
			taskAnalysis.requiredCapabilities,
			descriptor.capabilities,
		);

		// Calculate hybrid score
		const totalWeight =
			options.semanticWeight +
			options.keywordWeight +
			options.capabilityWeight;
		const score =
			(semanticScore * options.semanticWeight +
				keywordScore * options.keywordWeight +
				capabilityScore * options.capabilityWeight) /
			totalWeight;

		// Boost for explicit mentions
		let finalScore = score;
		if (taskAnalysis.explicitMentions.agents.includes(descriptor.agentId)) {
			finalScore = Math.min(1, score + 0.3);
		}

		// Boost for trigger phrases
		for (const phrase of descriptor.triggerPhrases) {
			if (taskAnalysis.task.toLowerCase().includes(phrase)) {
				finalScore = Math.min(1, finalScore + 0.1);
				break;
			}
		}

		if (finalScore >= options.minScore) {
			const matchReasons: string[] = [];
			const warnings: string[] = [];

			if (semanticScore > 0.5) {
				matchReasons.push(
					`High semantic similarity (${(semanticScore * 100).toFixed(0)}%)`,
				);
			}
			if (keywordScore > 0.3) {
				matchReasons.push(
					`Keyword match (${(keywordScore * 100).toFixed(0)}%)`,
				);
			}
			if (capabilityScore > 0.5) {
				matchReasons.push(
					`Strong capability match (${(capabilityScore * 100).toFixed(0)}%)`,
				);
			}
			if (
				taskAnalysis.explicitMentions.agents.includes(
					descriptor.agentId,
				)
			) {
				matchReasons.push("Explicitly mentioned in task");
			}

			// Add warnings for limitations
			for (const limitation of descriptor.limitations) {
				if (
					taskAnalysis.requiredCapabilities.some(
						(rc) =>
							rc.importance === "required" &&
							limitation.toLowerCase().includes(rc.type),
					)
				) {
					warnings.push(`Limitation: ${limitation}`);
				}
			}

			results.push({
				descriptor,
				score: finalScore,
				semanticScore,
				keywordScore,
				capabilityScore,
				matchReasons,
				warnings,
			});
		}
	}

	// Sort by score and limit
	return results.sort((a, b) => b.score - a.score).slice(0, options.limit);
}

async function matchTools(
	taskAnalysis: TaskAnalysis,
	taskEmbedding: number[],
	descriptors: ToolCapabilityDescriptor[],
	options: {
		semanticWeight: number;
		keywordWeight: number;
		minScore: number;
		limit: number;
	},
): Promise<ToolMatchResult[]> {
	const results: ToolMatchResult[] = [];

	for (const descriptor of descriptors) {
		// Calculate semantic score
		let semanticScore = 0;
		if (descriptor.descriptionEmbedding) {
			semanticScore = cosineSimilarity(
				taskEmbedding,
				descriptor.descriptionEmbedding,
			);
		}

		// Calculate keyword score
		const keywordScore = calculateKeywordScore(
			taskAnalysis.keywords,
			descriptor.keywords,
		);

		// Operation type match bonus
		let operationBonus = 0;
		if (taskAnalysis.operationType === descriptor.operationType) {
			operationBonus = 0.1;
		} else if (
			taskAnalysis.operationType === "read" &&
			descriptor.operationType === "read"
		) {
			operationBonus = 0.15; // Extra bonus for read operations
		}

		// Calculate hybrid score
		const totalWeight = options.semanticWeight + options.keywordWeight;
		const score =
			(semanticScore * options.semanticWeight +
				keywordScore * options.keywordWeight) /
				totalWeight +
			operationBonus;

		// Boost for explicit tool mentions
		let finalScore = score;
		if (
			taskAnalysis.explicitMentions.tools.some(
				(t) =>
					descriptor.serverName.toLowerCase().includes(t) ||
					descriptor.name.toLowerCase().includes(t),
			)
		) {
			finalScore = Math.min(1, score + 0.25);
		}

		if (finalScore >= options.minScore) {
			const matchReasons: string[] = [];

			if (semanticScore > 0.5) {
				matchReasons.push(
					`High semantic similarity (${(semanticScore * 100).toFixed(0)}%)`,
				);
			}
			if (keywordScore > 0.3) {
				matchReasons.push(
					`Keyword match (${(keywordScore * 100).toFixed(0)}%)`,
				);
			}
			if (operationBonus > 0) {
				matchReasons.push(
					`Operation type match (${descriptor.operationType})`,
				);
			}
			if (
				taskAnalysis.explicitMentions.tools.some((t) =>
					descriptor.serverName.toLowerCase().includes(t),
				)
			) {
				matchReasons.push("Explicitly mentioned in task");
			}

			// Suggest args based on successful patterns
			let suggestedArgs: Record<string, unknown> | undefined;
			if (descriptor.successfulArgsPatterns.length > 0) {
				// Use most recent successful pattern as suggestion base
				suggestedArgs =
					descriptor.successfulArgsPatterns[
						descriptor.successfulArgsPatterns.length - 1
					];
			}

			results.push({
				descriptor,
				score: finalScore,
				semanticScore,
				keywordScore,
				matchReasons,
				suggestedArgs,
			});
		}
	}

	// Sort by score and limit
	return results.sort((a, b) => b.score - a.score).slice(0, options.limit);
}

function calculateKeywordScore(
	taskKeywords: string[],
	capabilityKeywords: string[],
): number {
	if (taskKeywords.length === 0 || capabilityKeywords.length === 0) {
		return 0;
	}

	const taskSet = new Set(taskKeywords.map((k) => k.toLowerCase()));
	const capSet = new Set(capabilityKeywords.map((k) => k.toLowerCase()));

	let matchCount = 0;
	for (const keyword of taskSet) {
		if (capSet.has(keyword)) {
			matchCount += 1;
		} else {
			// Partial match bonus
			for (const capKeyword of capSet) {
				if (
					capKeyword.includes(keyword) ||
					keyword.includes(capKeyword)
				) {
					matchCount += 0.5;
					break;
				}
			}
		}
	}

	// Jaccard-like similarity
	return matchCount / Math.max(taskSet.size, 1);
}

function calculateCapabilityScore(
	requiredCapabilities: RequiredCapability[],
	agentCapabilities: AgentCapabilityMatrix,
): number {
	if (requiredCapabilities.length === 0) {
		return 0.5; // Neutral score if no specific requirements
	}

	let score = 0;
	let maxScore = 0;

	for (const required of requiredCapabilities) {
		const weight =
			required.importance === "required"
				? 1
				: required.importance === "preferred"
					? 0.5
					: 0.2;
		maxScore += weight;

		const capability = agentCapabilities[required.type];
		if (capability?.enabled) {
			score += weight * (capability.confidence || 0.8);
		}
	}

	return maxScore > 0 ? score / maxScore : 0.5;
}

function determineRecommendation(
	taskAnalysis: TaskAnalysis,
	agentMatches: AgentMatchResult[],
	toolMatches: ToolMatchResult[],
): CapabilityMatchResult["recommendation"] {
	// Priority: MCP tools > Specialized agents > Generalist agents > LLM

	// If task explicitly mentions tools and we have high-confidence tool matches
	if (
		taskAnalysis.explicitMentions.tools.length > 0 &&
		toolMatches.length > 0 &&
		toolMatches[0].score > 0.6
	) {
		return {
			primaryCapability: "tool",
			primaryId: toolMatches[0].descriptor.toolId,
			confidence: toolMatches[0].score * 100,
			reasoning: `Task explicitly mentions ${taskAnalysis.explicitMentions.tools.join(", ")} - matched tool with ${(toolMatches[0].score * 100).toFixed(0)}% confidence`,
		};
	}

	// For read operations, prefer tools
	if (
		taskAnalysis.operationType === "read" &&
		toolMatches.length > 0 &&
		toolMatches[0].score > 0.5
	) {
		return {
			primaryCapability: "tool",
			primaryId: toolMatches[0].descriptor.toolId,
			confidence: toolMatches[0].score * 100,
			reasoning: `Read operation - MCP tool can handle directly with ${(toolMatches[0].score * 100).toFixed(0)}% confidence`,
		};
	}

	// For complex tasks requiring planning, prefer specialized agents
	if (taskAnalysis.complexity === "complex" && agentMatches.length > 0) {
		const planningAgent = agentMatches.find(
			(a) => a.descriptor.capabilities.taskPlanning?.enabled,
		);
		if (planningAgent && planningAgent.score > 0.5) {
			return {
				primaryCapability: "agent",
				primaryId: planningAgent.descriptor.agentId,
				confidence: planningAgent.score * 100,
				reasoning: `Complex task requiring planning - matched agent with ${(planningAgent.score * 100).toFixed(0)}% confidence`,
			};
		}
	}

	// For generation tasks, prefer document generators
	if (taskAnalysis.operationType === "generate" && agentMatches.length > 0) {
		const generatorAgent = agentMatches.find(
			(a) => a.descriptor.capabilities.documentGeneration?.enabled,
		);
		if (generatorAgent && generatorAgent.score > 0.5) {
			return {
				primaryCapability: "agent",
				primaryId: generatorAgent.descriptor.agentId,
				confidence: generatorAgent.score * 100,
				reasoning: `Generation task - matched document generator with ${(generatorAgent.score * 100).toFixed(0)}% confidence`,
			};
		}
	}

	// For tasks requiring browser/code, use CUGA
	if (
		taskAnalysis.requiredCapabilities.some(
			(rc) =>
				rc.importance === "required" &&
				(rc.type === "browserAutomation" ||
					rc.type === "codeExecution"),
		)
	) {
		const cugaAgent = agentMatches.find(
			(a) =>
				a.descriptor.capabilities.browserAutomation?.enabled ||
				a.descriptor.capabilities.codeExecution?.enabled,
		);
		if (cugaAgent) {
			return {
				primaryCapability: "agent",
				primaryId: cugaAgent.descriptor.agentId,
				confidence: cugaAgent.score * 100,
				reasoning: `Task requires browser/code execution - matched CUGA with ${(cugaAgent.score * 100).toFixed(0)}% confidence`,
			};
		}
	}

	// Best overall match
	const bestAgent = agentMatches[0];
	const bestTool = toolMatches[0];

	if (!bestAgent && !bestTool) {
		return {
			primaryCapability: "llm",
			primaryId: "llm",
			confidence: 50,
			reasoning:
				"No strong capability matches - using LLM for direct generation",
		};
	}

	if (!bestAgent) {
		return {
			primaryCapability: "tool",
			primaryId: bestTool.descriptor.toolId,
			confidence: bestTool.score * 100,
			reasoning: `Best match is MCP tool with ${(bestTool.score * 100).toFixed(0)}% confidence`,
		};
	}

	if (!bestTool) {
		return {
			primaryCapability: "agent",
			primaryId: bestAgent.descriptor.agentId,
			confidence: bestAgent.score * 100,
			reasoning: `Best match is agent with ${(bestAgent.score * 100).toFixed(0)}% confidence`,
		};
	}

	// Compare best agent vs best tool
	// Prefer tools for simple operations, agents for complex ones
	if (
		taskAnalysis.complexity === "simple" &&
		bestTool.score >= bestAgent.score - 0.1
	) {
		return {
			primaryCapability: "tool",
			primaryId: bestTool.descriptor.toolId,
			confidence: bestTool.score * 100,
			reasoning: `Simple task - MCP tool preferred with ${(bestTool.score * 100).toFixed(0)}% confidence`,
		};
	}

	return {
		primaryCapability: "agent",
		primaryId: bestAgent.descriptor.agentId,
		confidence: bestAgent.score * 100,
		reasoning: `Best overall match is agent with ${(bestAgent.score * 100).toFixed(0)}% confidence`,
	};
}

// =============================================================================
// Learning Functions
// =============================================================================

/**
 * Update descriptor with usage metrics after execution.
 */
export function updateDescriptorMetrics<
	T extends AgentCapabilityDescriptor | ToolCapabilityDescriptor,
>(
	descriptor: T,
	executionResult: {
		success: boolean;
		durationMs: number;
		error?: string;
	},
): T {
	const now = new Date();

	// Update usage count
	descriptor.usageCount += 1;
	descriptor.lastUsed = now;

	// Update success rate (exponential moving average)
	const alpha = 0.2; // Smoothing factor
	const newSuccessValue = executionResult.success ? 1 : 0;
	descriptor.successRate =
		alpha * newSuccessValue + (1 - alpha) * descriptor.successRate;

	// Update average response time
	descriptor.avgResponseTimeMs =
		alpha * executionResult.durationMs +
		(1 - alpha) * descriptor.avgResponseTimeMs;

	descriptor.updatedAt = now;

	return descriptor;
}

/**
 * Add error pattern to tool descriptor for learning.
 */
export function addToolErrorPattern(
	descriptor: ToolCapabilityDescriptor,
	args: Record<string, unknown>,
	errorMessage: string,
): ToolCapabilityDescriptor {
	const existingPattern = descriptor.commonErrors.find(
		(e) => e.errorMessage === errorMessage,
	);

	if (existingPattern) {
		existingPattern.occurrences += 1;
		existingPattern.lastOccurrence = new Date();
	} else {
		descriptor.commonErrors.push({
			pattern: JSON.stringify(args),
			errorMessage,
			occurrences: 1,
			lastOccurrence: new Date(),
		});
	}

	// Keep only top 10 error patterns
	descriptor.commonErrors = descriptor.commonErrors
		.sort((a, b) => b.occurrences - a.occurrences)
		.slice(0, 10);

	return descriptor;
}

/**
 * Add successful args pattern to tool descriptor.
 */
export function addToolSuccessPattern(
	descriptor: ToolCapabilityDescriptor,
	args: Record<string, unknown>,
): ToolCapabilityDescriptor {
	// Add to successful patterns (keep last 5)
	descriptor.successfulArgsPatterns.push(args);
	if (descriptor.successfulArgsPatterns.length > 5) {
		descriptor.successfulArgsPatterns =
			descriptor.successfulArgsPatterns.slice(-5);
	}

	return descriptor;
}
