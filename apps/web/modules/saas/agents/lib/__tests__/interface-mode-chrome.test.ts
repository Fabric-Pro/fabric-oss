import { describe, expect, it } from "vitest";
import { getInterfaceModeChrome } from "../interface-mode-chrome";

/**
 * Pins the simple/advanced chrome contract (Fizzy #2040).
 *
 * The regression this guards: simple mode held `sidebarOpen` false for the
 * whole mode while still rendering the collapsed control-deck rail, so every
 * rail button moved its own highlight and opened nothing. The invariant that
 * would have caught it is the first test below — simple mode must not offer a
 * control deck it refuses to open.
 */
describe("getInterfaceModeChrome", () => {
	it("hides the control deck in simple mode", () => {
		expect(getInterfaceModeChrome("simple").showControlDeck).toBe(false);
	});

	it("shows the control deck in advanced mode", () => {
		expect(getInterfaceModeChrome("advanced").showControlDeck).toBe(true);
	});

	it("offers the model picker in both modes", () => {
		// Per the card review on 2026-08-17: simple mode drops the redundant
		// controls but gains the LLM choice. Choosing a model is not the same
		// as choosing an orchestration engine.
		expect(getInterfaceModeChrome("simple").showAgentPicker).toBe(true);
		expect(getInterfaceModeChrome("advanced").showAgentPicker).toBe(true);
	});

	it("keeps the tool picker advanced-only", () => {
		expect(getInterfaceModeChrome("simple").showToolPicker).toBe(false);
		expect(getInterfaceModeChrome("advanced").showToolPicker).toBe(true);
	});

	it("never exposes a deck control without the deck itself", () => {
		for (const mode of ["simple", "advanced"] as const) {
			const chrome = getInterfaceModeChrome(mode);
			if (chrome.showToolPicker) {
				expect(chrome.showControlDeck).toBe(true);
			}
		}
	});
});
