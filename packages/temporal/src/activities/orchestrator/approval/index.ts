/**
 * Approval Module
 *
 * Handles HITL (Human-in-the-Loop) approval workflows.
 */

// Phase 3.3: Approval Templates
export {
	// Types
	type ApprovalTemplate,
	// Store
	approvalTemplateStore,
	type CreateTemplateInput,
	// Activity functions
	createApprovalTemplateActivity,
	deleteApprovalTemplateActivity,
	listApprovalTemplatesActivity,
	// Functions
	matchApprovalTemplate,
	matchApprovalTemplateActivity,
	type StepToMatch,
	suggestApprovalTemplatesActivity,
	suggestTemplates,
	type TemplateMatchResult,
	type TemplateSuggestion,
} from "./approval-templates";
// Runtime Authority Policy (Pipes-style authorization + trust reconciliation)
export {
	type AuthorityPolicyInput,
	type AuthorityPolicyResult,
	evaluateAuthorityPolicy,
	extractRequiredProviders,
} from "./authority-policy";
export { createOrchestratorApprovalRequest } from "./create-approval-request";
export { getApprovalStatus } from "./get-approval-status";
// Trust Activities (for Temporal workflows)
export {
	type AnalyzePlanApprovalInput,
	type AnalyzePlanApprovalOutput,
	analyzePlanApprovalActivity,
	type CheckStepAutoApprovalInput,
	checkStepAutoApprovalActivity,
	type GetTrustConfigInput,
	getTrustConfigActivity,
	type RecordApprovalOutcomeInput,
	recordApprovalOutcomeActivity,
} from "./trust-activities";
// Phase 3: Trust-based Approval
export {
	type AgentTrustConfig,
	type AutoApprovalDecision,
	analyzePlanForApproval,
	checkAutoApproval,
	loadTrustConfiguration,
	type OperationTrustConfig,
	type PlanApprovalSummary,
	recordTrustOutcome,
	saveTrustConfiguration,
	type TrustConfiguration,
	type TrustHistoryEntry,
	type TrustLevel,
} from "./trust-manager";
export {
	updateApprovalTaskStatus,
	updateExecutionProgress,
} from "./update-execution-progress";
