import type { HistoryView } from "../components/stories/BacklogAuditDialog";

/**
 * Resolve which history view the roadmap's history window should show.
 *
 * There is no permission branch here: `pmSyncLog.list` and
 * `backlog.history.audit.list` are both gated on `PROJECT_READ`, so anyone who
 * can open the window can read either tab. The frontend deliberately does not
 * re-derive that rule — a client-side role list is what previously drifted from
 * the server, since permissions can also be granted by org role, which the
 * project-role field cannot express.
 */
export function resolveHistoryView(requested: HistoryView | null): HistoryView {
	return requested ?? "changes";
}
