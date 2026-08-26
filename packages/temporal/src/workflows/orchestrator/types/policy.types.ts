/**
 * Policy Types
 *
 * Defines policy rules and context for the orchestrator's policy layer.
 * Used for context enrichment, guardrails, and compliance.
 */

import type { TaskType } from "./task.types";

// =============================================================================
// Policy Rule
// =============================================================================

export interface PolicyRule {
	id: string;
	name: string;
	description: string;
	/** When this policy applies */
	condition: {
		/** Agent IDs this applies to (empty = all) */
		agents?: string[];
		/** Task types this applies to (empty = all) */
		taskTypes?: TaskType[];
		/** Risk levels this applies to (empty = all) */
		riskLevels?: ("low" | "medium" | "high" | "critical")[];
		/** Custom condition expression */
		expression?: string;
	};
	/** Action to take when condition matches */
	action: {
		type:
			| "inject_prompt"
			| "require_approval"
			| "block"
			| "log"
			| "transform_output";
		/** Prompt to inject (for inject_prompt) */
		promptInjection?: string;
		/** Approval timeout in ms (for require_approval) */
		approvalTimeoutMs?: number;
		/** Block message (for block) */
		blockMessage?: string;
		/** Output transformation (for transform_output) */
		outputTransform?: string;
	};
	/** Priority (higher = executed first) */
	priority: number;
	/** Whether this policy is enabled */
	enabled: boolean;
}

// =============================================================================
// Policy Context
// =============================================================================

export interface PolicyContext {
	/** Organization-level policies */
	organizationPolicies: PolicyRule[];
	/** User-level policies */
	userPolicies: PolicyRule[];
	/** Domain knowledge to inject */
	domainKnowledge: string[];
	/** Guardrails/constraints */
	guardrails: string[];
	/** Compliance requirements */
	complianceRules: string[];
}
