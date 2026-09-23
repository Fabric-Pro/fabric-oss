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

/**
 * Anchors inside the Development sub-tab that other pages link straight to —
 * the capability gates' "Connect a repository" and "Turn on code search".
 */
export const REPOSITORY_SETTINGS_ANCHOR_ID = "project-repository-settings";
export const CODE_SEARCH_SETTINGS_ANCHOR_ID = "project-code-search-settings";
/** The project-management settings block — the gates' "Choose a board". */
export const PM_SETTINGS_ANCHOR_ID = "project-pm-settings";

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
	options?: {
		/**
		 * An element id inside the sub-tab to bring into view once it renders —
		 * for a caller that means one control on a long page, not its top.
		 */
		anchorId?: string;
	},
) {
	if (typeof window === "undefined") {
		return;
	}
	if (options?.anchorId) {
		scrollToWhenRendered(options.anchorId);
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

/** How long to wait for an anchor to render before giving up quietly. */
const ANCHOR_WAIT_MS = 3_000;

/**
 * Scroll an element into view as soon as it exists.
 *
 * The switch above is asynchronous — the settings tab and its sub-tab mount
 * on the next renders — so the anchor is usually not there yet when this is
 * called. Polled per frame for a bounded time; an anchor that never appears
 * (a sub-tab gated off for this viewer) leaves the viewer on the sub-tab.
 */
function scrollToWhenRendered(anchorId: string) {
	const deadline = Date.now() + ANCHOR_WAIT_MS;
	const attempt = () => {
		const element = document.getElementById(anchorId);
		if (element) {
			element.scrollIntoView({ block: "start" });
			return;
		}
		if (Date.now() < deadline) {
			window.requestAnimationFrame(attempt);
		}
	};
	window.requestAnimationFrame(attempt);
}
