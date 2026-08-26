/**
 * Weave API Router
 *
 * API endpoints for fabric-weave multi-agent orchestration
 */

import { approvePlanProcedure } from "./procedures/approve-plan";
import { cancelExecutionProcedure } from "./procedures/cancel-execution";
import { chatProcedure } from "./procedures/chat";
import { createPlanProcedure } from "./procedures/create-plan";
import { deletePlanProcedure } from "./procedures/delete-plan";
import { getConfigProcedure } from "./procedures/get-config";
import { getExecutionProcedure } from "./procedures/get-execution";
import { getPlanProcedure } from "./procedures/get-plan";
import { listPlansProcedure } from "./procedures/list-plans";
import { listTemplatesProcedure } from "./procedures/list-templates";
import { refineRequestProcedure } from "./procedures/refine-request";
import { retryGenerationProcedure } from "./procedures/retry-generation";
import { revisePlanProcedure } from "./procedures/revise-plan";
import { saveTemplateProcedure } from "./procedures/save-template";
import {
	autoApproveAllProcedure,
	retryFromStepProcedure,
	revokeAutoApproveProcedure,
	signalApprovalProcedure,
} from "./procedures/signal-approval";
import { startExecutionProcedure } from "./procedures/start-execution";
import { updateConfigProcedure } from "./procedures/update-config";
import { updatePlanCheckboxesProcedure } from "./procedures/update-plan-checkboxes";
import { useTemplateProcedure } from "./procedures/use-template";

export const weaveRouter = {
	plans: {
		create: createPlanProcedure,
		get: getPlanProcedure,
		list: listPlansProcedure,
		approve: approvePlanProcedure,
		revise: revisePlanProcedure,
		retryGeneration: retryGenerationProcedure,
		refine: refineRequestProcedure,
		updateCheckboxes: updatePlanCheckboxesProcedure,
		delete: deletePlanProcedure,
	},
	executions: {
		start: startExecutionProcedure,
		get: getExecutionProcedure,
		signalApproval: signalApprovalProcedure,
		autoApproveAll: autoApproveAllProcedure,
		revokeAutoApprove: revokeAutoApproveProcedure,
		retryFromStep: retryFromStepProcedure,
		cancel: cancelExecutionProcedure,
	},
	templates: {
		save: saveTemplateProcedure,
		list: listTemplatesProcedure,
		use: useTemplateProcedure,
	},
	config: {
		get: getConfigProcedure,
		update: updateConfigProcedure,
	},
	chat: chatProcedure,
};
