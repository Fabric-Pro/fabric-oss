import type { UiMode } from "@repo/database";

/**
 * Which chat controls each interface mode shows (Fizzy #2040).
 *
 * Shared rather than re-derived per surface. The full page and the floating
 * launcher each gated their own controls on `uiMode` independently, and they
 * drifted: the page kept rendering the collapsed control-deck rail in simple
 * mode while holding `sidebarOpen` false for the whole mode, so every rail
 * button moved its own highlight and opened nothing. A control that answers a
 * click by doing nothing reads as broken, not as hidden.
 *
 * The rule the modes actually encode: simple mode hides how the work is
 * *carried out* — the engine, the reasoning depth, the tools, the deck — but
 * not *which model* answers. Picking a model is a first-class choice in both
 * modes.
 */
export interface InterfaceModeChrome {
	/** The left control deck, and the collapsed icon rail that expands it. */
	showControlDeck: boolean;
	/** The agent / model picker in the composer. */
	showAgentPicker: boolean;
	/** The per-conversation tool picker in the composer. */
	showToolPicker: boolean;
}

export function getInterfaceModeChrome(uiMode: UiMode): InterfaceModeChrome {
	const isAdvanced = uiMode === "advanced";

	return {
		showControlDeck: isAdvanced,
		showAgentPicker: true,
		showToolPicker: isAdvanced,
	};
}
