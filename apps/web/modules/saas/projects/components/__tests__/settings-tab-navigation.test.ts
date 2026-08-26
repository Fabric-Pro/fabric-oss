import { afterEach, describe, expect, it, vi } from "vitest";
import {
	NAVIGATE_TO_SETTINGS_TAB_EVENT,
	type NavigateToSettingsTabDetail,
	navigateToProjectSettingsTab,
} from "../settings-tab-navigation";

/**
 * Ported from the deleted `sync-history-navigation.test.ts`. That module was
 * removed when the sync log left Settings, but the contract it pinned is now
 * shared by every settings deep link (Atlas "Reconnect", the Release Notes
 * gear), so it is worth more here than it was there.
 */
describe("navigateToProjectSettingsTab", () => {
	afterEach(() => {
		sessionStorage.clear();
		vi.restoreAllMocks();
	});

	it("persists the sub-tab to sessionStorage BEFORE dispatching", () => {
		// Ordering is load-bearing: `ProjectSettings` reads the key in its
		// `useSettingsTab` initializer as it mounts, which the event triggers.
		let storedWhenEventFired: string | null = null;
		const handler = () => {
			storedWhenEventFired = sessionStorage.getItem(
				"fabric-project-settings-tab-p1",
			);
		};
		window.addEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, handler);

		navigateToProjectSettingsTab("p1", "development");

		expect(storedWhenEventFired).toBe("development");
		window.removeEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, handler);
	});

	it("dispatches once, carrying the project and the target sub-tab", () => {
		const received: NavigateToSettingsTabDetail[] = [];
		const handler = (event: Event) => {
			received.push(
				(event as CustomEvent<NavigateToSettingsTabDetail>).detail,
			);
		};
		window.addEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, handler);

		navigateToProjectSettingsTab("p1", "newsletter");

		expect(received).toEqual([
			{ projectId: "p1", settingsTab: "newsletter" },
		]);
		window.removeEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, handler);
	});

	// The original regression: the sub-tab was persisted to localStorage, which
	// leaked the selection across browser tabs. It must stay tab-scoped.
	it("writes to sessionStorage, never localStorage", () => {
		const localSpy = vi.spyOn(Storage.prototype, "setItem");

		navigateToProjectSettingsTab("p1", "development");

		expect(sessionStorage.getItem("fabric-project-settings-tab-p1")).toBe(
			"development",
		);
		expect(
			localStorage.getItem("fabric-project-settings-tab-p1"),
		).toBeNull();
		localSpy.mockRestore();
	});

	// A quota/private-mode failure must not swallow the navigation.
	it("still dispatches when sessionStorage throws", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("QuotaExceededError");
		});
		const handler = vi.fn();
		window.addEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, handler);

		expect(() =>
			navigateToProjectSettingsTab("p1", "development"),
		).not.toThrow();
		expect(handler).toHaveBeenCalledTimes(1);

		window.removeEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, handler);
	});
});
