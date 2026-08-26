/**
 * Step Assigner
 *
 * Assigns the optimal executor (MCP tool, agent, workflow) to each step
 * based on capability matching and priority ordering.
 *
 * Priority Order (from Anthropic's Advanced Tool Use):
 * 1. MCP Tools - Direct API access, fastest, most deterministic
 * 2. Specialized Agents - Domain-specific agents with workspace access
 * 3. Workflow Triggers - Pre-defined multi-step automations
 * 4. LLM Generation - Direct LLM for simple generation tasks
 * 5. Generalist Agents (CUGA) - Browser/code execution as last resort
 *
 * IMPROVED (Anthropic Tool Search Pattern):
 * - Uses KEYWORDS section for BM25-style deterministic matching
 * - Prioritizes original user message over LLM-generated step descriptions
 * - Hybrid scoring combines keyword + semantic relevance
 */

import { extractKeywordsFromDescription } from "../tools/capability-keywords";
import type {
	AgentCardCapabilities,
	Capability,
	CapabilityMatch,
	TaskStep,
} from "../types";

// =============================================================================
// Types
// =============================================================================

export type CapabilityType =
	| "mcp_tool"
	| "integration"
	| "agent"
	| "workflow"
	| "llm"
	| "web";

/**
 * Priority order for capability types.
 * Lower number = higher priority.
 */
export const CAPABILITY_PRIORITY: Record<CapabilityType, number> = {
	mcp_tool: 1, // Highest - direct, deterministic
	integration: 2, // Workflow integrations (Slack, email, webhooks)
	agent: 3, // Specialized agents
	workflow: 4, // Pre-defined workflows
	llm: 5, // LLM generation
	web: 6, // Browser automation (last resort)
};

/**
 * Requirements extracted from a task step.
 */
export interface TaskRequirements {
	/** Does the step need MCP tool access? */
	needsMcpAccess: boolean;
	/** Does the step need workspace/document access? */
	needsWorkspaceAccess: boolean;
	/** Does the step need browser automation? */
	needsBrowserAutomation: boolean;
	/** Does the step need code execution? */
	needsCodeExecution: boolean;
	/** Is this a read-only operation? */
	isReadOnly: boolean;
	/** Services/tools mentioned in the step */
	involvedServices: string[];
	/** Keywords that hint at requirements */
	keywords: string[];
}

/**
 * Result of assigning an executor to a step.
 */
export interface StepAssignment {
	/** Step ID */
	stepId: string;
	/** Step description */
	stepDescription: string;
	/** Required capabilities for this step */
	requiredCapabilities: string[];
	/** Assigned executor */
	assignedExecutor: {
		type:
			| CapabilityType
			| "agent"
			| "mcp_tool"
			| "workflow"
			| "workspace_op";
		id: string;
		name: string;
		reason: string;
	};
	/** Confidence in the assignment (0-1) */
	confidence: number;
	/** Whether approval is required */
	requiresApproval: boolean;
	/** Risk level */
	riskLevel: "low" | "medium" | "high" | "critical";
}

// =============================================================================
// Requirement Analysis
// =============================================================================

/**
 * Known MCP service keywords for detection.
 */
const MCP_SERVICE_KEYWORDS = [
	"fizzy",
	"fizzyboard",
	"kanban",
	"card",
	"board",
	"slack",
	"message",
	"channel",
	"github",
	"repository",
	"commit",
	"pull request",
	"firecrawl",
	"scrape",
	"crawl",
	"linear",
	"issue",
	"jira",
	"confluence",
	"notion",
	"google",
	"calendar",
	"email",
	// Fabric AI keywords
	"youtube",
	"video",
	"transcript",
	"fabric",
	"pattern",
	"summarize",
	"analyze",
	"web search",
	"audio",
	"transcribe",
	// MCP CLI / Dynamic discovery keywords
	"deepwiki",
	"context7",
	"wiki",
	"documentation",
	"library docs",
	"open source",
	"opensource",
	"mcp tool",
	"mcp server",
];

