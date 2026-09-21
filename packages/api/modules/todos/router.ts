import { assignTodoProcedure } from "./procedures/assign";
import { bulkResolveTodosProcedure } from "./procedures/bulk-resolve";
import { catchUpTodosProcedure } from "./procedures/catch-up";
import { completeTodoProcedure } from "./procedures/complete";
import { createNonMemberContactProcedure } from "./procedures/contacts/create";
import { deleteNonMemberContactProcedure } from "./procedures/contacts/delete";
import { listNonMemberContactsProcedure } from "./procedures/contacts/list";
import { updateNonMemberContactProcedure } from "./procedures/contacts/update";
import { createTodoProcedure } from "./procedures/create";
import { todoLinkedWorkItemsProcedure } from "./procedures/linked-work-items";
import { listTodosProcedure } from "./procedures/list";
import { manageProposalLinkProcedure } from "./procedures/manage-proposal-link";
import { pendingProposalMeetingsProcedure } from "./procedures/pending-proposals";
import { snoozeTodoProcedure } from "./procedures/snooze";
import { unsnoozeTodoProcedure } from "./procedures/unsnooze";

/**
 * Consolidated To Do list (Fizzy #2340).
 *
 * The contact register is nested here because a non-member contact exists to be
 * assigned a to-do — but note it is deliberately NOT behind the `TODO_LIST`
 * rollout gate. A contact outlives the page that motivated it, and gating the
 * register would mean turning the page off strands every record someone
 * entered. The gate covers the To Do page's own reads, writes and navigation;
 * these four procedures answer to the organization member permissions alone.
 */
export const todosRouter = {
	list: listTodosProcedure,
	create: createTodoProcedure,
	complete: completeTodoProcedure,
	snooze: snoozeTodoProcedure,
	unsnooze: unsnoozeTodoProcedure,
	assign: assignTodoProcedure,
	bulkResolve: bulkResolveTodosProcedure,
	// Called by the page on open. It is the ONLY thing that reaches a meeting
	// the live extraction path never started the owner matcher for — everything
	// analyzed before this organization's gate opened, plus anything whose
	// fire-and-forget start was lost to a Temporal fault. Without it, enabling
	// the flag yields an empty page and no way to tell that from a broken one.
	catchUp: catchUpTodosProcedure,
	// Feature-proposal state, surfaced on the to-dos a meeting produced. Kept as
	// its own group because it answers about a MEETING, not about one to-do —
	// a badge repeated on every row of one meeting is noise.
	proposals: {
		pendingMeetings: pendingProposalMeetingsProcedure,
		linkedWorkItems: todoLinkedWorkItemsProcedure,
		manageLink: manageProposalLinkProcedure,
	},
	contacts: {
		list: listNonMemberContactsProcedure,
		create: createNonMemberContactProcedure,
		update: updateNonMemberContactProcedure,
		delete: deleteNonMemberContactProcedure,
	},
};
