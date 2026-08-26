/**
 * Agents API Router
 *
 * Provides endpoints for agent discovery, health monitoring, task management,
 * database-backed Agent Registry CRUD operations, and conversation management.
 */

import { listAgentActivity } from "./procedures/activity";
import { getProjectCodeIndexStatus } from "./procedures/code-index";
import { getCodeIndexPendingChanges } from "./procedures/code-index-pending-changes";
import {
	getAgentFeatureContext,
	getAgentProjectContext,
	getAgentTaskContext,
} from "./procedures/context";
import {
	addMessage,
	appendTurnForDocument,
	archiveConversation,
	archiveForDocument,
	continueInNewChat,
	createConversation,
	deleteConversation,
	deleteForDocument,
	forkForDocument,
	getActiveForDocument,
	getByIdForDocument,
	getConversation,
	listConversations,
	listForDocument,
	recordDiffOutcome,
	recordOperationResult,
	renameForDocument,
	setVisibilityForDocument,
	togglePin,
	updateConversation,
	updateTrajectory,
} from "./procedures/conversations";
import {
	getAgentHealth,
	getAllAgentsHealth,
} from "./procedures/get-agent-health";
import { getAgentTask } from "./procedures/get-agent-task";
import { getInstanceInsights } from "./procedures/get-instance-insights";
import { getInstanceVersions } from "./procedures/get-instance-versions";
import { listAgentInbox } from "./procedures/inbox";
import { listAgentTasks } from "./procedures/list-agent-tasks";
import { listAgents } from "./procedures/list-agents";
import { previewDraftAgent } from "./procedures/preview-draft-agent";
import {
	createRegisteredAgent,
	deleteRegisteredAgent,
	discoverA2AAgent,
	discoverAgent,
	discoverMcpAgent,
	getAgentConfig,
	getAgentObservability,
	getRegisteredAgent,
	healthCheckAgent,
	listAgentSuggestions,
	listRegisteredAgents,
	patchAgentSuggestion,
	refreshDynamicAgent,
	registerDynamicAgent,
	updateAgentSuggestions,
	updateRegisteredAgent,
} from "./procedures/registry";
import { restoreInstanceVersionProcedure } from "./procedures/restore-instance-version";
import { suggestSkillsProcedure } from "./procedures/suggest-skills";
import { symbolSearchProcedure } from "./procedures/symbol-search";
import { triggerAgent } from "./procedures/trigger-agent";

export const agentsRouter = {
	list: listAgents,
	trigger: triggerAgent,
	health: {
		get: getAgentHealth,
		getAll: getAllAgentsHealth,
	},
	context: {
		project: getAgentProjectContext,
		feature: getAgentFeatureContext,
		task: getAgentTaskContext,
	},
	activity: {
		list: listAgentActivity,
	},
	codeIndex: {
		status: getProjectCodeIndexStatus,
		pendingChanges: getCodeIndexPendingChanges,
	},
	inbox: {
		list: listAgentInbox,
	},
	tasks: {
		list: listAgentTasks,
		get: getAgentTask,
	},
	registry: {
		list: listRegisteredAgents,
		get: getRegisteredAgent,
		getConfig: getAgentConfig,
		create: createRegisteredAgent,
		update: updateRegisteredAgent,
		delete: deleteRegisteredAgent,
		healthCheck: healthCheckAgent,
		discover: discoverAgent,
		discoverA2A: discoverA2AAgent,
		discoverMcp: discoverMcpAgent,
		suggestions: {
			list: listAgentSuggestions,
			update: updateAgentSuggestions,
			patch: patchAgentSuggestion,
		},
		observability: {
			get: getAgentObservability,
		},
		// Dynamic registration
		registerDynamic: registerDynamicAgent,
		refreshDynamic: refreshDynamicAgent,
	},
	conversations: {
		list: listConversations,
		get: getConversation,
		create: createConversation,
		continueInNewChat: continueInNewChat,
		update: updateConversation,
		addMessage: addMessage,
		updateTrajectory: updateTrajectory,
		delete: deleteConversation,
		archive: archiveConversation,
		togglePin: togglePin,
		// Document-assistant procedures (spec 2026-05-19 §5). Mounted flat
		// under `agents.conversations` so public names stay
		// `agents.conversations.listForDocument` etc., matching the existing
		// CRUD nesting.
		listForDocument: listForDocument,
		getActiveForDocument: getActiveForDocument,
		getByIdForDocument: getByIdForDocument,
		appendTurnForDocument: appendTurnForDocument,
		setVisibilityForDocument: setVisibilityForDocument,
		archiveForDocument: archiveForDocument,
		deleteForDocument: deleteForDocument,
		renameForDocument: renameForDocument,
		recordDiffOutcome: recordDiffOutcome,
		forkForDocument: forkForDocument,
		// Operation-result message handler (project-
		// scoped, requires `requireProjectPermission(PROJECT_UPDATE)`).
		// The handler was authored in PR1 but only the persistence + auth
		// model was exercised in isolation via direct unit tests. PR3
		// brings online the first real caller (Backlog) and registers the
		// handler so the oRPC client surfaces it as
		// `agents.conversations.recordOperationResult`.
		recordOperationResult: recordOperationResult,
	},
	instances: {
		versions: getInstanceVersions,
		insights: getInstanceInsights,
		restore: restoreInstanceVersionProcedure,
	},
	suggestSkills: suggestSkillsProcedure,
	previewDraft: previewDraftAgent,
	symbolSearch: symbolSearchProcedure,
};