/**
 * Keywords that suggest browser automation is needed.
 */
const BROWSER_KEYWORDS = [
	"browser",
	"navigate",
	"click",
	"fill form",
	"screenshot",
	"dom",
	"webpage",
	"website",
	"login",
	"automate web",
];

/**
 * Keywords that suggest code execution is needed.
 */
const CODE_KEYWORDS = [
	"execute code",
	"run python",
	"run javascript",
	"script",
	"calculate",
	"compute",
	"analyze data",
	"process file",
];

/**
 * Keywords that suggest workspace access is needed.
 */
const WORKSPACE_KEYWORDS = [
	"workspace",
	"document",
	"project",
	"file",
	"folder",
	"rag",
	"retrieval",
	"context",
];

/**
 * Extract KEYWORDS from a tool description.
 * Uses the shared implementation from capability-keywords module.
 *
 * @deprecated Use extractKeywordsFromDescription from capability-keywords instead
 */
function extractToolKeywords(description: string): string[] {
	return extractKeywordsFromDescription(description);
}

/**
 * Analyze step requirements based on description.
 */
export function analyzeStepRequirements(step: TaskStep): TaskRequirements {
	const descLower = step.description.toLowerCase();
	const words = descLower.split(/\s+/);

	// Detect MCP services
	const involvedServices: string[] = [];
	for (const keyword of MCP_SERVICE_KEYWORDS) {
		if (descLower.includes(keyword)) {
			involvedServices.push(keyword);
		}
	}

	// Detect browser needs
	const needsBrowserAutomation = BROWSER_KEYWORDS.some((kw) =>
		descLower.includes(kw),
	);

	// Detect code execution needs
	const needsCodeExecution = CODE_KEYWORDS.some((kw) =>
		descLower.includes(kw),
	);

	// Detect workspace needs
	const needsWorkspaceAccess = WORKSPACE_KEYWORDS.some((kw) =>
		descLower.includes(kw),
	);

	// Detect MCP needs (based on services or explicit mention)
	const needsMcpAccess =
		involvedServices.length > 0 || descLower.includes("mcp");

	// Detect if read-only
	const writeKeywords = [
		"create",
		"add",
		"update",
		"modify",
		"delete",
		"remove",
		"post",
		"send",
		"write",
	];
	const isReadOnly = !writeKeywords.some((kw) => descLower.includes(kw));

	// Extract significant keywords
	const keywords = words.filter((w) => w.length > 4);

	return {
		needsMcpAccess,
		needsWorkspaceAccess,
		needsBrowserAutomation,
		needsCodeExecution,
		isReadOnly,
		involvedServices,
		keywords,
	};
}

// =============================================================================
// Suitability Filtering
// =============================================================================

/**
 * Check if a capability is suitable for a step's requirements.
 */
export function isCapabilitySuitable(
	capability: Capability | CapabilityMatch,
	requirements: TaskRequirements,
): { suitable: boolean; reason: string } {
	const cap = "capability" in capability ? capability.capability : capability;

	// For agents, check their specific capabilities
	if (cap.type === "agent" && cap.agentCapabilities) {
		const agentCaps = cap.agentCapabilities;

		// Check MCP access requirement
		if (requirements.needsMcpAccess && !agentCaps.hasMcpAccess) {
			return {
				suitable: false,
				reason: "Agent cannot access MCP tools but step requires MCP",
			};
		}

		// Check workspace access requirement
		if (
			requirements.needsWorkspaceAccess &&
			!agentCaps.hasWorkspaceAccess
		) {
			return {
				suitable: false,
				reason: "Agent cannot access workspace but step requires workspace access",
			};
		}

		// Check browser requirement
		if (
			requirements.needsBrowserAutomation &&
			!agentCaps.browserAutomation
		) {
			return {
				suitable: false,
				reason: "Agent cannot do browser automation but step requires it",
			};
		}

		// Check code execution requirement
		if (requirements.needsCodeExecution && !agentCaps.codeExecution) {
			return {
				suitable: false,
				reason: "Agent cannot execute code but step requires it",
			};
		}

		// Check limitations
		if (agentCaps.limitations) {
			for (const limitation of agentCaps.limitations) {
				const limitLower = limitation.toLowerCase();

				if (requirements.needsMcpAccess && limitLower.includes("mcp")) {
					return {
						suitable: false,
						reason: `Agent limitation: ${limitation}`,
					};
				}

				if (
					requirements.needsWorkspaceAccess &&
					limitLower.includes("workspace")
				) {
					return {
						suitable: false,
						reason: `Agent limitation: ${limitation}`,
					};
				}
			}
		}
	}

	// MCP tools are suitable if step needs MCP access
	if (cap.type === "mcp_tool" && requirements.needsMcpAccess) {
		return { suitable: true, reason: "MCP tool matches MCP requirement" };
	}

	// MCP tools are NOT suitable if step needs browser/code
	if (cap.type === "mcp_tool") {
		if (requirements.needsBrowserAutomation) {
			return {
				suitable: false,
				reason: "MCP tools cannot do browser automation",
			};
		}
		if (requirements.needsCodeExecution) {
			return {
				suitable: false,
				reason: "MCP tools cannot execute code",
			};
		}
	}

	return { suitable: true, reason: "Capability meets requirements" };
}

