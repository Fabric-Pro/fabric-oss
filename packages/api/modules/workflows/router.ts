import {
	createWorkflowApiKeyProcedure,
	listWorkflowApiKeysProcedure,
	revokeWorkflowApiKeyProcedure,
} from "./procedures/api-keys";
import {
	createApprovalTemplateProcedure,
	deleteApprovalTemplateProcedure,
	listApprovalTemplatesProcedure,
	updateApprovalTemplateProcedure,
} from "./procedures/approval-templates";
import {
	getApproval,
	listPendingApprovals,
	respondToApproval,
} from "./procedures/approvals";
import { createWorkflowProcedure } from "./procedures/create-workflow";
import { deleteWorkflowProcedure } from "./procedures/delete-workflow";
import { duplicateWorkflowProcedure } from "./procedures/duplicate-workflow";
import { cancelWorkflowExecutionProcedure } from "./procedures/executions/cancel-execution";
import { getWorkflowExecutionProcedure } from "./procedures/executions/get-execution";
import { getExecutionStatsProcedure } from "./procedures/executions/get-execution-stats";
import { listWorkflowExecutionsProcedure } from "./procedures/executions/list-executions";
import { startWorkflowExecutionProcedure } from "./procedures/executions/start-execution";
import { generateCodeProcedure } from "./procedures/generate-code";
import { generateFromPromptProcedure } from "./procedures/generate-from-prompt";
import { getAvailableModels } from "./procedures/get-available-models";
import { getWorkflowProcedure } from "./procedures/get-workflow";
import { getWorkflowStatsProcedure } from "./procedures/get-workflow-stats";
import { deleteIntegrationProcedure } from "./procedures/integrations/delete-integration";
import { disconnectByTypeProcedure } from "./procedures/integrations/disconnect-by-type";
import { listDatabricksIndexesProcedure } from "./procedures/integrations/list-databricks-indexes";
import { listIntegrationStatusProcedure } from "./procedures/integrations/list-integration-status";
import { listIntegrationsProcedure } from "./procedures/integrations/list-integrations";
import { listSlackChannelsProcedure } from "./procedures/integrations/list-slack-channels";
import { listTeamsChatsProcedure } from "./procedures/integrations/list-teams-chats";
import { saveIntegrationProcedure } from "./procedures/integrations/save-integration";
import { testIntegrationConnectionProcedure } from "./procedures/integrations/test-connection";
import { testSavedConnectionProcedure } from "./procedures/integrations/test-saved-connection";
import { listWorkflowsProcedure } from "./procedures/list-workflows";
import {
	publishWorkflow,
	rollbackWorkflow,
	unpublishWorkflow,
} from "./procedures/publish";
import { updateWorkflowProcedure } from "./procedures/update-workflow";
import { createWorkflowVersionProcedure } from "./procedures/versions/create-version";
import { listWorkflowVersionsProcedure } from "./procedures/versions/list-versions";

export const workflowsRouter = {
	// Workflow CRUD operations
	list: listWorkflowsProcedure,
	get: getWorkflowProcedure,
	create: createWorkflowProcedure,
	update: updateWorkflowProcedure,
	delete: deleteWorkflowProcedure,
	duplicate: duplicateWorkflowProcedure,
	stats: getWorkflowStatsProcedure,

	// Code generation
	generateCode: generateCodeProcedure,

	// AI-powered workflow generation
	generateFromPrompt: generateFromPromptProcedure,

	// AI Gateway operations
	getAvailableModels,

	// Publishing operations
	publish: {
		publish: publishWorkflow,
		unpublish: unpublishWorkflow,
		rollback: rollbackWorkflow,
	},

	// Version operations
	versions: {
		list: listWorkflowVersionsProcedure,
		create: createWorkflowVersionProcedure,
	},

	// Execution operations
	executions: {
		list: listWorkflowExecutionsProcedure,
		get: getWorkflowExecutionProcedure,
		stats: getExecutionStatsProcedure,
		start: startWorkflowExecutionProcedure,
		cancel: cancelWorkflowExecutionProcedure,
	},

	// API keys for triggering a published workflow's webhook
	apiKeys: {
		create: createWorkflowApiKeyProcedure,
		list: listWorkflowApiKeysProcedure,
		revoke: revokeWorkflowApiKeyProcedure,
	},

	// Integration operations
	integrations: {
		list: listIntegrationsProcedure,
		listStatus: listIntegrationStatusProcedure,
		save: saveIntegrationProcedure,
		delete: deleteIntegrationProcedure,
		disconnectByType: disconnectByTypeProcedure,
		testConnection: testIntegrationConnectionProcedure,
		testSavedConnection: testSavedConnectionProcedure,
		listTeamsChats: listTeamsChatsProcedure,
		listSlackChannels: listSlackChannelsProcedure,
		listDatabricksIndexes: listDatabricksIndexesProcedure,
	},

	// Approval operations (Human-in-the-Loop)
	approvals: {
		list: listPendingApprovals,
		get: getApproval,
		respond: respondToApproval,
	},

	// Approval templates for auto-approval configuration
	approvalTemplates: {
		list: listApprovalTemplatesProcedure,
		create: createApprovalTemplateProcedure,
		update: updateApprovalTemplateProcedure,
		delete: deleteApprovalTemplateProcedure,
	},
};
