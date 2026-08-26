/**
 * Authority Policy — Unified Precedence for Approval Decisions
 *
 * Reconciles the runtime authority system (AuthoritySession/Grant) with
 * Fabric's existing approval mechanisms:
 *
 * 1. Connection exists?  → If no, show connection/re-auth flow
 * 2. Authority granted?  → If no, show provider/session approval flow
 * 3. Step risk acceptable? → If no, show step approval flow
 * 4. Trust/auto-approve? → Can reduce friction only AFTER 1-3 pass
 *
 * This module is the single point where all approval systems converge.
 * It should be called during step execution to produce a unified decision.
 *
 * IMPORTANT: Authority is a prerequisite for trust-based auto-approval.
 * Trust can never bypass the requirement for an active authority session.
 * Trust only optimizes step-level approvals WITHIN an authorized context.
 */

import {
	classifyToolAccessLevel,
	resolveIntegrationProviderKey,
	resolveProviderKey,
} from "../execution/authority-gate";
import type { TaskStep } from "../types";
import type { AutoApprovalDecision, TrustConfiguration } from "./trust-manager";

export interface AuthorityPolicyInput {
	step: TaskStep;
	userId: string;
	organizationId?: string;
	executionId?: string;
	/** Providers the step needs (resolved by routing) */
	requiredProviders: Array<{
		providerKey: string;
		accessLevel: "READ" | "WRITE";
	}>;
	/** Trust config from UserOrchestratorPreferences */
	trustConfig?: TrustConfiguration | null;
}

export interface AuthorityPolicyResult {
	/** Whether the step can proceed */
	allowed: boolean;
	/** What blocked the step, if anything */
	blockedBy?:
		| "connection_missing"
		| "authority_missing"
		| "step_approval_required"
		| "risk_too_high";
	/** Details for the blocked state */
	blockedDetails?: {
		providerKey?: string;
		requiredAccessLevel?: string;
		riskLevel?: string;
		message: string;
	};
	/** Whether trust auto-approved a step approval */
	trustAutoApproved?: boolean;
	/** The trust decision if applicable */
	trustDecision?: AutoApprovalDecision;
}

/**
 * Evaluate the unified approval policy for a step.
 *
 * Precedence:
 * 1. Authority check — runtime grants must exist for all required providers
 * 2. Step risk check — high/critical risk steps need explicit approval
 * 3. Trust optimization — can auto-approve step approval if trust is sufficient
 *
 * Connection checking is handled separately by the routing layer and
 * is not repeated here.
 */
export async function evaluateAuthorityPolicy(
	input: AuthorityPolicyInput,
): Promise<AuthorityPolicyResult> {
	const {
		step,
		userId,
		organizationId,
		executionId,
		requiredProviders,
		trustConfig,
	} = input;

	// ── Step 1: Check runtime authority for all required providers ──
	// Authority is mandatory — trust cannot bypass this.
	if (requiredProviders.length > 0) {
		const { checkAuthority } = await import("@repo/database");

		for (const provider of requiredProviders) {
			const result = await checkAuthority({
				userId,
				organizationId,
				providerKey: provider.providerKey,
				accessLevel: provider.accessLevel,
				boundRunType: "ORCHESTRATOR",
				boundRunId: executionId,
			});

			if (!result.authorized) {
				return {
					allowed: false,
					blockedBy: "authority_missing",
					blockedDetails: {
						providerKey: provider.providerKey,
						requiredAccessLevel: provider.accessLevel,
						message:
							result.reason ||
							`Runtime authority required for ${provider.providerKey} (${provider.accessLevel})`,
					},
				};
			}
		}
	}

	// ── Step 2: Check step-level risk ──
	// After authority is confirmed, evaluate step risk.
	const riskLevel = step.riskLevel || "low";

	// Critical risk always requires explicit step approval regardless of trust
	if (riskLevel === "critical" && !step.approvalId) {
		return {
			allowed: false,
			blockedBy: "step_approval_required",
			blockedDetails: {
				riskLevel,
				message: "Critical risk step requires explicit approval",
			},
		};
	}

	// ── Step 3: Trust optimization for step approval ──
	// Trust can only reduce friction for step-level approvals,
	// never for authority grants.
	if (step.requiresApproval && !step.approvalId && trustConfig) {
		const { checkAutoApproval } = await import("./trust-manager");
		const trustDecision = checkAutoApproval(step, trustConfig);

		if (trustDecision.autoApprove) {
			return {
				allowed: true,
				trustAutoApproved: true,
				trustDecision,
			};
		}

		// Trust didn't auto-approve — step still needs approval
		return {
			allowed: false,
			blockedBy: "step_approval_required",
			blockedDetails: {
				riskLevel,
				message: `Step requires approval (trust: ${trustDecision.reason})`,
			},
			trustDecision,
		};
	}

	// All checks passed
	return { allowed: true };
}

/**
 * Extract required providers from a step's matched tools/integrations.
 * Used to build the `requiredProviders` input for evaluateAuthorityPolicy.
 */
export function extractRequiredProviders(
	step: TaskStep,
	toolToConfig?: Record<string, { serverName?: string; configId: string }>,
	matchedIntegrations?: Array<{ provider: string }>,
): Array<{ providerKey: string; accessLevel: "READ" | "WRITE" }> {
	const providers: Array<{
		providerKey: string;
		accessLevel: "READ" | "WRITE";
	}> = [];
	const seen = new Set<string>();

	// From MCP tools
	if (step.toolsToUse && toolToConfig) {
		for (const toolName of step.toolsToUse) {
			const config = toolToConfig[toolName];
			if (config) {
				const providerKey = resolveProviderKey(
					config.serverName || config.configId,
				);
				if (!seen.has(providerKey)) {
					seen.add(providerKey);
					providers.push({
						providerKey,
						accessLevel: classifyToolAccessLevel(toolName),
					});
				}
			}
		}
	}

	// From matched integrations
	if (matchedIntegrations) {
		for (const integration of matchedIntegrations) {
			const providerKey = resolveIntegrationProviderKey(
				integration.provider,
			);
			if (!seen.has(providerKey)) {
				seen.add(providerKey);
				// Integration steps are generally write operations
				providers.push({ providerKey, accessLevel: "WRITE" });
			}
		}
	}

	return providers;
}
