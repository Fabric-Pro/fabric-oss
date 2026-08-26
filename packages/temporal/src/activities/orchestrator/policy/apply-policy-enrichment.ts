/**
 * Policy Enrichment Activity
 *
 * Applies organization and user policies to enrich messages
 * and enforce guardrails, compliance rules, and domain knowledge.
 */

import type {
	ApplyPolicyEnrichmentInput,
	ApplyPolicyEnrichmentOutput,
} from "../types";

/**
 * Applies policy enrichment to a message.
 *
 * Features:
 * - Blocking policies (keyword-based)
 * - Prompt injection for system prompts
 * - Domain knowledge injection
 * - Guardrails and compliance rules
 */
export async function applyPolicyEnrichment(
	input: ApplyPolicyEnrichmentInput,
): Promise<ApplyPolicyEnrichmentOutput> {
	console.log("[Orchestrator] Applying policy enrichment");

	const { policyContext } = input;
	const enrichedMessage = input.message;
	let systemPromptAdditions = "";

	// Check for blocking policies
	for (const policy of [
		...policyContext.organizationPolicies,
		...policyContext.userPolicies,
	]) {
		if (!policy.enabled) {
			continue;
		}

		if (policy.action.type === "block") {
			// Simple keyword-based blocking (would be more sophisticated in production)
			const blockedPatterns = ["delete all", "drop database", "rm -rf"];
			for (const pattern of blockedPatterns) {
				if (input.message.toLowerCase().includes(pattern)) {
					return {
						blocked: true,
						blockReason:
							policy.action.blockMessage ||
							"Action blocked by policy",
					};
				}
			}
		}

		if (
			policy.action.type === "inject_prompt" &&
			policy.action.promptInjection
		) {
			systemPromptAdditions += `\n${policy.action.promptInjection}`;
		}
	}

	// Add domain knowledge
	if (policyContext.domainKnowledge.length > 0) {
		systemPromptAdditions += `\n\nDomain Knowledge:\n${policyContext.domainKnowledge.join("\n")}`;
	}

	// Add guardrails
	if (policyContext.guardrails.length > 0) {
		systemPromptAdditions += `\n\nGuardrails:\n${policyContext.guardrails.join("\n")}`;
	}

	// Add compliance rules
	if (policyContext.complianceRules.length > 0) {
		systemPromptAdditions += `\n\nCompliance Requirements:\n${policyContext.complianceRules.join("\n")}`;
	}

	return {
		enrichedMessage,
		systemPromptAdditions,
		blocked: false,
	};
}
