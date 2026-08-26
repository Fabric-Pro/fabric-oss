/**
 * Agent Deployments Router
 *
 * Provides endpoints for managing durable agent deployments:
 * - Deploy agent from template instance
 * - List/get deployments
 * - Lifecycle management (pause/resume/terminate)
 * - Manual execution triggers
 * - Webhook and schedule triggers
 */

import { deployProcedure } from "./procedures/deploy";
import {
	cancelExecutionProcedure,
	executeDeploymentProcedure,
} from "./procedures/execute";
import { getDeploymentProcedure } from "./procedures/get";
import {
	pauseDeploymentProcedure,
	resumeDeploymentProcedure,
	terminateDeploymentProcedure,
} from "./procedures/lifecycle";
import { listDeploymentsProcedure } from "./procedures/list";
import {
	getDeploymentRateLimitProcedure,
	getQuotaProcedure,
} from "./procedures/quota";
import {
	createTriggerProcedure,
	deleteTriggerProcedure,
	listTriggersProcedure,
	regenerateWebhookSecretProcedure,
	updateTriggerProcedure,
} from "./procedures/triggers";
import { handleWebhookProcedure } from "./procedures/webhook-handler";

export const agentDeploymentsRouter = {
	// Deployment CRUD
	deploy: deployProcedure,
	list: listDeploymentsProcedure,
	get: getDeploymentProcedure,

	// Lifecycle management
	pause: pauseDeploymentProcedure,
	resume: resumeDeploymentProcedure,
	terminate: terminateDeploymentProcedure,

	// Execution management
	execute: executeDeploymentProcedure,
	cancelExecution: cancelExecutionProcedure,

	// Trigger management
	triggers: {
		create: createTriggerProcedure,
		list: listTriggersProcedure,
		update: updateTriggerProcedure,
		delete: deleteTriggerProcedure,
		regenerateSecret: regenerateWebhookSecretProcedure,
	},

	// Public webhook handler
	webhook: handleWebhookProcedure,

	// Quota management
	quota: {
		get: getQuotaProcedure,
		deploymentRateLimit: getDeploymentRateLimitProcedure,
	},
};
