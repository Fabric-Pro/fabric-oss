/**
 * Generic Operation Verification
 *
 * Comprehensive verification system for ALL operation types (create, read, update, delete).
 * This module verifies that operations completed successfully by analyzing tool call results.
 *
 * Key Features:
 * - Detects "not found" scenarios (search returns empty before dependent operation)
 * - Verifies expected vs actual outcomes for all operation types
 * - Catches false positives (AI claims success but operation actually failed)
 * - Generic - works with ANY MCP server, not just specific ones
 */

import type { OrchestratorStepResult } from "../../../workflows/orchestrator/types";
import type { TaskStep } from "../types";

// =============================================================================
// Types
// =============================================================================

export type OperationType = "create" | "read" | "update" | "delete" | "unknown";

export interface VerificationInput {
	step: TaskStep;
	stepResult: OrchestratorStepResult;
	previousResults?: OrchestratorStepResult[];
	userId: string;
	organizationId?: string;
	executionId?: string;
	enabledMcpConfigIds?: string[];
}

export interface VerificationResult {
	/** Whether the operation was verified as successful */
	verified: boolean;
	/** The type of operation that was attempted */
	operationType: OperationType;
	/** Human-readable verification message */
	verificationMessage: string;
	/** Whether the step should be retried */
	shouldRetry: boolean;
	/** Reason for retry if applicable */
	retryReason?: string;
	/** Detailed breakdown of the verification */
	details: {
		/** Entity type being operated on (board, card, etc.) */
		entityType: string;
		/** Name/identifier of the target entity from step description */
		targetEntityName?: string;
		/** Number of items expected to be affected */
		expectedCount: number;
		/** Number of items successfully affected */
		actualSuccessCount: number;
		/** Number of items that failed */
		actualFailCount: number;
		/** Items that weren't found or remain unprocessed */
		notFoundOrRemaining: Array<{
			id?: string;
			name?: string;
			type: string;
			reason: string;
		}>;
		/** Tool calls that were made */
		toolCallsSummary: Array<{
			name: string;
			status: string;
			hasResult: boolean;
		}>;
		/** Issues detected during verification */
		issues: string[];
	};
}

// =============================================================================
// Operation Type Detection
// =============================================================================

const OPERATION_KEYWORDS: Record<OperationType, string[]> = {
	create: ["create", "add", "new", "make", "generate", "insert", "post"],
	read: [
		"get",
		"list",
		"fetch",
		"retrieve",
		"find",
		"search",
		"query",
		"show",
		"display",
	],
	update: ["update", "modify", "change", "edit", "patch", "set", "rename"],
	delete: [
		"delete",
		"remove",
		"archive",
		"clear",
		"purge",
		"destroy",
		"erase",
		"drop",
	],
	unknown: [],
};

/**
 * Detect the type of operation from a step description.
 */
export function detectOperationType(step: TaskStep): OperationType {
	const description = step.description.toLowerCase();

	// Check each operation type's keywords
	for (const [opType, keywords] of Object.entries(OPERATION_KEYWORDS) as [
		OperationType,
		string[],
	][]) {
		if (opType === "unknown") {
			continue;
		}
		if (keywords.some((kw) => description.includes(kw))) {
			return opType;
		}
	}

	return "unknown";
}

/**
 * Detect operation type from a tool name.
 */
export function detectOperationTypeFromTool(toolName: string): OperationType {
	const nameLower = toolName.toLowerCase();

	for (const [opType, keywords] of Object.entries(OPERATION_KEYWORDS) as [
		OperationType,
		string[],
	][]) {
		if (opType === "unknown") {
			continue;
		}
		if (keywords.some((kw) => nameLower.includes(kw))) {
			return opType;
		}
	}

	return "unknown";
}

// =============================================================================
// Entity Extraction
// =============================================================================

