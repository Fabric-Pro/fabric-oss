/**
 * Dependency-free recursion-budget helpers for LangGraph agents.
 *
 * Kept in its own module so consumers can import the real implementation
 * without loading or mocking the main agent-core barrel.
 */

/**
 * `additional_kwargs` flag marking a human-role message the AGENT synthesized
 * rather than one the user actually sent.
 *
 * Some tool results can only be delivered to the model as user-role content —
 * images, for example, are valid as `image_url` parts on a `user` message but
 * not inside a tool-role message under the OpenAI chat-completions schema. The
 * tool node therefore emits the image payload as a follow-up human turn.
 *
 * Those synthetic turns must stay invisible to anything that reasons about
 * *user* turns: they neither start a new reasoning-trace turn nor reset the
 * per-turn tool-round budget. Without this flag, a tool that returns images
 * silently refills the agent's tool allowance every time it runs, letting a
 * run slip past `maxToolIterations` and only stop at the graph's hard
 * recursion limit.
 */
export const SYNTHETIC_TOOL_IMAGE_MESSAGE_FLAG = "fabricSyntheticToolImage";

/** True when a message is an agent-synthesized human turn (see the flag above). */
export function isSyntheticToolImageMessage(message: unknown): boolean {
	return (
		(message as { additional_kwargs?: Record<string, unknown> })
			?.additional_kwargs?.[SYNTHETIC_TOOL_IMAGE_MESSAGE_FLAG] === true
	);
}

/**
 * Count tool-calling rounds after the last human message.
 *
 * A "round" is one AI message with tool_calls. Agents use this to enforce a
 * per-human-turn tool budget without allowing older turns to consume the
 * current turn's allowance.
 *
 * Agent-synthesized human turns (see {@link SYNTHETIC_TOOL_IMAGE_MESSAGE_FLAG})
 * are skipped — they are tool output wearing a user role, so treating one as a
 * turn boundary would reset the budget mid-turn.
 *
 * @param messages - The full message history
 * @returns Number of AI tool-calling rounds since the last human message
 */
export function countToolRoundsSinceLastHuman(messages: object[]): number {
	let toolRounds = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as any;
		const mType =
			m._getType?.() ||
			m.type ||
			(m.role === "user"
				? "human"
				: m.role === "assistant"
					? "ai"
					: m.role || "");
		if (mType === "human" && !isSyntheticToolImageMessage(m)) {
			break;
		}
		const mToolCalls = m.tool_calls || m.toolCalls || [];
		if (
			mType === "ai" &&
			Array.isArray(mToolCalls) &&
			mToolCalls.length > 0
		) {
			toolRounds++;
		}
	}
	return toolRounds;
}

export interface RecursionLimitOptions {
	maxToolIterations: number;
	maxRetries?: number;
	graphOverhead?: number;
	buffer?: number;
}

/**
 * Derive a recursion limit that leaves enough supersteps to finalize safely.
 *
 * For a chat-to-tool loop, reaching the finalize call after N tool rounds
 * costs up to 2*N + 1 supersteps: chat runs N+1 times and tools run N times.
 * Retry self-loops cost one superstep each, while fixed graph nodes outside
 * the loop contribute graphOverhead. Therefore the invariant
 * recursionLimit >= 2*N + 1 + retries + overhead must hold; buffer adds a
 * safety margin above that floor.
 */
export function deriveRecursionLimit({
	maxToolIterations,
	maxRetries = 0,
	graphOverhead = 0,
	buffer = 5,
}: RecursionLimitOptions): number {
	return 2 * maxToolIterations + 1 + maxRetries + graphOverhead + buffer;
}