// =============================================================================
// Step Assignment
// =============================================================================

/**
 * Assign the optimal executor to a step based on capability matches.
 */
export function assignStepExecutor(
	step: TaskStep,
	capabilityMatches: CapabilityMatch[],
	requirements?: TaskRequirements,
): StepAssignment {
	// Analyze requirements if not provided
	const reqs = requirements || analyzeStepRequirements(step);

	// Filter by suitability
	const suitableMatches = capabilityMatches.filter((match) => {
		const { suitable } = isCapabilitySuitable(match, reqs);
		return suitable;
	});

	// Sort by priority and score
	const sortedMatches = [...suitableMatches].sort((a, b) => {
		// First by capability type priority
		const priorityA =
			CAPABILITY_PRIORITY[a.capability.type as CapabilityType] || 99;
		const priorityB =
			CAPABILITY_PRIORITY[b.capability.type as CapabilityType] || 99;

		if (priorityA !== priorityB) {
			return priorityA - priorityB;
		}

		// Then by match score
		return b.score - a.score;
	});

	// Get best match or use fallback
	const bestMatch = sortedMatches[0];

	if (bestMatch) {
		const cap = bestMatch.capability;
		return {
			stepId: step.id,
			stepDescription: step.description,
			requiredCapabilities: reqs.keywords.slice(0, 5),
			assignedExecutor: {
				type: cap.type as CapabilityType,
				id: cap.id,
				name: cap.name,
				reason:
					bestMatch.suggestedUse ||
					`Best match with score ${bestMatch.score.toFixed(2)}`,
			},
			confidence: bestMatch.score,
			requiresApproval: cap.requiresApproval,
			riskLevel: cap.riskLevel,
		};
	}

	// Fallback: LLM generation
	return {
		stepId: step.id,
		stepDescription: step.description,
		requiredCapabilities: reqs.keywords.slice(0, 5),
		assignedExecutor: {
			type: "llm",
			id: "llm_fallback",
			name: "LLM Generation",
			reason: "No suitable capability found, using LLM fallback",
		},
		confidence: 0.3,
		requiresApproval: false,
		riskLevel: "low",
	};
}

/**
 * Assign executors to multiple steps.
 *
 * @param steps - The steps to assign executors to
 * @param capabilityMatches - The available capabilities to match against
 * @param originalUserMessage - Optional original user message for better relevance scoring.
 *                              This helps when LLM-generated step descriptions don't capture
 *                              the user's exact intent (e.g., user says "transcript" but LLM
 *                              generates "extract content").
 */
