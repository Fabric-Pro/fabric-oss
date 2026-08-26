/**
 * Client-side deep link into an in-page Project Settings sub-tab.
 *
 * There is no settings route — Project Settings is an in-page tab owned by
 * `ProjectDetails` (top-level `activeTab`) and `ProjectSettings` (the sub-tab,
 * persisted to sessionStorage). Callers render deep inside other tab subtrees,
 * far from `ProjectDetails`, so the two are bridged with a window `CustomEvent`
 * rather than threading a setter through every intermediate component.
 *
 * Flow: write the sub-tab key FIRST (so `ProjectSettings`' `useSettingsTab`
 * reads it when it mounts), then dispatch the event so `ProjectDetails`
 * switches its top-level tab to `"settings"`.
 */
import type { SettingsTab } from "./ProjectSettingsNav";

export const NAVIGATE_TO_SETTINGS_TAB_EVENT =
	"fabric:project-navigate-to-settings-tab";

/** Mirrors `STORAGE_KEY_PREFIX` in `ProjectSettings.tsx`. */
const SETTINGS_TAB_STORAGE_KEY_PREFIX = "fabric-project-settings-tab-";

export type NavigateToSettingsTabDetail = {
	projectId: string;
	settingsTab: SettingsTab;
};

/**
 * Open the given Project Settings sub-tab. Pure client-side — no reload, no
 * route change. A sessionStorage failure (private mode / quota) must NOT block
 * the switch, so the event fires either way and the click never silently no-ops.
 */
export function navigateToProjectSettingsTab(
	projectId: string,
	settingsTab: SettingsTab,
) {
	if (typeof window === "undefined") {
		return;
	}
	try {
		sessionStorage.setItem(
			`${SETTINGS_TAB_STORAGE_KEY_PREFIX}${projectId}`,
			settingsTab,
		);
	} catch {
		// ignore — the event below still switches the top-level tab.
	}
	window.dispatchEvent(
		new CustomEvent<NavigateToSettingsTabDetail>(
			NAVIGATE_TO_SETTINGS_TAB_EVENT,
			{ detail: { projectId, settingsTab } },
		),
	);
}
