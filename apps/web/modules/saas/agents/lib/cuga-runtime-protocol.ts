import { z } from "zod";
import { runtimeCustomEventName } from "./runtime-custom-events";

/**
 * The CUGA generalist chat over the agent runtime: what the
 * `cuga-generalist` engine (`modules/saas/agents/runtime/cuga-generalist-engine.ts`)
 * and the chat (`CugaAuthenticatedChat`) agree on.
 *
 * - The run's messages are the conversation so far; the last is the question.
 * - `forwardedProps` names the SYSTEM agent and the agent's conversation
 *   (`cugaChatPropsSchema`).
 * - The reply arrives whole: CUSTOM `fabric.cuga-generalist.context` with the
 *   agent's conversation id, the reasoning, the answer as one assistant text
 *   message with the agent's tool calls, then CUSTOM
 *   `fabric.cuga-generalist.artifacts` when there are any.
 * - Nothing is saved: the chat keeps the conversation id and sends it back.
 */

export const CUGA_GENERALIST_AGENT_ID = "cuga-generalist";

export const cugaChatPropsSchema = z.object({
	/** The SYSTEM registration (agentId or name) the chat talks to, as the route's body names it. */
	agentId: z.string().trim().min(1).max(200),
	/** The A2A conversation the agent keeps for this chat; null on the first send. Echoed from the agent, so the cap is generous. */
	contextId: z.string().min(1).max(4096).nullish(),
});
export type CugaChatProps = z.infer<typeof cugaChatPropsSchema>;

export const CUGA_CHAT_EVENT = {
	context: runtimeCustomEventName(CUGA_GENERALIST_AGENT_ID, "context"),
	artifacts: runtimeCustomEventName(CUGA_GENERALIST_AGENT_ID, "artifacts"),
} as const;

/** Only the field the chat uses, so a reply with no task id or with an odd status still keeps the conversation. */
export const cugaContextEventSchema = z.object({
	contextId: z.string().nullable(),
});

/** The value of `CUGA_CHAT_EVENT.artifacts`. */
export const cugaArtifactsEventSchema = z.object({
	artifacts: z.array(z.unknown()).min(1),
});
