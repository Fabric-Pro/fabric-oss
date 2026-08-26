/**
 * Destructive Operation Verification
 *
 * After destructive operations (delete, remove, archive), this module verifies
 * that the operation completed successfully by analyzing tool call results.
 *
 * This prevents issues where:
 * - The AI claims success but some operations failed
 * - Tool calls are silently dropped
 * - Partial execution is not detected
 */

import type { OrchestratorStepResult } from "../../../workflows/orchestrator/types";
import type { TaskStep } from "../types";

export interface VerificationInput {
	step: TaskStep;
	stepResult: OrchestratorStepResult;
	userId: string;
	organizationId?: string;
	executionId?: string;
	enabledMcpConfigIds?: string[];
}

export interface VerificationResult {
	verified: boolean;
	expectedCount: number;
	actualSuccessCount: number;
	actualFailCount: number;
	remainingItems: Array<{ id: string; name: string; type: string }>;
	verificationMessage: string;
	shouldRetry: boolean;
	retryReason?: string;
}

/**
 * Determines if a step was a destructive operation that requires verification.
 */
export function isDestructiveStep(step: TaskStep): boolean {
	const description = step.description.toLowerCase();
	const destructiveKeywords = [
		"delete",
		"remove",
		"archive",
		"clear",
		"purge",
		"destroy",
		"erase",
	];

	return destructiveKeywords.some((kw) => description.includes(kw));
}

/**
 * Determines if a step is a bulk operation that affects multiple items.
 */
export function isBulkOperation(step: TaskStep): boolean {
	const description = step.description.toLowerCase();
	const bulkIndicators = [
		"all",
		"every",
		"each",
		"multiple",
		"batch",
		"bulk",
		"list of",
		"matching",
	];

	return bulkIndicators.some((indicator) => description.includes(indicator));
}

/**
 * Extracts the entity type being operated on from the step description.
 * @example "Delete all boards" -> "board"
 * @example "Remove matching cards" -> "card"
 */
export function extractEntityType(step: TaskStep): string {
	const description = step.description.toLowerCase();

	// Common entity patterns
	const entityPatterns = [
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
	];

	for (const { pattern, type } of entityPatterns) {
		if (pattern.test(description)) {
			return type;
		}
	}

	return "item";
}

/**
 * Extracts the expected count of items from previous step results.
 * Looks for list operations that would have provided the items to delete.
 */
export function extractExpectedCountFromContext(
	previousResults?: OrchestratorStepResult[],
	entityType?: string,
): number {
	if (!previousResults || previousResults.length === 0) {
		return 0;
	}

	// Look backwards through previous steps for a list operation
	for (let i = previousResults.length - 1; i >= 0; i--) {
		const prev = previousResults[i];

		// Look for list/get_all tool calls
		type ToolCall = OrchestratorStepResult["toolCalls"][number];
		const listToolCalls = prev.toolCalls?.filter(
			(tc: ToolCall) =>
				tc.status === "success" &&
				(tc.name.includes("list") ||
					tc.name.includes("get_all") ||
					tc.name.includes("search")),
		);

		if (listToolCalls && listToolCalls.length > 0) {
			for (const tc of listToolCalls) {
				// Check if this is the right entity type
				if (entityType && !tc.name.toLowerCase().includes(entityType)) {
					continue;
				}

				const count = extractCountFromResult(tc.result);
				if (count > 0) {
					return count;
				}
			}
		}
	}

	return 0;
}

/**
 * Attempts to extract a count from a tool result.
 */
