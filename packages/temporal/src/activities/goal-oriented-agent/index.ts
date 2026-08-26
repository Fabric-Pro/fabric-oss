/**
 * Goal-Oriented Agent Activities
 *
 * Activities for the goal-oriented agent workflow that provide:
 * - Goal-oriented planning (task decomposition with goal in mind)
 * - Step execution with tool calling
 * - Goal verification (LLM judge)
 * - Recovery strategies
 */

export {
	type CompleteGoalInput,
	completeGoalExecution,
} from "./completion";

export {
	type ExecuteGoalStepInput,
	type ExecuteGoalStepOutput,
	executeGoalStep,
} from "./execution";
export {
	type CreateGoalOrientedPlanInput,
	type CreateGoalOrientedPlanOutput,
	createGoalOrientedPlan,
} from "./planning";

export {
	attemptStepRecovery,
	type RecoveryInput,
	type RecoveryOutput,
} from "./recovery";
export {
	type VerifyGoalInput,
	verifyGoalAchievement,
} from "./verification";
