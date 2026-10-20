/**
 * How the Direct engine is told to read the past executions recalled for a
 * turn: semantically similar tasks the assistant ran before, with their
 * outcome.
 *
 * The Orchestrator's counterpart is `orchestrator-memory-prompt`. Both live in
 * `@repo/utils`, a leaf package `@repo/database` and `@repo/temporal` already
 * depend on, so the seed and the activity that resolves the binding share ONE
 * definition.
 */

/**
 * Prompt Library agent key for the editable past-execution instructions.
 *
 * Shared by the seed's SYSTEM prompt and binding, the catalog's agent target
 * and the Direct engine's prompt assembly. A mismatch between any two of them
 * resolves no binding and falls back to the default body forever, silently.
 */
export const DIRECT_CHAT_MEMORY_PROMPT_AGENT_KEY = "direct_chat_memory_context";

/**
 * The default past-execution instructions, as an organization may edit them.
 *
 * A recalled execution is history: a "success" says the task worked when it
 * ran, not that what it created still exists. Read as fact, it lets the model
 * tell a user that a workflow deleted since is in place, or that work was done
 * in this turn when no tool ran. So the body frames every recalled execution as
 * history and forbids reporting it as current, or as done in this turn,
 * without checking it with a tool now.
 *
 * Takes no variables. The executions themselves are data: the prompt assembly
 * puts them, one dated entry each, in the untrusted `session_memory` block and
 * adds this body after it, outside the block, only when that block exists —
 * text inside an untrusted block is never followed as an instruction.
 *
 * INSERT-ONLY once seeded: changing this text does nothing on an environment
 * that has already run the seed. Ship wording changes as an explicit UPDATE
 * migration.
 */
export const DIRECT_CHAT_MEMORY_FALLBACK_BODY = `## Recalled Past Executions
The <retrieved_context source="session_memory"> block holds past tasks semantically similar to this request, recalled from earlier sessions. They are history, not current state: each entry says what was done when it ran, on the date shown. Anything it created, scheduled, ran, published or changed may since have been changed, undone or deleted.

Use them to:
- Apply successful patterns from past tasks
- Avoid mistakes from failed attempts
- Choose appropriate tools and agents based on what worked before

Never report anything as done in this turn because a past execution did it. Only what you do with a tool in this turn has been done in this turn. Before you tell the user that something a past execution created or changed still exists or is still in place, check it now with a tool. If you cannot check it, say what was done and when, and that you have not confirmed it is still there.`;