function extractCountFromResult(result: unknown): number {
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
 * Verifies a destructive operation by analyzing tool call results.
 *
 * This is the main verification activity that analyzes whether all intended
 * destructive operations completed successfully.
 */
export async function verifyDestructiveOperation(
	input: VerificationInput,
): Promise<VerificationResult> {
	const { step, stepResult } = input;

	console.log(
		`[VerifyDestructive] Starting verification for step: ${step.id}`,
	);

	// Default result for non-verifiable cases
	const defaultResult: VerificationResult = {
		verified: true,
		expectedCount: 0,
		actualSuccessCount: 0,
		actualFailCount: 0,
		remainingItems: [],
		verificationMessage: "Verification not applicable",
		shouldRetry: false,
	};

	// Only verify destructive operations
	if (!isDestructiveStep(step)) {
		console.log(
			"[VerifyDestructive] Step is not a destructive operation, skipping verification",
		);
		return defaultResult;
	}

	const entityType = extractEntityType(step);

	// Type for tool calls
	type ToolCall = OrchestratorStepResult["toolCalls"][number];

	// Count successful and failed destructive tool calls
	const destructiveToolCalls =
		stepResult.toolCalls?.filter(
			(tc: ToolCall) =>
				tc.name.includes("delete") ||
				tc.name.includes("remove") ||
				tc.name.includes("archive") ||
				tc.name.includes("clear") ||
				tc.name.includes("purge"),
		) || [];

	const successfulCalls = destructiveToolCalls.filter(
		(tc: ToolCall) => tc.status === "success",
	);
	const failedCalls = destructiveToolCalls.filter(
		(tc: ToolCall) => tc.status === "error",
	);

	const totalCalls = destructiveToolCalls.length;
	const successCount = successfulCalls.length;
	const failCount = failedCalls.length;

	console.log(
		`[VerifyDestructive] Entity type: ${entityType}, Total calls: ${totalCalls}, Success: ${successCount}, Failed: ${failCount}`,
	);

	// If no destructive tool calls were made but the step claimed to delete, flag it
	if (totalCalls === 0 && isBulkOperation(step)) {
		console.warn(
			"[VerifyDestructive] Bulk delete step completed but no delete tool calls were recorded",
		);
		return {
			verified: false,
			expectedCount: 0,
			actualSuccessCount: 0,
			actualFailCount: 0,
			remainingItems: [],
			verificationMessage:
				"Warning: No delete operations were recorded. The step may not have executed correctly.",
			shouldRetry: true,
			retryReason: "No delete tool calls were recorded",
		};
	}

	// If all calls succeeded, verification passes
	if (failCount === 0 && successCount > 0) {
		console.log(
			`[VerifyDestructive] All ${successCount} destructive operations succeeded`,
		);
		return {
			verified: true,
			expectedCount: successCount,
			actualSuccessCount: successCount,
			actualFailCount: 0,
			remainingItems: [],
			verificationMessage: `All ${successCount} ${entityType}(s) were successfully deleted.`,
			shouldRetry: false,
		};
	}

	// If there were failures, report them
	if (failCount > 0) {
		// Extract info about failed items from the failed tool calls
		const remainingItems: Array<{
			id: string;
			name: string;
			type: string;
		}> = [];
		for (const tc of failedCalls) {
			const args = tc.args as Record<string, unknown> | undefined;
			if (args) {
				// Try to find an ID in the args
				const id = String(
					args.id ||
						args.boardId ||
						args.cardId ||
						args.taskId ||
						args.itemId ||
						args.recordId ||
						"unknown",
				);
				remainingItems.push({
					id,
					name: `${entityType} ${id}`,
					type: entityType,
				});
			}
		}

		console.warn(
			`[VerifyDestructive] ${failCount} out of ${totalCalls} destructive operations failed`,
		);

		return {
			verified: false,
			expectedCount: totalCalls,
			actualSuccessCount: successCount,
			actualFailCount: failCount,
			remainingItems,
			verificationMessage: `${failCount} of ${totalCalls} ${entityType}(s) failed to delete. ${successCount} succeeded.`,
			shouldRetry: true,
			retryReason: `${failCount} ${entityType}(s) failed to delete`,
		};
	}

	// Edge case: no calls at all (shouldn't happen but handle gracefully)
	return defaultResult;
}

/**
 * Creates a follow-up step to complete a partially failed destructive operation.
 */
export function createRetryStep(
	originalStep: TaskStep,
	verificationResult: VerificationResult,
): TaskStep {
	const entityType = extractEntityType(originalStep);
	const remainingIds = verificationResult.remainingItems
		.map((item) => item.id)
		.join(", ");

	return {
		id: `${originalStep.id}_retry`,
		type: originalStep.type,
		description: `Retry: Delete remaining ${verificationResult.remainingItems.length} ${entityType}(s) that failed in the previous attempt (IDs: ${remainingIds})`,
		order: originalStep.order + 0.5, // Insert right after the original step
		inputs: {
			remainingItemIds: verificationResult.remainingItems.map(
				(item) => item.id,
			),
			originalStepId: originalStep.id,
		},
		outputs: {},
		status: "pending",
		riskLevel: originalStep.riskLevel,
		requiresApproval: originalStep.requiresApproval,
		app: originalStep.app,
		executor: originalStep.executor,
		capability: originalStep.capability,
		toolsToUse: originalStep.toolsToUse,
	};
}

/**
 * Finds the appropriate "list" tool for verifying items.
 * @param toolCalls The tool calls from the step
 * @param entityType The type of entity (board, card, etc.)
 */
export function findVerificationTool(
	toolCalls: OrchestratorStepResult["toolCalls"],
	_entityType: string,
): string | null {
	if (!toolCalls) {
		return null;
	}

	// Find the server prefix from delete tools
	for (const tc of toolCalls) {
		if (
			tc.name.includes("delete") ||
			tc.name.includes("remove") ||
			tc.name.includes("archive")
		) {
			// Extract server prefix (e.g., "fizzy_boards_delete_board" -> "fizzy")
			const parts = tc.name.split("_");
			if (parts.length >= 2) {
				const serverPrefix = parts[0];
				// Construct list tool name
				return `${serverPrefix}_boards_get_all_boards`;
			}
		}
	}

	return null;
}
