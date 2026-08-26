/**
 * Operation Risk Detector
 *
 * Centralized, robust system for detecting destructive operations and assigning risk levels.
 * This module implements defense-in-depth with multiple detection layers:
 *
 * 1. Keyword-based detection (description, executor, tool names)
 * 2. Tool name pattern matching (e.g., _delete_, _remove_)
 * 3. Semantic intent detection (for edge cases)
 * 4. Default-deny for unknown operations with high-risk indicators
 *
 * IMPORTANT: When in doubt, err on the side of requiring approval.
 * False positives (asking for approval when not needed) are acceptable.
 * False negatives (executing destructive operations without approval) are NOT.
 */

export type RiskLevel = "critical" | "high" | "medium" | "low";

export interface RiskAssessment {
	riskLevel: RiskLevel;
	requiresApproval: boolean;
	operationType: OperationType;
	confidence: number; // 0-1, how confident we are in this assessment
	detectionMethod: string;
	matchedPatterns: string[];
}

export type OperationType = "delete" | "create" | "update" | "read" | "unknown";

// =============================================================================
// DESTRUCTIVE OPERATION PATTERNS
// Organized by severity and grouped logically for maintainability
// =============================================================================

/**
 * DELETE operations - CRITICAL risk, ALWAYS require approval
 * These operations result in permanent data loss.
 */
const DELETE_PATTERNS = {
	// Primary delete keywords
	verbs: [
		"delete",
		"remove",
		"destroy",
		"purge",
		"erase",
		"wipe",
		"obliterate",
		"annihilate",
		"terminate",
		"kill",
		"drop", // database operations
		"truncate", // database operations
	],
	// Common abbreviations and variations
	abbreviations: ["del", "rm", "rmv"],
	// Tool name patterns (e.g., fizzy_delete_board, trello_remove_card)
	toolPatterns: [
		/_delete_/,
		/_remove_/,
		/_destroy_/,
		/_purge_/,
		/_drop_/,
		/_truncate_/,
		/delete$/,
		/remove$/,
		/destroy$/,
	],
	// Phrases that indicate deletion intent
	phrases: [
		"get rid of",
		"throw away",
		"clean up",
		"clear out",
		"empty",
		"reset to default",
		"factory reset",
		"uninstall",
		"unregister",
		"deregister",
		"revoke",
		"invalidate",
		"cancel",
	],
} as const;

/**
 * CREATE operations - HIGH risk, require approval
 * These operations create new resources that may have side effects.
 */
const CREATE_PATTERNS = {
	verbs: [
		"create",
		"add",
		"insert",
		"post",
		"make",
		"generate",
		"spawn",
		"initialize",
		"init",
		"setup",
		"provision",
		"deploy",
		"launch",
		"start",
		"register",
		"enroll",
		"subscribe",
		"upsert", // create-or-update
	],
	abbreviations: ["mk", "new"],
	toolPatterns: [
		/_create_/,
		/_add_/,
		/_insert_/,
		/_post_/,
		/_upsert_/,
		/_register_/,
		/create$/,
		/add$/,
		/insert$/,
		/upsert$/,
	],
	phrases: [
		"set up",
		"spin up",
		"bring up",
		"stand up",
		"new instance",
		"new resource",
	],
} as const;

/**
 * UPDATE operations - MEDIUM risk (HIGH if bulk), require approval
 * These operations modify existing resources.
 */
const UPDATE_PATTERNS = {
	verbs: [
		"update",
		"modify",
		"edit",
		"change",
		"patch",
		"put",
		"alter",
		"adjust",
		"revise",
		"amend",
		"fix",
		"correct",
		"overwrite",
		"replace",
		"rename",
		"move",
		"migrate",
		"transform",
		"convert",
		"upgrade",
		"downgrade",
		"enable",
		"disable",
		"activate",
		"deactivate",
		"toggle",
		"switch",
		"set",
		"assign",
		"reassign",
		"transfer",
	],
	abbreviations: ["upd", "mod"],
	toolPatterns: [
		/_update_/,
		/_modify_/,
		/_edit_/,
		/_patch_/,
		/_put_/,
		/_rename_/,
		/_move_/,
		/update$/,
		/modify$/,
		/edit$/,
	],
	phrases: ["make changes to", "apply changes", "save changes"],
} as const;

/**
 * READ operations - LOW risk, typically don't require approval
 * These operations only retrieve data without modifications.
 */
