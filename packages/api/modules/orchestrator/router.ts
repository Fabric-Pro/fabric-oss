/**
 * Orchestrator API Router
 *
 * Endpoints for orchestrator configuration and management:
 * - Approval templates CRUD
 * - Memory preferences management
 * - Episodic memory access
 */

import {
	createApprovalTemplate,
	deleteApprovalTemplate,
	getApprovalTemplate,
	listApprovalTemplates,
	testApprovalTemplateMatch,
	updateApprovalTemplate,
} from "./procedures/approval-templates";
import {
	clearLearnedPatterns,
	deleteEpisode,
	deletePattern,
	getEpisodes,
	getPreferences,
	searchEpisodes,
	updatePreferences,
} from "./procedures/memory-preferences";

export const orchestratorRouter = {
	approvalTemplates: {
		list: listApprovalTemplates,
		get: getApprovalTemplate,
		create: createApprovalTemplate,
		update: updateApprovalTemplate,
		delete: deleteApprovalTemplate,
		test: testApprovalTemplateMatch,
	},
	memory: {
		getPreferences,
		updatePreferences,
		clearLearnedPatterns,
		deletePattern,
		getEpisodes,
		searchEpisodes,
		deleteEpisode,
	},
};
