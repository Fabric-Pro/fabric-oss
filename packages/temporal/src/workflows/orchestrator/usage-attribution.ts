/**
 * Usage attribution for the orchestrator's model-calling activities.
 *
 * The Advisor routes verify that the caller owns `conversationId` before they
 * start the workflow. The workflow forwards it, through this helper, to the
 * activities that resolve a model in-process: the loop's rounds, synthesis,
 * tool-result summarizer and compaction; the clarity checks; routing and
 * planning; and the trajectory summary. Plan steps and tool calls carry it on
 * their own inputs. The tests in `__tests__/usage-attribution-wiring.test.ts`
 * and `phases/__tests__/usage-attribution.test.ts` cover those call sites; a
 * new model-calling activity has to be added to them by hand. The resolver
 * copies the ID onto the `AiUsageLog` row, letting a chat's cost be grouped by
 * conversation. It is attribution only: never the execution ID, and a run
 * without a conversation forwards nothing.
 */

/**
 * `conversationId` spread for an activity input: empty when the run has no
 * conversation, so such a run schedules the activity with the input it always
 * had.
 */
export function conversationIdField(input: {
	conversationId?: string;
}): { conversationId: string } | Record<string, never> {
	return input.conversationId ? { conversationId: input.conversationId } : {};
}