export function assignStepExecutors(
	steps: TaskStep[],
	capabilityMatches: CapabilityMatch[],
	originalUserMessage?: string,
): StepAssignment[] {
	// Pre-process original user message for matching
	const userMessageLower = originalUserMessage?.toLowerCase() || "";

	return steps.map((step) => {
		// Filter matches relevant to this step
		// Also consider the original user message for better intent matching
		const stepDescription = step.description.toLowerCase();

		// Score each match for relevance (higher = better match)
		const scoredMatches: Array<{
			match: CapabilityMatch;
			relevanceScore: number;
		}> = [];

		for (const match of capabilityMatches) {
			// Check if capability matches step description
			const capName = match.capability.name.toLowerCase();
			const capDesc = match.capability.description?.toLowerCase() || "";
			const capId = match.capability.id.toLowerCase();

			// Extract explicit KEYWORDS from tool description (BM25-style matching)
			const toolKeywords = extractToolKeywords(capDesc);

			let relevanceScore = 0;

			// PRIORITY 0: Check KEYWORDS section first (BM25-style exact phrase matching)
			// This is the most deterministic - matches user language directly
			if (toolKeywords.length > 0) {
				const combinedInput = `${stepDescription} ${userMessageLower}`;
				const matchingKeywords = toolKeywords.filter((kw) =>
					combinedInput.includes(kw),
				);

				if (matchingKeywords.length > 0) {
					// Keyword matches are highly deterministic - give strong scores
					// More matching keywords = higher score
					const keywordMatchRatio =
						matchingKeywords.length / toolKeywords.length;

					if (keywordMatchRatio >= 0.5) {
						// Multiple keyword matches - very high confidence
						relevanceScore = 95;
					} else if (matchingKeywords.length >= 1) {
						// At least one keyword match - good confidence
						relevanceScore = 85;
					}
				}
			}

			// PRIORITY 1: Exact ID match in step description (highest priority)
			// e.g., "use fabric_youtube_transcript to extract" contains "fabric_youtube_transcript"
			if (relevanceScore < 100 && stepDescription.includes(capId)) {
				relevanceScore = 100;
			}
			// PRIORITY 1.5: For integrations, check if the provider name matches
			// e.g., "GitHub: example-user" should match if step mentions "github"
			else if (
				relevanceScore < 95 &&
				match.capability.type === "integration"
			) {
				// Extract provider from integration name (e.g., "GitHub" from "GitHub: example-user")
				const providerMatch = match.capability.name.match(/^([^:]+):/);
				const providerName = providerMatch
					? providerMatch[1].toLowerCase().trim()
					: "";

				// Check if step or user message mentions this provider
				const combinedInput = `${stepDescription} ${userMessageLower}`;
				if (providerName && combinedInput.includes(providerName)) {
					// Strong match for integration provider
					relevanceScore = 90;
				}
			}
			// PRIORITY 2: Exact name match
			else if (relevanceScore < 90 && stepDescription.includes(capName)) {
				relevanceScore = Math.max(relevanceScore, 90);
			}
			// PRIORITY 3: Check for discriminating word combinations
			// e.g., "youtube transcript" should match fabric_youtube_transcript, not fabric_youtube_metadata
			else if (relevanceScore < 80) {
				const genericWords = [
					"fabric",
					"tool",
					"api",
					"service",
					"get",
					"list",
					"create",
					"update",
					"delete",
				];

				// Get meaningful words from capability name/id
				const nameWords = capName
					.split(/[_\s-]/)
					.filter((w) => w.length > 2 && !genericWords.includes(w));
				const idWords = capId
					.split(/[_\s-]/)
					.filter((w) => w.length > 2 && !genericWords.includes(w));
				const allCapWords = [...new Set([...nameWords, ...idWords])];

				// Count how many discriminating words match
				const matchingWords = allCapWords.filter((word) =>
					stepDescription.includes(word),
				);
				const matchRatio =
					allCapWords.length > 0
						? matchingWords.length / allCapWords.length
						: 0;

				// Require ALL discriminating words to match for strong match (score 70-80)
				// This prevents "youtube" alone from matching both transcript and metadata
				if (matchRatio === 1 && matchingWords.length >= 2) {
					relevanceScore = 80;
				} else if (matchRatio >= 0.5 && matchingWords.length >= 2) {
					// At least half the words match with 2+ words
					relevanceScore = 50 + matchRatio * 30;
				} else if (matchingWords.length >= 1) {
					// Single word match - low score, easily overridden by better matches
					relevanceScore = 20 + matchingWords.length * 5;
				}

				// Description words match (key words from capability description)
				const descWords = capDesc
					.split(/\s+/)
					.filter((w) => w.length > 4);
				const matchingDescWords = descWords.filter((word) =>
					stepDescription.includes(word),
				);
				if (matchingDescWords.length >= 2) {
					relevanceScore = Math.max(relevanceScore, 30);
				}

				// Matched needs match
				if (
					match.matchedNeeds.some((need) =>
						stepDescription.includes(need.toLowerCase()),
					)
				) {
					relevanceScore = Math.max(relevanceScore, 25);
				}

				// IMPORTANT: Also check original user message for discriminating words
				// This catches cases where the LLM-generated step description doesn't capture
				// the user's exact intent (e.g., user says "transcript" but LLM says "extract content")
				if (userMessageLower && relevanceScore < 80) {
					const userMatchingWords = allCapWords.filter((word) =>
						userMessageLower.includes(word),
					);
					const userMatchRatio =
						allCapWords.length > 0
							? userMatchingWords.length / allCapWords.length
							: 0;

					// If user message matches ALL discriminating words, give a significant boost
					if (userMatchRatio === 1 && userMatchingWords.length >= 2) {
						relevanceScore = Math.max(relevanceScore, 85); // Higher than step-only match
					} else if (
						userMatchRatio >= 0.5 &&
						userMatchingWords.length >= 2
					) {
						relevanceScore = Math.max(relevanceScore, 60);
					}
				}
			}

			if (relevanceScore > 0) {
				scoredMatches.push({ match, relevanceScore });
			}
		}

		// Sort by relevance score (descending) to get best matches first
		scoredMatches.sort((a, b) => b.relevanceScore - a.relevanceScore);

		// IMPORTANT: Update the match scores with relevance scores (normalized to 0-1)
		// This ensures assignStepExecutor's secondary sort by score uses relevance, not semantic search score
		// Relevance scoring: 100 = exact ID, 90 = exact name, 80 = all words match, etc.
		const relevantMatches = scoredMatches.map((sm) => ({
			...sm.match,
			// Override the semantic score with normalized relevance score
			// This preserves relevance-based ordering when assignStepExecutor sorts
			score: sm.relevanceScore / 100,
		}));

		// If no specific matches, use all matches
		const matchesToUse =
			relevantMatches.length > 0 ? relevantMatches : capabilityMatches;

		return assignStepExecutor(step, matchesToUse);
	});
}