const ENTITY_PATTERNS = [
	{ pattern: /board/i, type: "board" },
	{ pattern: /card/i, type: "card" },
	{ pattern: /task/i, type: "task" },
	{ pattern: /file/i, type: "file" },
	{ pattern: /document/i, type: "document" },
	{ pattern: /project/i, type: "project" },
	{ pattern: /issue/i, type: "issue" },
	{ pattern: /ticket/i, type: "ticket" },
	{ pattern: /record/i, type: "record" },
	{ pattern: /item/i, type: "item" },
	{ pattern: /entry/i, type: "entry" },
	{ pattern: /note/i, type: "note" },
	{ pattern: /message/i, type: "message" },
	{ pattern: /workspace/i, type: "workspace" },
	{ pattern: /channel/i, type: "channel" },
	{ pattern: /user/i, type: "user" },
	{ pattern: /member/i, type: "member" },
	{ pattern: /account/i, type: "account" },
	{ pattern: /identity/i, type: "identity" },
	{ pattern: /list/i, type: "list" },
	{ pattern: /column/i, type: "column" },
];

/**
 * Extract the entity type from a step description or tool name.
 */
export function extractEntityType(text: string): string {
	const textLower = text.toLowerCase();

	for (const { pattern, type } of ENTITY_PATTERNS) {
		if (pattern.test(textLower)) {
			return type;
		}
	}

	return "item";
}

/**
 * Extract target entity name from step description.
 * Examples:
 * - "Delete the 'Test 1' board" -> "Test 1"
 * - "Find board named playground" -> "playground"
 * - "Remove all boards matching 'test'" -> "test"
 */
