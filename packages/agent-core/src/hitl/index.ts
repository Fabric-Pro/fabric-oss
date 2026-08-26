/**
 * Human-in-the-Loop (HITL) Module
 *
 * Provides HITL functionality for AI agents including:
 * - Approval requests
 * - Input requests
 * - Choice requests
 * - Risk-based approvals (CUGA-inspired)
 */

export {
	CHOICE_PRESETS,
	createChoiceOptions,
	HITL_TOOLS,
	REQUEST_HUMAN_APPROVAL_TOOL,
	REQUEST_HUMAN_CHOICE_TOOL,
	REQUEST_HUMAN_INPUT_TOOL,
} from "./tools";
export type {
	HITLConfig,
	HITLOption,
	HITLRequest,
	HITLRequestType,
	HITLResponse,
	HITLRiskAssessment,
	HITLState,
	RiskAwareHITLRequest,
	// Risk-based types (CUGA-inspired)
	RiskLevel,
} from "./types";
export {
	createRiskAwareHITLRequest,
	DEFAULT_HITL_CONFIG,
	DEFAULT_HITL_STATE,
	requiresApproval,
	// Risk-based functions (CUGA-inspired)
	requiresRiskBasedApproval,
} from "./types";
