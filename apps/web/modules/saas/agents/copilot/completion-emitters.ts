/**
 * `COMPLETION_EMITTING_TOOL_NAMES` — Fizzy #1412 PR3 §7.4 dev-spike output.
 *
 * # What this is
 *
 * The candidate allow-list of CopilotKit `useCopilotAction` tool names
 * whose successful resolution should fire a persistent operation-result
 * `role: "system"` message into the underlying `AgentConversation`.
 *
 * # Why this is doc-only in PR3
 *
 * The dev spike performed during PR3 looked at every `useCopilotAction`
 * registration in `apps/web/modules/saas/{agents,projects}/` and every
 * tool definition in `agents/langchain/`. Findings:
 *
 *   - **`confirm_changes`** is the only frontend action that reliably
 *     signals "the user accepted an AI-proposed operation". It is the
 *     terminal client-side step of the document-generator flow (the
 *     backend agent's `write_document_local` tool emits a model turn
 *     that ends with a `confirm_changes` tool call — see
 *     `agents/langchain/document-generator/nodes/chat-node.ts:9`),
 *     and `<ConfirmChangesDialog>` resolves with the user's accept /
 *     reject decision via `renderAndWaitForResponse`'s `respond`.
 *   - **`write_document_local`** is a BACKEND tool, not a frontend
 *     action. It precedes `confirm_changes` but does not by itself
 *     mean the operation completed — a user reject inside the
 *     confirm dialog reverts the document.
 *   - **`apply_diff`** appears nowhere in the current codebase. The
 *     plan listed it as a possible candidate but it has no
 *     concrete implementation today.
 *
 * Given that the spike outcome was effectively a single-entry list and
 * the proper wire-up requires a non-trivial chunk of frontend
 * integration testing (resolve-callback ordering, user-cancel path
 * de-duplication, idempotency across `<ConfirmChangesDialog>`
 * remounts), PR3 ships only this documentation constant and defers
 * the actual emission hook to a follow-up ticket. The plan §7.4
 * explicitly allows this collapse: "May be empty initial list ... in
 * which case Option A becomes 'emit no completion message for
 * A6/A7/A8 in v1 unless we ship a convention'". We satisfy that
 * outcome here without committing partial code that would lock in
 * the wrong shape.
 *
 * Follow-up ticket: "Wire CopilotKit `confirm_changes` resolution into
 * `agents.conversations.recordOperationResult` for document-generator
 * surfaces (A6/A7/A8)" — opens with the PR3 plan's `CopilotPersistenceHook.tsx`,
 * `useConversationHistory.ts`, and `StoryWorkspace.tsx` files as the
 * target wire-up surfaces.
 *
 * # Once the follow-up ships
 *
 * The intended consumer is a frontend hook that:
 *   1. Subscribes to the `respond` callback of every action in
 *      `COMPLETION_EMITTING_TOOL_NAMES`.
 *   2. When `respond` resolves with a "user confirmed" result,
 *      calls `agents.conversations.recordOperationResult` via
 *      `orpcClient` with `outcome: "success"` + the persisted document
 *      identifier as an `artifact`.
 *   3. When `respond` resolves with "user rejected", calls the
 *      same handler with `outcome: "cancelled"`.
 */
const COMPLETION_EMITTING_TOOL_NAMES = ["confirm_changes"] as const;

export type CompletionEmittingToolName =
	(typeof COMPLETION_EMITTING_TOOL_NAMES)[number];
