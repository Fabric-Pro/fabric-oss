// Approve / reject / backlog share the same source-agnostic implementation as
// the channel monitor — the underlying PendingBacklogProposal table, story
// materialization, and apply-workflow dispatch are identical regardless of
// proposal source. Re-exporting under the chat-monitor namespace keeps the
// router surface symmetric without duplicating the ~500-line apply pipeline.
export {
	approvePendingProposalProcedure,
	backlogPendingProposalProcedure,
	rejectPendingProposalProcedure,
} from "../teams-channel-monitor";
export { countPendingProposalsProcedure } from "./count-pending-proposals";
export { disableTeamsChatMonitorProcedure } from "./disable-teams-chat-monitor";
export { enableTeamsChatMonitorProcedure } from "./enable-teams-chat-monitor";
export { getPendingProposalProcedure } from "./get-pending-proposal";
export { linkChatProcedure } from "./link-chat";
export { listLinkedChatsProcedure } from "./list-linked-chats";
export { listPendingProposalsProcedure } from "./list-pending-proposals";
export { triggerMonitorNowProcedure } from "./trigger-monitor-now";
export { unlinkChatProcedure } from "./unlink-chat";
