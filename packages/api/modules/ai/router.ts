import { addMessageToChat } from "./procedures/add-message-to-chat";
import { cancelMessageWorkflow } from "./procedures/cancel-message-workflow";
import { createChat } from "./procedures/create-chat";
import { deleteChat } from "./procedures/delete-chat";
import { createDocumentUploadUrl } from "./procedures/documents/create-upload-url";
import { getDocumentContent } from "./procedures/documents/get-document-content";
import { getDocumentStatus } from "./procedures/documents/get-document-status";
import { getDocumentDownloadUrl } from "./procedures/documents/get-download-url";
import { listDocuments } from "./procedures/documents/list-documents";
import { processDocument } from "./procedures/documents/process-document";
import { uploadDocument } from "./procedures/documents/upload";
import {
	clearAiOutputRating,
	listAiOutputRatings,
	rateAiOutput,
} from "./procedures/feedback/rate-output";
import { findChat } from "./procedures/find-chat";
import { generateTitleWorkflow } from "./procedures/generate-title-workflow";
import { getWorkflowStatus } from "./procedures/get-workflow-status";
import { listChats } from "./procedures/list-chats";
import { retryFailedMessage } from "./procedures/retry-failed-message";
import { listChatTools } from "./procedures/tools/list-chat-tools";
import { updateChatTools } from "./procedures/tools/update-chat-tools";
import { updateChat } from "./procedures/update-chat";

export const aiRouter = {
	chats: {
		list: listChats,
		find: findChat,
		create: createChat,
		update: updateChat,
		delete: deleteChat,
		tools: {
			list: listChatTools,
			update: updateChatTools,
		},
		messages: {
			add: addMessageToChat,
		},
		workflows: {
			generateTitle: generateTitleWorkflow,
			getStatus: getWorkflowStatus,
			retry: retryFailedMessage,
			cancel: cancelMessageWorkflow,
		},
	},
	feedback: {
		rate: rateAiOutput,
		clear: clearAiOutputRating,
		list: listAiOutputRatings,
	},
	documents: {
		list: listDocuments,
		createUploadUrl: createDocumentUploadUrl,
		upload: uploadDocument,
		getDownloadUrl: getDocumentDownloadUrl,
		process: processDocument,
		getStatus: getDocumentStatus,
		getContent: getDocumentContent,
	},
};
