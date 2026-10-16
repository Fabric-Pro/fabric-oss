import type { ReasoningMode } from "@saas/agents/components/ReasoningModeSelector";
import type { ChatEngine } from "./interface-mode-engine";

/**
 * What a stored conversation's metadata says about how it was conducted, read
 * one way for every surface that reopens a conversation (the full page and the
 * drawer). Each engine only knows how to continue its own threads, so opening
 * a conversation on the wrong one renders it blank; this is the one place that
 * decides which engine that is.
 */
interface RestoredConversationSettings {
	/** The mode recorded with the conversation; null for one that predates the field. */
	mode: ChatEngine | null;
	/** The engine that runs the conversation: its recorded mode, or Direct for an older one. */
	engine: ChatEngine;
	/** The reasoning mode it ran in, when one was recorded. */
	reasoningMode: ReasoningMode | null;
	/** The uploaded-document chat it was attached to, when there is one. */
	documentChatId: string | null;
	/** The agent instance it ran as, when there is one. */
	instanceId: string | null;
}

const MODES: readonly ChatEngine[] = ["direct", "orchestrator", "research"];
const REASONING_MODES: readonly ReasoningMode[] = [
	"lite",
	"balanced",
	"deep",
	"planner",
];

function recordOf(metadata: unknown): Record<string, unknown> {
	return metadata && typeof metadata === "object"
		? (metadata as Record<string, unknown>)
		: {};
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `unrecordedEngine` is the engine for a conversation that records none: a chat
 * just continued from another member's shared conversation, which starts on
 * the reader's own engine and writes it into its metadata with its first turn.
 * Any other conversation without a mode predates the field and was Direct.
 */
export function restoreFromConversationMetadata(
	metadata: unknown,
	unrecordedEngine?: ChatEngine,
): RestoredConversationSettings {
	const recorded = recordOf(metadata);
	const mode =
		MODES.find((candidate) => candidate === recorded.mode) ??
		unrecordedEngine ??
		null;
	const reasoningMode =
		REASONING_MODES.find(
			(candidate) => candidate === recorded.executionMode,
		) ?? null;
	return {
		mode,
		engine: mode ?? "direct",
		reasoningMode,
		documentChatId: stringOrNull(recorded.documentChatId),
		instanceId: stringOrNull(recorded.instanceId),
	};
}

/**
 * The engine the drawer opens a conversation on. The drawer has no Deep
 * Research surface and that view cannot replay a stored thread, so a Research
 * conversation opens on Direct, which renders its stored messages.
 */
export function drawerEngineFor(engine: ChatEngine): "direct" | "orchestrator" {
	return engine === "orchestrator" ? "orchestrator" : "direct";
}