const READ_PATTERNS = {
	verbs: [
		"get",
		"list",
		"search",
		"query",
		"fetch",
		"retrieve",
		"show",
		"display",
		"find",
		"view",
		"read",
		"load",
		"lookup",
		"browse",
		"inspect",
		"examine",
		"check",
		"verify",
		"validate",
		"count",
		"describe",
		"explain",
		"summarize",
		"analyze",
		"report",
		"export", // read-only export
		"download",
	],
	abbreviations: [],
	toolPatterns: [
		/_get_/,
		/_list_/,
		/_search_/,
		/_query_/,
		/_fetch_/,
		/_find_/,
		/get$/,
		/list$/,
		/search$/,
	],
	phrases: [
		"look up",
		"look at",
		"tell me about",
		"what is",
		"how many",
		"show me",
	],
} as const;

/**
 * BULK operation modifiers - Escalate risk level when combined with destructive ops
 */
const BULK_PATTERNS = {
	keywords: [
		"bulk",
		"batch",
		"mass",
		"multiple",
		"several",
		"many",
		"numerous",
		"various",
		"every",
		"each",
	],
	phrases: [
		"all of",
		"all the",
		"entire",
		"everything",
		"whole",
		"complete",
		"full",
	],
} as const;

/**
 * NEGATION patterns - These NEGATE destructive intent
 * "don't delete" or "without removing" should NOT trigger approval
 */
const NEGATION_PATTERNS = [
	"don't",
	"dont",
	"do not",
	"doesn't",
	"does not",
	"won't",
	"will not",
	"wouldn't",
	"would not",
	"shouldn't",
	"should not",
	"can't",
	"cannot",
	"never",
	"without",
	"except",
	"excluding",
	"avoid",
	"skip",
	"prevent",
	"stop",
	"not to",
];

// =============================================================================
// DETECTION FUNCTIONS
// =============================================================================

/**
 * Check if text contains a pattern with word boundary awareness
 */
