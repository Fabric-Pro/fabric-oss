/**
 * Recovery Activity
 *
 * Attempts to recover from step failures using:
 * - Retry with backoff
 * - Alternative tool selection
 * - Simplified approach
 */

export interface RecoveryInput {
	step: { id: string; description: string };
	error: string;
	attempt: number;
	userId: string;
	organizationId?: string;
}

export interface RecoveryOutput {
	recovered: boolean;
	response?: string;
	strategyUsed: string;
}

export async function attemptStepRecovery(
	input: RecoveryInput,
): Promise<RecoveryOutput> {
	const {
		step,
		error,
		attempt,
		userId: _userId,
		organizationId: _organizationId,
	} = input;

	console.log("[GoalRecovery] Attempting recovery", {
		stepId: step.id,
		error: error.slice(0, 100),
		attempt,
	});

	// Classify the error to determine recovery strategy
	const classification = classifyError(error);

	switch (classification.type) {
		case "rate_limit":
			// Wait and retry
			if (attempt <= 2) {
				await delay(classification.waitMs || 5000);
				return {
					recovered: true,
					strategyUsed: "wait_and_retry",
				};
			}
			break;

		case "timeout":
			// Retry with shorter timeout expectation
			if (attempt === 1) {
				return {
					recovered: true,
					strategyUsed: "retry_timeout",
				};
			}
			break;

		case "tool_not_found":
			// Cannot recover - tool doesn't exist
			return {
				recovered: false,
				strategyUsed: "no_recovery_tool_missing",
			};

		case "auth_error":
			// Cannot recover without user intervention
			return {
				recovered: false,
				strategyUsed: "no_recovery_auth",
			};

		case "transient":
			// Retry once for transient errors
			if (attempt === 1) {
				await delay(1000);
				return {
					recovered: true,
					strategyUsed: "retry_transient",
				};
			}
			break;

		default:
			// Unknown error - try one retry
			if (attempt === 1) {
				await delay(2000);
				return {
					recovered: true,
					strategyUsed: "retry_unknown",
				};
			}
	}

	return {
		recovered: false,
		strategyUsed: `no_recovery_after_${attempt}_attempts`,
	};
}

interface ErrorClassification {
	type:
		| "rate_limit"
		| "timeout"
		| "tool_not_found"
		| "auth_error"
		| "transient"
		| "unknown";
	waitMs?: number;
}

function classifyError(error: string): ErrorClassification {
	const errorLower = error.toLowerCase();

	// Rate limiting
	if (
		errorLower.includes("rate limit") ||
		errorLower.includes("too many requests") ||
		errorLower.includes("429")
	) {
		// Extract wait time if present
		const waitMatch = error.match(/(\d+)\s*(seconds?|s)/i);
		const waitMs = waitMatch
			? Number.parseInt(waitMatch[1], 10) * 1000
			: 10000;
		return { type: "rate_limit", waitMs };
	}

	// Timeout
	if (
		errorLower.includes("timeout") ||
		errorLower.includes("timed out") ||
		errorLower.includes("deadline exceeded")
	) {
		return { type: "timeout" };
	}

	// Tool/function not found
	if (
		errorLower.includes("tool not found") ||
		errorLower.includes("function not found") ||
		errorLower.includes("not available")
	) {
		return { type: "tool_not_found" };
	}

	// Authentication errors
	if (
		errorLower.includes("unauthorized") ||
		errorLower.includes("authentication") ||
		errorLower.includes("forbidden") ||
		errorLower.includes("api key")
	) {
		return { type: "auth_error" };
	}

	// Transient errors
	if (
		errorLower.includes("connection") ||
		errorLower.includes("network") ||
		errorLower.includes("temporary") ||
		errorLower.includes("503") ||
		errorLower.includes("502")
	) {
		return { type: "transient" };
	}

	return { type: "unknown" };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