export function extractTargetEntityName(
	description: string,
): string | undefined {
	// Try to find quoted names first (single or double quotes)
	const quotedMatch = description.match(/['"]([^'"]+)['"]/);
	if (quotedMatch) {
		return quotedMatch[1];
	}

	// Try to find "named X" or "called X" patterns
	const namedMatch = description.match(
		/(?:named|called|titled|with name)\s+(\w+)/i,
	);
	if (namedMatch) {
		return namedMatch[1];
	}

	// Try to find "the X board/card/etc" pattern
	const theMatch = description.match(
		/the\s+['"]?(\w+)['"]?\s+(?:board|card|task|item|file|document)/i,
	);
	if (theMatch) {
		return theMatch[1];
	}

	return undefined;
}

// =============================================================================
// Result Analysis
// =============================================================================

/**
 * Check if a tool call result indicates "not found" or empty results.
 */
export function isEmptyOrNotFound(result: unknown): boolean {
	if (result === null || result === undefined) {
		return true;
	}

	// Empty array
	if (Array.isArray(result) && result.length === 0) {
		return true;
	}

	// Object with empty array
	if (typeof result === "object" && result !== null) {
		const obj = result as Record<string, unknown>;

		// Check common list properties
		const listProps = [
			"items",
			"data",
			"results",
			"list",
			"records",
			"boards",
			"cards",
			"tasks",
		];
		for (const prop of listProps) {
			if (
				Array.isArray(obj[prop]) &&
				(obj[prop] as unknown[]).length === 0
			) {
				return true;
			}
		}

		// Check for explicit "not found" indicators
		if (obj.found === false) {
			return true;
		}
		if (obj.exists === false) {
			return true;
		}
		if (obj.count === 0) {
			return true;
		}
		if (obj.total === 0) {
			return true;
		}

		// Check for error messages indicating not found
		const error = obj.error || obj.message || "";
		if (typeof error === "string") {
			const errorLower = error.toLowerCase();
			if (
				errorLower.includes("not found") ||
				errorLower.includes("does not exist") ||
				errorLower.includes("no such") ||
				errorLower.includes("404")
			) {
				return true;
			}
		}
	}

	// String that indicates not found
	if (typeof result === "string") {
		const resultLower = result.toLowerCase();
		if (
			resultLower.includes("not found") ||
			resultLower.includes("does not exist") ||
			resultLower.includes("no results") ||
			resultLower.includes("no items")
		) {
			return true;
		}
	}

	return false;
}

/**
 * Extract count from a result object.
 */
export function extractCountFromResult(result: unknown): number {
	if (!result) {
		return 0;
	}

	// Direct array
	if (Array.isArray(result)) {
		return result.length;
	}

	// Object with array property
	if (typeof result === "object" && result !== null) {
		const obj = result as Record<string, unknown>;

		// Check common list property names
		const listProps = [
			"items",
			"data",
			"results",
			"list",
			"records",
			"boards",
			"cards",
			"tasks",
			"files",
		];
		for (const prop of listProps) {
			if (Array.isArray(obj[prop])) {
				return (obj[prop] as unknown[]).length;
			}
		}

		// Check for count/total properties
		if (typeof obj.count === "number") {
			return obj.count;
		}
		if (typeof obj.total === "number") {
			return obj.total;
		}
		if (typeof obj.length === "number") {
			return obj.length;
		}
	}

	return 0;
}

/**
 * Check if the step involves looking for a specific item (vs. bulk operations).
 */
export function isSpecificItemOperation(step: TaskStep): boolean {
	const description = step.description.toLowerCase();

	// Keywords that suggest looking for a specific item
	const specificKeywords = [
		"the ",
		"named",
		"called",
		"with name",
		"specific",
		"particular",
	];

	// Keywords that suggest bulk operations
	const bulkKeywords = [
		"all ",
		"every ",
		"each ",
		"multiple",
		"batch",
		"bulk",
		"matching",
	];

	const hasSpecificKeyword = specificKeywords.some((kw) =>
		description.includes(kw),
	);
	const hasBulkKeyword = bulkKeywords.some((kw) => description.includes(kw));

	// If has specific keyword and not bulk keyword, it's specific
	if (hasSpecificKeyword && !hasBulkKeyword) {
		return true;
	}

	// Check for quoted names (indicates specific item)
	if (/['"][^'"]+['"]/.test(step.description)) {
		return true;
	}

	return false;
}

// =============================================================================
// Main Verification Function
// =============================================================================

/**
 * Verify any operation by analyzing tool call results.
 *
 * This is the main verification activity that:
 * 1. Detects what type of operation was attempted
 * 2. Analyzes tool call results for success/failure
 * 3. Detects "not found" scenarios for dependent operations
 * 4. Returns a detailed verification result
 */
export async function verifyOperation(
	input: VerificationInput,
): Promise<VerificationResult> {
	const { step, stepResult } = input;
	const operationType = detectOperationType(step);
	const entityType = extractEntityType(step.description);
	const targetEntityName = extractTargetEntityName(step.description);
	const isSpecific = isSpecificItemOperation(step);

	console.log(
		`[VerifyOperation] Starting verification for step: ${step.id}`,
		{
			operationType,
			entityType,
			targetEntityName,
			isSpecific,
		},
	);

	// Build tool calls summary
	type ToolCall = OrchestratorStepResult["toolCalls"][number];
	const toolCallsSummary = (stepResult.toolCalls || []).map(
		(tc: ToolCall) => ({
			name: tc.name,
			status: tc.status,
			hasResult: tc.result !== undefined && tc.result !== null,
		}),
	);

	const issues: string[] = [];
	const notFoundOrRemaining: Array<{
		id?: string;
		name?: string;
		type: string;
		reason: string;
	}> = [];

	// Default successful result
	let verified = true;
	let verificationMessage = "Operation completed successfully";
	let shouldRetry = false;
	let retryReason: string | undefined;
	let expectedCount = 0;
	let actualSuccessCount = 0;
	let actualFailCount = 0;

	// Analyze based on operation type
	switch (operationType) {
		case "read":
		case "delete":
		case "update": {
			// For operations that depend on finding items first, check search/list results
			const searchToolCalls = (stepResult.toolCalls || []).filter(
				(tc: ToolCall) =>
					detectOperationTypeFromTool(tc.name) === "read",
			);

			// Check if we were looking for a specific item
			if (isSpecific && searchToolCalls.length > 0) {
				// Verify the search actually found results
				let foundItem = false;
				for (const tc of searchToolCalls) {
					if (
						tc.status === "success" &&
						!isEmptyOrNotFound(tc.result)
					) {
						foundItem = true;
						break;
					}
				}

				if (!foundItem && operationType !== "read") {
					// This is the critical case: user asked to delete/update specific item but it wasn't found
					verified = false;
					const itemDesc = targetEntityName
						? `"${targetEntityName}"`
						: `the specified ${entityType}`;
					verificationMessage = `Could not find ${itemDesc}. The ${operationType} operation cannot be completed because the target ${entityType} was not found.`;
					issues.push(
						`Search returned empty results when looking for specific ${entityType}`,
					);
					notFoundOrRemaining.push({
						name: targetEntityName,
						type: entityType,
						reason: "Not found in search results",
					});
					shouldRetry = false; // Don't retry - item doesn't exist
				}
			}

			// For delete operations, also check if delete tool calls were made
			if (operationType === "delete") {
				const deleteToolCalls = (stepResult.toolCalls || []).filter(
					(tc: ToolCall) =>
						detectOperationTypeFromTool(tc.name) === "delete",
				);

				const successfulDeletes = deleteToolCalls.filter(
					(tc: ToolCall) => tc.status === "success",
				);
				const failedDeletes = deleteToolCalls.filter(
					(tc: ToolCall) => tc.status === "error",
				);

				actualSuccessCount = successfulDeletes.length;
				actualFailCount = failedDeletes.length;
				expectedCount = deleteToolCalls.length;

				if (
					deleteToolCalls.length === 0 &&
					searchToolCalls.length > 0
				) {
					// Search was made but no delete was called
					const searchHadResults = searchToolCalls.some(
						(tc: ToolCall) =>
							tc.status === "success" &&
							!isEmptyOrNotFound(tc.result),
					);

					if (!searchHadResults) {
						// Search returned empty, so nothing to delete - but that's a problem
						// because user asked to delete something
						verified = false;
						const itemDesc = targetEntityName
							? `"${targetEntityName}"`
							: `the specified ${entityType}`;
						verificationMessage = `No ${entityType} found matching ${itemDesc}. Nothing was deleted.`;
						issues.push("No items found to delete");
					} else {
						// Search found items but delete wasn't called - suspicious
						verified = false;
						verificationMessage =
							"Search found items but no delete operation was executed. The deletion may not have completed.";
						issues.push(
							"Delete tool was not called despite search finding results",
						);
						shouldRetry = true;
						retryReason = "Delete operation was not executed";
					}
				}

				if (failedDeletes.length > 0) {
					verified = false;
					verificationMessage = `${failedDeletes.length} of ${deleteToolCalls.length} ${entityType}(s) failed to delete.`;
					shouldRetry = true;
					retryReason = `${failedDeletes.length} deletion(s) failed`;

					// Extract failed item info
					for (const tc of failedDeletes) {
						const args = tc.args as
							| Record<string, unknown>
							| undefined;
						const id = args
							? String(
									args.id ||
										args.boardId ||
										args.cardId ||
										args.taskId ||
										"unknown",
								)
							: "unknown";
						notFoundOrRemaining.push({
							id,
							type: entityType,
							reason: "Delete operation failed",
						});
					}
				}
			}

			// For update operations, check if update tool calls were made and succeeded
			if (operationType === "update") {
				const updateToolCalls = (stepResult.toolCalls || []).filter(
					(tc: ToolCall) =>
						detectOperationTypeFromTool(tc.name) === "update",
				);

				const successfulUpdates = updateToolCalls.filter(
					(tc: ToolCall) => tc.status === "success",
				);
				const failedUpdates = updateToolCalls.filter(
					(tc: ToolCall) => tc.status === "error",
				);

				actualSuccessCount = successfulUpdates.length;
				actualFailCount = failedUpdates.length;
				expectedCount = updateToolCalls.length;

				if (updateToolCalls.length === 0 && isSpecific) {
					verified = false;
					verificationMessage = `Update operation was not executed. The ${entityType} may not have been found.`;
					issues.push("Update tool was not called");
				}

				if (failedUpdates.length > 0) {
					verified = false;
					verificationMessage = `${failedUpdates.length} of ${updateToolCalls.length} update(s) failed.`;
					shouldRetry = true;
					retryReason = `${failedUpdates.length} update(s) failed`;
				}
			}
			break;
		}

		case "create": {
			// For create operations, check if create tool calls were made and succeeded
			const createToolCalls = (stepResult.toolCalls || []).filter(
				(tc: ToolCall) =>
					detectOperationTypeFromTool(tc.name) === "create",
			);

			const successfulCreates = createToolCalls.filter(
				(tc: ToolCall) => tc.status === "success",
			);
			const failedCreates = createToolCalls.filter(
				(tc: ToolCall) => tc.status === "error",
			);

			actualSuccessCount = successfulCreates.length;
			actualFailCount = failedCreates.length;
			expectedCount = createToolCalls.length;

			if (createToolCalls.length === 0) {
				// No create tool was called - might be expected or might be a problem
				// Only flag if the step explicitly mentions creating something
				if (operationType === "create") {
					issues.push("No create tool was called");
				}
			}

			if (failedCreates.length > 0) {
				verified = false;
				verificationMessage = `${failedCreates.length} of ${createToolCalls.length} create operation(s) failed.`;
				shouldRetry = true;
				retryReason = `${failedCreates.length} creation(s) failed`;
			}
			break;
		}

		default: {
			// For unknown operations, just check if any tool calls failed
			const allToolCalls = stepResult.toolCalls || [];
			const failedCalls = allToolCalls.filter(
				(tc: ToolCall) => tc.status === "error",
			);

			if (failedCalls.length > 0) {
				verified = false;
				verificationMessage = `${failedCalls.length} tool call(s) failed.`;
				actualFailCount = failedCalls.length;
				actualSuccessCount = allToolCalls.length - failedCalls.length;
			}
			break;
		}
	}

	// Check AI response for false positive claims
	const response = stepResult.response?.toLowerCase() || "";
	const successClaims = [
		"successfully",
		"completed",
		"done",
		"deleted",
		"created",
		"updated",
		"finished",
	];
	const hasSuccessClaim = successClaims.some((claim) =>
		response.includes(claim),
	);

	if (hasSuccessClaim && !verified) {
		issues.push("AI claimed success but verification detected issues");
	}

	// If no tool calls were made at all but operation required them
	if (
		(stepResult.toolCalls || []).length === 0 &&
		operationType !== "unknown"
	) {
		if (["create", "update", "delete"].includes(operationType)) {
			verified = false;
			verificationMessage = `No tool calls were recorded for this ${operationType} operation. The operation may not have executed.`;
			issues.push(
				`No tool calls recorded for ${operationType} operation`,
			);
		}
	}

	// Build final message if verified
	if (verified && actualSuccessCount > 0) {
		verificationMessage = `${operationType.charAt(0).toUpperCase() + operationType.slice(1)} operation completed successfully. ${actualSuccessCount} ${entityType}(s) affected.`;
	}

	const result: VerificationResult = {
		verified,
		operationType,
		verificationMessage,
		shouldRetry,
		retryReason,
		details: {
			entityType,
			targetEntityName,
			expectedCount,
			actualSuccessCount,
			actualFailCount,
			notFoundOrRemaining,
			toolCallsSummary,
			issues,
		},
	};

	console.log("[VerifyOperation] Verification complete", {
		stepId: step.id,
		verified,
		operationType,
		message: verificationMessage,
		issuesCount: issues.length,
	});

	return result;
}

// =============================================================================
// Backward Compatibility (re-export destructive verification)
// =============================================================================

export {
	isBulkOperation,
	isDestructiveStep,
} from "./verify-destructive-operation";
