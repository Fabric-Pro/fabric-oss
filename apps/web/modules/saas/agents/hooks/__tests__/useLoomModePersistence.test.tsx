import { act, renderHook } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	type LoomChatMode,
	type LoomReasoningMode,
	useLoomModePersistence,
} from "../useLoomModePersistence";

type Saved = { chatMode: LoomChatMode; reasoningMode: LoomReasoningMode };

// Mirrors the Loom page: the saved preferences are server-rendered, so they
// are present on the first render, and the hydration effect is declared
// before the persistence hook and runs in the same mount pass.
function useLoomPage(saved: Saved, onPersist: () => void) {
	const [chatMode, setChatMode] = useState<LoomChatMode>("orchestrator");
	const [reasoningMode, setReasoningMode] =
		useState<LoomReasoningMode>("balanced");
	const hydratedRef = useRef(false);
	const [hydrated, setHydrated] = useState(false);
	const lastPersistedChatModeRef = useRef<LoomChatMode | null>(null);
	const lastPersistedReasoningModeRef = useRef<LoomReasoningMode | null>(
		null,
	);

	useEffect(() => {
		if (hydratedRef.current) {
			return;
		}
		setChatMode(saved.chatMode);
		setReasoningMode(saved.reasoningMode);
		lastPersistedChatModeRef.current = saved.chatMode;
		lastPersistedReasoningModeRef.current = saved.reasoningMode;
		hydratedRef.current = true;
		setHydrated(true);
	}, [saved]);

	useLoomModePersistence({
		hydrated,
		disabled: false,
		chatMode,
		reasoningMode,
		lastPersistedChatModeRef,
		lastPersistedReasoningModeRef,
		onPersist,
	});

	return { hydrated, setChatMode, setReasoningMode };
}

describe("useLoomModePersistence", () => {
	it("sends nothing when the page loads saved modes that differ from the defaults", () => {
		const onPersist = vi.fn();
		const saved: Saved = { chatMode: "direct", reasoningMode: "deep" };

		const { result } = renderHook(() => useLoomPage(saved, onPersist));

		expect(result.current.hydrated).toBe(true);
		expect(onPersist).not.toHaveBeenCalled();
	});

	it("sends one write for each mode the user changes after loading", () => {
		const onPersist = vi.fn();
		const saved: Saved = { chatMode: "direct", reasoningMode: "deep" };
		const { result } = renderHook(() => useLoomPage(saved, onPersist));

		act(() => result.current.setChatMode("research"));
		act(() => result.current.setReasoningMode("lite"));

		expect(onPersist.mock.calls).toEqual([
			[{ chatMode: "research" }],
			[{ reasoningMode: "lite" }],
		]);
	});

	it("sends nothing when the user picks the mode that is already saved", () => {
		const onPersist = vi.fn();
		const saved: Saved = { chatMode: "direct", reasoningMode: "deep" };
		const { result } = renderHook(() => useLoomPage(saved, onPersist));

		act(() => result.current.setChatMode("research"));
		act(() => result.current.setChatMode("research"));

		expect(onPersist).toHaveBeenCalledTimes(1);
	});
});
