export { continueInNewChat } from "./continue-in-new-chat";
export { createConversation } from "./create-conversation";
export {
	archiveConversation,
	deleteConversation,
	togglePin,
} from "./delete-conversation";
export {
	appendTurnForDocument,
	archiveForDocument,
	deleteForDocument,
	forkForDocument,
	getActiveForDocument,
	getByIdForDocument,
	listForDocument,
	recordDiffOutcome,
	renameForDocument,
	setVisibilityForDocument,
} from "./document-assistant";
export { getConversation } from "./get-conversation";
export { listConversations } from "./list-conversations";
// Tier 2 wire-up of the operation-completion system
// message handler. The handler itself shipped with PR1 (commit a18767752)
// but was deliberately not registered then (zero-callers attack-surface
// rationale, see the TODO comment at the top of the handler file). PR3
// adds the registration as the Backlog / CopilotKit callers come online.
export { recordOperationResult } from "./record-operation-result";
export {
	addMessage,
	updateConversation,
	updateTrajectory,
} from "./update-conversation";
