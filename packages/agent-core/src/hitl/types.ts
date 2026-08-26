/**
 * Human-in-the-Loop (HITL) Types
 *
 * Type definitions for HITL functionality in AI agents.
 */

/**
 * HITL request types
 */
export type HITLRequestType = "approval" | "input" | "choice";

/**
 * Option for choice requests
 */
export interface HITLOption {
	value: string;
	label: string;
	description?: string;
	icon?: string;
}

/**
 * HITL request structure
 */
export interface HITLRequest {
	requestId: string;
	type: HITLRequestType;
	prompt: string;
	title?: string;
	context?: Record<string, unknown>;
	options?: HITLOption[];
	timeout?: number;
	defaultValue?: string;
	required?: boolean;
	createdAt: number;
}

/**
 * HITL response structure
 */
export interface HITLResponse {
	requestId: string;
	approved: boolean;
	value?: string | string[];
	respondedAt: number;
}

/**
 * HITL state for agents
 */
export interface HITLState {
	/** Whether HITL is enabled */
	hitlEnabled: boolean;
	/** Current pending request (if any) */
	pendingHITLRequest?: HITLRequest;
	/** Last HITL response */
	lastHITLResponse?: HITLResponse;
	/** Whether agent is waiting for human input */
	awaitingHuman: boolean;
}

/**
 * Default HITL state
 */
export const DEFAULT_HITL_STATE: HITLState = {
	hitlEnabled: true,
	pendingHITLRequest: undefined,
	lastHITLResponse: undefined,
	awaitingHuman: false,
};

/**
 * Risk level for HITL requests (CUGA-inspired)
 */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * Risk assessment for HITL requests
 */
export interface HITLRiskAssessment {
	/** Overall risk score (0-100) */
	score: number;
	/** Risk level category */
	level: RiskLevel;
	/** Factors contributing to the risk */
	factors: string[];
	/** Model confidence in this assessment (0-100) */
	confidence?: number;
	/** Estimated impact description */
	impact?: string;
	/** Suggested mitigation if applicable */
	mitigation?: string;
}

/**
 * Enhanced HITL request with risk assessment
 */
export interface RiskAwareHITLRequest extends HITLRequest {
	/** Risk assessment for this action */
	riskAssessment?: HITLRiskAssessment;
	/** Whether this request was auto-triggered due to risk */
	autoTriggered?: boolean;
	/** Original task that led to this request */
	sourceTask?: string;
}

/**
 * HITL configuration
 */
export interface HITLConfig {
	/** Whether HITL is enabled */
	enabled: boolean;
	/** Default timeout in ms */
	defaultTimeout: number;
	/** Whether to require approval for destructive actions */
	requireApprovalForDestructive: boolean;
	/** Actions that always require approval */
	alwaysRequireApproval: string[];
	/** Actions that never require approval */
	neverRequireApproval: string[];
	/** Risk thresholds for auto-triggering approval (CUGA-inspired) */
	riskThresholds?: {
		/** Risk score above which approval is always required */
		critical: number;
		/** Risk score for high-risk actions */
		high: number;
		/** Risk score for medium-risk actions */
		medium: number;
	};
}

/**
 * Default HITL configuration
 */
export const DEFAULT_HITL_CONFIG: HITLConfig = {
	enabled: true,
	defaultTimeout: 60000,
	requireApprovalForDestructive: true,
	alwaysRequireApproval: [
		"delete",
		"remove",
		"drop",
		"truncate",
		"deploy",
		"publish",
		"send_email",
		"make_payment",
	],
	neverRequireApproval: ["read", "list", "get", "search", "query"],
	riskThresholds: {
		critical: 80,
		high: 65,
		medium: 50,
	},
};

/**
 * Check if an action requires HITL approval
 */
export function requiresApproval(
	action: string,
	config: HITLConfig = DEFAULT_HITL_CONFIG,
): boolean {
	if (!config.enabled) {
		return false;
	}

	const actionLower = action.toLowerCase();

	// Check never require list first
	if (config.neverRequireApproval.some((a) => actionLower.includes(a))) {
		return false;
	}

	// Check always require list
	if (config.alwaysRequireApproval.some((a) => actionLower.includes(a))) {
		return true;
	}

	// Check for destructive patterns
	if (config.requireApprovalForDestructive) {
		const destructivePatterns = [
			"delete",
			"remove",
			"drop",
			"truncate",
			"destroy",
			"update",
			"modify",
			"change",
			"edit",
			"create",
			"insert",
			"add",
			"write",
			"execute",
			"run",
			"invoke",
		];
		return destructivePatterns.some((p) => actionLower.includes(p));
	}

	return false;
}

/**
 * Check if an action requires approval based on risk assessment (CUGA-inspired)
 */
export function requiresRiskBasedApproval(
	riskScore: number,
	action: string,
	modelConfidence?: number,
	config: HITLConfig = DEFAULT_HITL_CONFIG,
): { requiresApproval: boolean; reason: string; level: RiskLevel } {
	if (!config.enabled) {
		return { requiresApproval: false, reason: "", level: "low" };
	}

	const thresholds = config.riskThresholds ?? {
		critical: 80,
		high: 65,
		medium: 50,
	};

	// Critical risk always requires approval
	if (riskScore >= thresholds.critical) {
		return {
			requiresApproval: true,
			reason: `Critical risk score (${riskScore}%) requires human approval`,
			level: "critical",
		};
	}

	// High risk with low model confidence requires approval
	if (
		riskScore >= thresholds.high &&
		modelConfidence !== undefined &&
		modelConfidence < 70
	) {
		return {
			requiresApproval: true,
			reason: `High risk (${riskScore}%) with low confidence (${modelConfidence}%) requires approval`,
			level: "high",
		};
	}

	// Medium risk for destructive operations requires approval
	const destructivePatterns = [
		"delete",
		"remove",
		"drop",
		"truncate",
		"send",
		"publish",
		"deploy",
		"execute",
	];
	const actionLower = action.toLowerCase();
	if (
		riskScore >= thresholds.medium &&
		destructivePatterns.some((p) => actionLower.includes(p))
	) {
		return {
			requiresApproval: true,
			reason: `Destructive action "${action}" with medium risk (${riskScore}%) requires approval`,
			level: "medium",
		};
	}

	// Determine level for informational purposes
	let level: RiskLevel = "low";
	if (riskScore >= thresholds.high) {
		level = "high";
	} else if (riskScore >= thresholds.medium) {
		level = "medium";
	}

	return { requiresApproval: false, reason: "", level };
}

/**
 * Create a risk-aware HITL request
 */
export function createRiskAwareHITLRequest(
	requestId: string,
	prompt: string,
	riskAssessment: HITLRiskAssessment,
	options?: {
		title?: string;
		context?: Record<string, unknown>;
		timeout?: number;
		sourceTask?: string;
	},
): RiskAwareHITLRequest {
	return {
		requestId,
		type: "approval",
		prompt,
		title:
			options?.title ??
			`Risk-based Approval Required (${riskAssessment.level})`,
		context: {
			...options?.context,
			riskScore: riskAssessment.score,
			riskLevel: riskAssessment.level,
			riskFactors: riskAssessment.factors,
		},
		timeout: options?.timeout,
		createdAt: Date.now(),
		riskAssessment,
		autoTriggered: true,
		sourceTask: options?.sourceTask,
	};
}
