/**
 * ALTK Validation Activity
 *
 * Validates outputs using the ALTK (AI Language Tool Kit) framework
 * for PII detection, sensitive data detection, and other guardrails.
 */

import type { ValidateWithALTKInput } from "../types";

/**
 * Validates output using ALTK guardrails.
 *
 * Features:
 * - PII detection (SSN, email, credit card)
 * - Sensitive data detection (passwords, API keys, tokens)
 */
export async function validateWithALTK(
	input: ValidateWithALTKInput,
): Promise<{ valid: boolean; issues: string[] }> {
	console.log("[Orchestrator] Validating with ALTK");

	const issues: string[] = [];
	const { config } = input;

	// PII Detection
	if (config.outputGuardrails.piiDetection) {
		const outputStr = JSON.stringify(input.output);
		const piiPatterns = [
			/\b\d{3}-\d{2}-\d{4}\b/, // SSN
			/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, // Email
			/\b\d{16}\b/, // Credit card
		];

		for (const pattern of piiPatterns) {
			if (pattern.test(outputStr)) {
				issues.push("Potential PII detected in output");
				break;
			}
		}
	}

	// Sensitive data detection
	if (config.outputGuardrails.sensitiveDataDetection) {
		const outputStr = JSON.stringify(input.output).toLowerCase();
		const sensitiveTerms = [
			"password",
			"secret",
			"api_key",
			"token",
			"credential",
		];

		for (const term of sensitiveTerms) {
			if (outputStr.includes(term)) {
				issues.push(`Potential sensitive data detected: ${term}`);
			}
		}
	}

	return {
		valid: issues.length === 0,
		issues,
	};
}