function containsWord(text: string, word: string): boolean {
	// Create a regex that matches the word with word boundaries
	// This prevents "get" from matching "target"
	const regex = new RegExp(`\\b${escapeRegex(word)}\\b`, "i");
	return regex.test(text);
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if a destructive keyword is negated in the text
 * Returns true if the keyword appears to be negated
 */
function isNegated(text: string, keyword: string): boolean {
	const lowerText = text.toLowerCase();
	const keywordIndex = lowerText.indexOf(keyword.toLowerCase());

	if (keywordIndex === -1) {
		return false;
	}

	// Check for negation words in the ~30 chars before the keyword
	const contextBefore = lowerText.slice(
		Math.max(0, keywordIndex - 30),
		keywordIndex,
	);

	return NEGATION_PATTERNS.some((neg) => contextBefore.includes(neg));
}

/**
 * Check patterns against text with negation awareness
 */
function checkPatterns(
	text: string,
	patterns: { verbs: readonly string[]; abbreviations: readonly string[] },
	checkNegation = true,
): { matched: boolean; matchedPattern: string | null } {
	const lowerText = text.toLowerCase();

	// Check verbs
	for (const verb of patterns.verbs) {
		if (containsWord(lowerText, verb)) {
			if (checkNegation && isNegated(text, verb)) {
				continue; // Skip negated patterns
			}
			return { matched: true, matchedPattern: verb };
		}
	}

	// Check abbreviations
	for (const abbr of patterns.abbreviations) {
		if (containsWord(lowerText, abbr)) {
			if (checkNegation && isNegated(text, abbr)) {
				continue;
			}
			return { matched: true, matchedPattern: abbr };
		}
	}

	return { matched: false, matchedPattern: null };
}

/**
 * Check tool name against patterns
 */
function checkToolPatterns(
	toolName: string,
	patterns: readonly RegExp[],
): { matched: boolean; matchedPattern: string | null } {
	const lowerTool = toolName.toLowerCase();

	for (const pattern of patterns) {
		if (pattern.test(lowerTool)) {
			return { matched: true, matchedPattern: pattern.source };
		}
	}

	return { matched: false, matchedPattern: null };
}

/**
 * Check if operation is bulk/batch
 */
function isBulkOperation(text: string): boolean {
	const lowerText = text.toLowerCase();

	// Check keywords
	for (const keyword of BULK_PATTERNS.keywords) {
		if (containsWord(lowerText, keyword)) {
			return true;
		}
	}

	// Check phrases
	for (const phrase of BULK_PATTERNS.phrases) {
		if (lowerText.includes(phrase)) {
			return true;
		}
	}

	return false;
}

// =============================================================================
// MAIN DETECTION API
// =============================================================================

export interface DetectionInput {
	/** Step description from the task plan */
	description: string;
	/** Executor name (e.g., agent ID) */
	executor?: string | null;
	/** Tool names that will be used */
	toolNames?: string[];
	/** Step type (e.g., "api", "research", "generate") */
	stepType?: string;
	/** Any additional context for detection */
	additionalContext?: string;
}

/**
 * Detect the risk level and approval requirement for an operation.
 *
 * This is the main entry point for risk detection. It applies multiple
 * detection layers and returns a comprehensive risk assessment.
 *
 * @param input - Detection input containing description, executor, tool names, etc.
 * @returns Risk assessment with level, approval requirement, and detection details
 */
export function detectOperationRisk(input: DetectionInput): RiskAssessment {
	const {
		description,
		executor,
		toolNames = [],
		stepType,
		additionalContext,
	} = input;

	const matchedPatterns: string[] = [];
	let operationType: OperationType = "unknown";
	let detectionMethod = "";

	// Combine all text sources for analysis
	const fullText = [
		description,
		executor,
		additionalContext,
		stepType === "research" ? "research query" : "",
	]
		.filter(Boolean)
		.join(" ");

	const executorLower = (executor || "").toLowerCase();

	// ==========================================================================
	// LAYER 1: Check for DELETE operations (CRITICAL risk)
	// ==========================================================================
	const deleteCheck = checkPatterns(fullText, DELETE_PATTERNS);
	if (deleteCheck.matched) {
		matchedPatterns.push(`description:${deleteCheck.matchedPattern}`);
		operationType = "delete";
		detectionMethod = "keyword_description";
	}

	// Check executor for delete patterns
	if (operationType !== "delete" && executorLower) {
		const execDeleteCheck = checkPatterns(
			executorLower,
			DELETE_PATTERNS,
			false,
		);
		if (execDeleteCheck.matched) {
			matchedPatterns.push(`executor:${execDeleteCheck.matchedPattern}`);
			operationType = "delete";
			detectionMethod = "keyword_executor";
		}
	}

	// Check tool names for delete patterns
	if (operationType !== "delete") {
		for (const toolName of toolNames) {
			const toolDeleteCheck = checkToolPatterns(
				toolName,
				DELETE_PATTERNS.toolPatterns,
			);
			if (toolDeleteCheck.matched) {
				matchedPatterns.push(
					`tool:${toolName}:${toolDeleteCheck.matchedPattern}`,
				);
				operationType = "delete";
				detectionMethod = "tool_pattern";
				break;
			}
		}
	}

	// ==========================================================================
	// LAYER 2: Check for CREATE operations (HIGH risk)
	// ==========================================================================
	if (operationType === "unknown") {
		const createCheck = checkPatterns(fullText, CREATE_PATTERNS);
		if (createCheck.matched) {
			matchedPatterns.push(`description:${createCheck.matchedPattern}`);
			operationType = "create";
			detectionMethod = "keyword_description";
		}

		// Check tool names for create patterns
		if (operationType === "unknown") {
			for (const toolName of toolNames) {
				const toolCreateCheck = checkToolPatterns(
					toolName,
					CREATE_PATTERNS.toolPatterns,
				);
				if (toolCreateCheck.matched) {
					matchedPatterns.push(
						`tool:${toolName}:${toolCreateCheck.matchedPattern}`,
					);
					operationType = "create";
					detectionMethod = "tool_pattern";
					break;
				}
			}
		}
	}

	// ==========================================================================
	// LAYER 3: Check for UPDATE operations (MEDIUM risk)
	// ==========================================================================
	if (operationType === "unknown") {
		const updateCheck = checkPatterns(fullText, UPDATE_PATTERNS);
		if (updateCheck.matched) {
			matchedPatterns.push(`description:${updateCheck.matchedPattern}`);
			operationType = "update";
			detectionMethod = "keyword_description";
		}

		// Check tool names for update patterns
		if (operationType === "unknown") {
			for (const toolName of toolNames) {
				const toolUpdateCheck = checkToolPatterns(
					toolName,
					UPDATE_PATTERNS.toolPatterns,
				);
				if (toolUpdateCheck.matched) {
					matchedPatterns.push(
						`tool:${toolName}:${toolUpdateCheck.matchedPattern}`,
					);
					operationType = "update";
					detectionMethod = "tool_pattern";
					break;
				}
			}
		}
	}

	// ==========================================================================
	// LAYER 4: Check for READ operations (LOW risk)
	// ==========================================================================
	if (operationType === "unknown") {
		const readCheck = checkPatterns(fullText, READ_PATTERNS);
		if (readCheck.matched) {
			matchedPatterns.push(`description:${readCheck.matchedPattern}`);
			operationType = "read";
			detectionMethod = "keyword_description";
		}

		// Check step type
		if (operationType === "unknown" && stepType === "research") {
			operationType = "read";
			detectionMethod = "step_type";
		}

		// Check tool names for read patterns
		if (operationType === "unknown") {
			for (const toolName of toolNames) {
				const toolReadCheck = checkToolPatterns(
					toolName,
					READ_PATTERNS.toolPatterns,
				);
				if (toolReadCheck.matched) {
					matchedPatterns.push(
						`tool:${toolName}:${toolReadCheck.matchedPattern}`,
					);
					operationType = "read";
					detectionMethod = "tool_pattern";
					break;
				}
			}
		}
	}

	// ==========================================================================
	// DETERMINE RISK LEVEL AND APPROVAL REQUIREMENT
	// ==========================================================================
	const isBulk = isBulkOperation(fullText);
	let riskLevel: RiskLevel;
	let requiresApproval: boolean;
	let confidence: number;

	switch (operationType) {
		case "delete":
			// Delete operations are ALWAYS critical and require approval
			riskLevel = "critical";
			requiresApproval = true;
			confidence = 0.95;
			break;

		case "create":
			// Create operations are high risk
			riskLevel = isBulk ? "critical" : "high";
			requiresApproval = true;
			confidence = 0.9;
			break;

		case "update":
			// Update operations are medium risk, but bulk updates are critical
			riskLevel = isBulk ? "critical" : "medium";
			requiresApproval = true;
			confidence = 0.85;
			break;

		case "read":
			// Read operations are generally safe
			riskLevel = "low";
			requiresApproval = false;
			confidence = 0.9;
			break;
		default:
			// Unknown operations: default to requiring approval for safety
			// "When in doubt, ask"
			if (isBulk) {
				riskLevel = "high";
				requiresApproval = true;
				confidence = 0.5;
			} else {
				// Default to medium risk for unknown operations
				// This is a conservative approach - better to ask than to accidentally
				// execute a destructive operation
				riskLevel = "medium";
				requiresApproval = true;
				confidence = 0.3;
			}
			detectionMethod = detectionMethod || "default_unknown";
			break;
	}

	// Add bulk indicator to matched patterns if applicable
	if (isBulk) {
		matchedPatterns.push("modifier:bulk");
	}

	return {
		riskLevel,
		requiresApproval,
		operationType,
		confidence,
		detectionMethod,
		matchedPatterns,
	};
}

/**
 * Validate tool names against destructive patterns.
 * This is a secondary check that can be used during execution.
 *
 * @param toolNames - Array of tool names to check
 * @returns Object with isDestructive flag and matched tools
 */
export function validateToolsForDestructivePatterns(toolNames: string[]): {
	isDestructive: boolean;
	destructiveTools: string[];
	patterns: string[];
} {
	const destructiveTools: string[] = [];
	const patterns: string[] = [];

	for (const toolName of toolNames) {
		// Check delete patterns
		const deleteCheck = checkToolPatterns(
			toolName,
			DELETE_PATTERNS.toolPatterns,
		);
		if (deleteCheck.matched) {
			destructiveTools.push(toolName);
			patterns.push(`delete:${deleteCheck.matchedPattern}`);
			continue;
		}

		// Also check for dangerous keywords in tool name
		const lowerTool = toolName.toLowerCase();
		for (const verb of DELETE_PATTERNS.verbs) {
			if (lowerTool.includes(verb)) {
				destructiveTools.push(toolName);
				patterns.push(`delete_verb:${verb}`);
				break;
			}
		}
	}

	return {
		isDestructive: destructiveTools.length > 0,
		destructiveTools,
		patterns,
	};
}

/**
 * Get a human-readable explanation of the risk assessment.
 * Useful for audit logs and user-facing messages.
 */
export function explainRiskAssessment(assessment: RiskAssessment): string {
	const parts: string[] = [];

	parts.push(`Operation type: ${assessment.operationType.toUpperCase()}`);
	parts.push(`Risk level: ${assessment.riskLevel.toUpperCase()}`);
	parts.push(
		`Requires approval: ${assessment.requiresApproval ? "YES" : "NO"}`,
	);
	parts.push(`Confidence: ${Math.round(assessment.confidence * 100)}%`);
	parts.push(`Detection method: ${assessment.detectionMethod}`);

	if (assessment.matchedPatterns.length > 0) {
		parts.push(
			`Matched patterns: ${assessment.matchedPatterns.join(", ")}`,
		);
	}

	return parts.join("\n");
}

// =============================================================================
// TOOL CALL RISK ASSESSMENT (for iterative execution)
// =============================================================================

/**
 * Tool call risk assessment result for iterative execution
 */
export interface ToolCallRiskAssessment {
	riskLevel: RiskLevel;
	requiresApproval: boolean;
	operationType: OperationType;
	reason?: string;
	matchedPatterns: string[];
}

/**
 * Assess the risk of a single tool call for iterative execution.
 *
 * This function is designed for per-tool-call assessment in the iterative
 * agent loop, where we need to decide whether to pause for approval before
 * executing each tool.
 *
 * @param toolCall - The tool call to assess
 * @param context - Optional context from previous tool results
 * @returns Risk assessment with approval requirement
 */
export function assessToolCallRisk(
	toolCall: { name: string; args: Record<string, unknown> },
	context?: {
		previousResults?: Array<{ toolName: string; result: unknown }>;
	},
): ToolCallRiskAssessment {
	const { name: toolName, args } = toolCall;

	// Convert args to string for pattern matching
	const argsString = JSON.stringify(args).toLowerCase();

	// Combine tool name and args for comprehensive analysis
	const fullText = `${toolName} ${argsString}`;

	// Use existing detection logic
	const detection = detectOperationRisk({
		description: fullText,
		toolNames: [toolName],
	});

	// Check for bulk indicators in args
	// Look for: 1) bulk keywords in args string, 2) array-valued properties with multiple items
	const hasArrayWithMultipleItems = Object.values(args).some(
		(value) => Array.isArray(value) && value.length > 1,
	);
	const isBulkFromArgs =
		BULK_PATTERNS.keywords.some((kw) => argsString.includes(kw)) ||
		hasArrayWithMultipleItems;

	// Check for bulk based on context (e.g., previous list operation returned many items)
	let isBulkFromContext = false;
	if (context?.previousResults && context.previousResults.length > 0) {
		const lastResult =
			context.previousResults[context.previousResults.length - 1];
		if (lastResult?.result) {
			// Check if last result was a list with multiple items
			const resultArray = Array.isArray(lastResult.result)
				? lastResult.result
				: (lastResult.result as Record<string, unknown>)?.items ||
					(lastResult.result as Record<string, unknown>)?.data ||
					(lastResult.result as Record<string, unknown>)?.results;

			if (Array.isArray(resultArray) && resultArray.length > 3) {
				// If current operation is destructive and previous operation listed many items,
				// this is likely a bulk operation
				if (detection.operationType === "delete") {
					isBulkFromContext = true;
				}
			}
		}
	}

	const isBulk = isBulkFromArgs || isBulkFromContext;

	// Escalate risk if bulk operation detected
	let finalRiskLevel = detection.riskLevel;
	let finalRequiresApproval = detection.requiresApproval;

	if (isBulk && detection.operationType !== "read") {
		// Escalate risk for bulk operations
		if (detection.riskLevel === "medium") {
			finalRiskLevel = "high";
			finalRequiresApproval = true;
		} else if (detection.riskLevel === "high") {
			finalRiskLevel = "critical";
		}
	}

	// Build reason string
	let reason: string | undefined;
	if (finalRequiresApproval) {
		const bulkIndicator = isBulk ? "Bulk " : "";
		const opType = detection.operationType;
		reason = `${bulkIndicator}${opType} operation: ${toolName}`;
	}

	// Combine matched patterns
	const matchedPatterns = [...detection.matchedPatterns];
	if (isBulkFromArgs) {
		matchedPatterns.push("bulk_args");
	}
	if (isBulkFromContext) {
		matchedPatterns.push("bulk_context");
	}

	return {
		riskLevel: finalRiskLevel,
		requiresApproval: finalRequiresApproval,
		operationType: detection.operationType,
		reason,
		matchedPatterns,
	};
}
