/**
 * Tools that don't fire on the server immediately — they synthesize a
 * matching ToolMessage via `buildConfirmChangesCommand` and stay
 * `pending` in `state.toolCallsByTurn` until the user accepts the
 * confirm_changes modal. Backend semantic (`agents/.../chat-node.ts`):
 * pending = awaiting user, NOT in-flight. Render them with a
 * non-spinning clock so the trace stops lying about state ("Calling X…"
 * implied the server was working; in reality the agent is parked,
 * waiting for the human). Match on canonical tool name only.
 *
 * Keep in sync with `INLINE_TOOLS` in chat-node.ts. Adding a tool that
 * does round-trip through `tool_node` (e.g. `write_document_asset`)
 * here would mask real in-flight failures as "awaiting confirmation"
 * — do not add server-side tools to this set.
 */
export const AWAITING_CONFIRMATION_TOOLS = new Set([
	"write_document_local",
	"apply_document_patches",
]);
