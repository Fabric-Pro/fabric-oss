import { classifyReadOnlyToolAccess } from "@repo/utils/read-only-mode";
import type { ParlumeSentenceQueue } from "./parlume-spoken-text";
import {
	type AgentToolInvocation,
	RUNTIME_TOOL_CONFIG_ID,
} from "./shared/agent-tool-runtime";

/**
 * The short line spoken when a tool starts and the agent said nothing first.
 * It names what kind of thing is happening, never the tool, its arguments or
 * an address.
 */
export function narrationFor(
	invocation: Pick<AgentToolInvocation, "source">,
): string | null {
	if (invocation.source.configId === RUNTIME_TOOL_CONFIG_ID) {
		return null;
	}
	const name = invocation.source.originalName;
	if (/create|(?:^|[_\s-])(?:add|new)(?:[_\s-]|$)/i.test(name)) {
		return "Creating that now.";
	}
	return classifyReadOnlyToolAccess(name) === "READ"
		? "Let me check."
		: "On it.";
}

/**
 * Keeps a voice meeting from going quiet while a tool runs. When a tool
 * starts it releases whatever the agent had begun to say, and only when the
 * agent has said nothing yet this turn does it speak a short line of its own,
 * so the agent's preamble is never doubled and the line is spoken once per
 * turn. Speech plays from the queue on its own, so nothing here waits for it.
 * Once someone has spoken over the reply, nothing more is narrated.
 */
export function createToolNarrator(
	queue: Pick<ParlumeSentenceQueue, "received" | "narrate" | "flush">,
	isMuted: () => boolean = () => false,
) {
	return async (invocation: Pick<AgentToolInvocation, "source">) => {
		// Lets the agent's last streamed words reach the queue first.
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (isMuted()) {
			return;
		}
		const line = narrationFor(invocation);
		if (line && !queue.received) {
			queue.narrate(line);
		}
		queue.flush();
	};
}