/**
 * Check if a step should be handled by MCP direct mode.
 */
export function shouldUseMcpDirect(
	step: TaskStep,
	capabilityMatches: CapabilityMatch[],
): boolean {
	const requirements = analyzeStepRequirements(step);

	// If step needs browser or code, don't use MCP direct
	if (
		requirements.needsBrowserAutomation ||
		requirements.needsCodeExecution
	) {
		return false;
	}

	// If step needs MCP and there are MCP tool matches
	if (requirements.needsMcpAccess) {
		const mcpMatches = capabilityMatches.filter(
			(m) => m.capability.type === "mcp_tool" && m.score > 0.5,
		);
		return mcpMatches.length > 0;
	}

	return false;
}

/**
 * Get recommended delegation mode for a step.
 */
export function getRecommendedDelegationMode(
	_step: TaskStep,
	agentCapabilities?: AgentCardCapabilities,
): "complete-task" | "single-step" {
	// If agent can handle complete tasks autonomously
	if (
		agentCapabilities?.autonomousExecution &&
		agentCapabilities?.taskDecomposition &&
		(agentCapabilities?.maxAutonomyLevel === "task" ||
			agentCapabilities?.maxAutonomyLevel === "session")
	) {
		return "complete-task";
	}

	return "single-step";
}
