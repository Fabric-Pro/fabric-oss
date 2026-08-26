/**
 * Document Workspaces Router
 *
 * API routes for managing document workspaces, documents, and members.
 * Provides personal and organization-level document storage with vectorization.
 */

import {
	attachWorkspaceProcedure,
	detachWorkspaceProcedure,
	getAvailableDocumentsProcedure,
	getConversationWorkspacesProcedure,
	getQdrantPointIdsProcedure,
} from "./procedures/conversations";
import { createWorkspaceProcedure } from "./procedures/create-workspace";
import {
	confirmUploadProcedure,
	createUploadUrlProcedure,
	deleteDocumentProcedure,
	getDocumentProcedure,
	getDocumentStatsProcedure,
	listDocumentsProcedure,
	retryDocumentProcedure,
	serverUploadProcedure,
} from "./procedures/documents";
import {
	getPersonalWorkspaceProcedure,
	getWorkspaceProcedure,
} from "./procedures/get-workspace";
import {
	getWorkspaceStatsProcedure,
	listWorkspacesProcedure,
} from "./procedures/list-workspaces";
import {
	addWorkspaceAgentProcedure,
	addWorkspaceMemberProcedure,
	changeWorkspaceMemberGroupProcedure,
	getWorkspaceMembersProcedure,
	removeWorkspaceAgentProcedure,
	removeWorkspaceMemberProcedure,
	searchUsersForWorkspaceProcedure,
} from "./procedures/members";
import {
	getWorkspaceRagSettingsProcedure,
	updateWorkspaceRagSettingsProcedure,
} from "./procedures/rag-settings";
import {
	archiveWorkspaceProcedure,
	deleteWorkspaceProcedure,
	reactivateWorkspaceProcedure,
	updateWorkspaceProcedure,
} from "./procedures/update-workspace";

export const documentWorkspacesRouter = {
	// Workspace CRUD
	create: createWorkspaceProcedure,
	list: listWorkspacesProcedure,
	get: getWorkspaceProcedure,
	getPersonal: getPersonalWorkspaceProcedure,
	getStats: getWorkspaceStatsProcedure,
	update: updateWorkspaceProcedure,
	archive: archiveWorkspaceProcedure,
	reactivate: reactivateWorkspaceProcedure,
	delete: deleteWorkspaceProcedure,

	// Members management
	members: {
		list: getWorkspaceMembersProcedure,
		add: addWorkspaceMemberProcedure,
		remove: removeWorkspaceMemberProcedure,
		changeGroup: changeWorkspaceMemberGroupProcedure,
		searchUsers: searchUsersForWorkspaceProcedure,
	},

	// Agent management
	agents: {
		add: addWorkspaceAgentProcedure,
		remove: removeWorkspaceAgentProcedure,
	},

	// Documents management
	documents: {
		list: listDocumentsProcedure,
		get: getDocumentProcedure,
		getStats: getDocumentStatsProcedure,
		createUploadUrl: createUploadUrlProcedure,
		confirmUpload: confirmUploadProcedure,
		serverUpload: serverUploadProcedure,
		delete: deleteDocumentProcedure,
		retry: retryDocumentProcedure,
	},

	// Conversation-workspace attachments
	conversations: {
		attach: attachWorkspaceProcedure,
		detach: detachWorkspaceProcedure,
		getWorkspaces: getConversationWorkspacesProcedure,
		getAvailableDocuments: getAvailableDocumentsProcedure,
		getQdrantPointIds: getQdrantPointIdsProcedure,
	},

	// RAG settings
	ragSettings: {
		get: getWorkspaceRagSettingsProcedure,
		update: updateWorkspaceRagSettingsProcedure,
	},
};
