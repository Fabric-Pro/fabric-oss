import { type RefObject, useEffect, useRef } from "react";

export type LoomChatMode = "direct" | "orchestrator" | "research";
export type LoomReasoningMode = "lite" | "balanced" | "deep" | "planner";

/**
 * Saves the Loom chat mode and reasoning mode when the user changes them.
 *
 * The caller seeds the `lastPersisted*` refs with every value that is
 * already saved (hydration, a restored conversation, a "New" reset), so a
 * state change that only echoes a saved value sends nothing.
 *
 * `hydrated` must be state set in the same batch as the hydrated modes, not
 * a ref. Server-rendered preferences hydrate in the first effect pass; a ref
 * would already read true in that pass, while `chatMode` and `reasoningMode`
 * still hold the defaults, so every page load wrote the defaults and then
 * the saved values back.
 */
export function useLoomModePersistence({
	hydrated,
	disabled,
	chatMode,
	reasoningMode,
	lastPersistedChatModeRef,
	lastPersistedReasoningModeRef,
	onPersist,
}: {
	hydrated: boolean;
	/** Instance-backed chats are per-launch, not a user preference. */
	disabled: boolean;
	chatMode: LoomChatMode;
	reasoningMode: LoomReasoningMode;
	lastPersistedChatModeRef: RefObject<LoomChatMode | null>;
	lastPersistedReasoningModeRef: RefObject<LoomReasoningMode | null>;
	onPersist: (
		input:
			| { chatMode: LoomChatMode }
			| { reasoningMode: LoomReasoningMode },
	) => void;
}) {
	const onPersistRef = useRef(onPersist);
	onPersistRef.current = onPersist;

	useEffect(() => {
		if (!hydrated || disabled) {
			return;
		}
		if (lastPersistedChatModeRef.current === chatMode) {
			return;
		}
		lastPersistedChatModeRef.current = chatMode;
		onPersistRef.current({ chatMode });
	}, [hydrated, chatMode, disabled]);

	useEffect(() => {
		if (!hydrated || disabled) {
			return;
		}
		if (lastPersistedReasoningModeRef.current === reasoningMode) {
			return;
		}
		lastPersistedReasoningModeRef.current = reasoningMode;
		onPersistRef.current({ reasoningMode });
	}, [hydrated, reasoningMode, disabled]);
}
