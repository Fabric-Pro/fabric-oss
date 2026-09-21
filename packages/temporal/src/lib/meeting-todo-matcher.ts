/**
 * The identity of one meeting's to-do owner-matcher run (Fizzy #2340).
 *
 * TWO call sites start `matchMeetingActionItemOwnersWorkflow` and they must
 * agree on the workflow id exactly, because that id is the whole of the
 * de-duplication between them:
 *
 *   - `activities/daily-brief/extract-meeting-insights.ts` starts it the
 *     moment a transcript's insights commit;
 *   - `@repo/api`'s `todos.catchUp` starts it for the meetings that were
 *     already extracted before the `TODO_LIST` gate opened for an
 *     organization, or whose start from the first site failed.
 *
 * The second site exists precisely because the first one is fire-and-forget:
 * a Temporal outage, or a start rejected because the previous run for the same
 * transcript was still RUNNING, would otherwise lose that meeting's to-dos for
 * good. So the two WILL race — a daily brief finishing while someone opens the
 * To Do page is the ordinary case, not the edge one — and a deterministic id
 * is what turns that race into one run instead of two sets of duplicate
 * to-dos.
 *
 * Hence a shared builder rather than the same template literal typed twice.
 * A drift between the two spellings would not fail anything: both starts would
 * simply succeed, against different ids, and the duplication would only show
 * up as doubled rows on someone's To Do page.
 *
 * Deliberately free of imports so it can be reached from `@repo/api` through
 * its own package export without dragging the Temporal client — and everything
 * the client pulls in — into the API's static module graph.
 */

/**
 * The queue the matcher runs on. The same queue the meeting digest's linking
 * workflow uses: both are short, database-bound follow-ups to a meeting, and
 * splitting them across queues would mean a worker fleet sized for one of them.
 */
export const MEETING_TODO_MATCHER_TASK_QUEUE = "project-documents";

/**
 * One matcher run per transcript row, named after it.
 *
 * Keyed on the transcript's cuid (`ProjectMeetingTranscript.id`) and NOT on the
 * Graph `transcriptId`: two projects can monitor the same meeting, each holds
 * its own transcript row with its own action items, and each needs its own run.
 */
export function meetingTodoMatcherWorkflowId(transcriptCuid: string): string {
	return `meeting-todo-owner-match:${transcriptCuid}`;
}
