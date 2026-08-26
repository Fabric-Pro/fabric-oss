/**
 * Planning Module
 *
 * Handles task planning and decomposition for the orchestrator.
 * Includes strategy-based planning and execution strategy selection.
 */

export { createTaskPlan } from "./create-task-plan";
export { createEnhancedTaskPlan } from "./enhanced-planner";
export {
	EXECUTION_STRATEGIES,
	getStrategyPhases,
	isParallelizableStrategy,
	selectExecutionStrategy,
	strategyRequiresResearch,
} from "./execution-strategies";
// Multi-Model Planning Pipeline
export {
	createMultiModelPlan,
	createMultiModelPlanActivity,
	DEFAULT_MULTI_MODEL_CONFIG,
	type MultiModelPlannerConfig,
	type MultiModelPlanResult,
	type PlanDraft,
	type PlanReview,
	type PlanReviewIssue,
	type PlanReviewSuggestion,
	type RefinedPlan,
} from "./multi-model-planner";
// Operation Risk Detection
export {
	assessToolCallRisk,
	type DetectionInput,
	detectOperationRisk,
	explainRiskAssessment,
	type OperationType,
	type RiskAssessment,
	type RiskLevel,
	type ToolCallRiskAssessment,
	validateToolsForDestructivePatterns,
} from "./operation-risk-detector";
// Phase 2: Plan Validation
export {
	type DependencyAnalysisResult,
	type ExecutorAvailabilityResult,
	type PermissionCheckResult,
	type PlanEstimates,
	type PlanSuggestion,
	type PlanValidationIssue,
	type PlanValidationResult,
	type ValidatePlanInput,
	validatePlan,
} from "./plan-validator";
// Phase 6.1: Planning Decision Audit Trail
export {
	type ContextSource,
	// Types
	type ContextSourceType,
	createDecompositionDecision,
	createExecutorDecision,
	createLettaMemorySource,
	createMcpToolSource,
	createNegativeMemorySource,
	// Helper functions
	createPlanningAuditBuilder,
	createResearchDecision,
	createSemanticMemorySource,
	createTrajectoryReuseSource,
	createWorkspaceRagSource,
	formatAuditForDisplay,
	// Builder class
	PlanningAuditBuilder,
	type PlanningAuditSummary,
	type PlanningAuditTrail,
	type PlanningDecision,
} from "./planning-audit";
// Phase 4.2: Step I/O Contracts
export {
	type ArtifactWiring,
	autoWireSteps,
	autoWireStepsActivity,
	type ContractValidationError,
	type ContractValidationResult,
	type ContractValidationWarning,
	type InputRequirement,
	// Types
	type IOParameter,
	// Activity functions
	inferAndValidateContractsActivity,
	inferPlanContracts,
	// Functions
	inferStepContract,
	type JsonSchema,
	type OutputDeclaration,
	type StepIOContract,
	validateContracts,
	visualizeContracts,
} from "./step-io-contracts";
