/**
 * Output Reflection Activity
 *
 * Reflects on step output to determine if it meets expectations.
 * Used for quality control and retry decisions.
 */

import type { ReflectOnOutputInput, ReflectOnOutputOutput } from "../types";

/**
 * Reflects on the output of a step to determine quality.
 *
 * Features:
 * - Error indicator detection
 * - Empty output detection
 * - Suggestions for improvement
 */
export async function reflectOnOutput(
	input: ReflectOnOutputInput,
): Promise<ReflectOnOutputOutput> {
	console.log("[Orchestrator] Reflecting on output");

	// Simple reflection - in production would use LLM
	const outputStr = JSON.stringify(input.output);

	// Check for error indicators
	if (
		outputStr.includes("error") ||
		outputStr.includes("failed") ||
		outputStr.includes("exception")
	) {
		return {
			satisfactory: false,
			reason: "Output contains error indicators",
			suggestions: ["Retry the operation", "Check input parameters"],
		};
	}

	// Check if output seems complete
	if (!outputStr || outputStr === "{}" || outputStr === "null") {
		return {
			satisfactory: false,
			reason: "Output is empty or null",
			suggestions: [
				"Verify the operation completed",
				"Check for missing data",
			],
		};
	}

	return {
		satisfactory: true,
	};
}
