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
/** Automatic screenshots, nested under the newsletter's "Images in highlights". */
export const NEWSLETTER_AUTO_CAPTURE_ANCHOR_ID =
	"project-newsletter-auto-capture";

/**
 * Whether Project Settings has its Environments sub-tab, where the
 * environments that QA and newsletter screenshots open are saved.
 * `NEXT_PUBLIC_*` is inlined at build time, so this is a constant.
 */
export const ENVIRONMENT_SETTINGS_ENABLED =
	process.env.NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES === "true";

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
		/** Also move keyboard focus to the anchor once it is in view. */
		focus?: boolean;
	},
) {
	if (typeof window === "undefined") {
		return;
	}
	if (options?.anchorId) {
		scrollToWhenRendered(options.anchorId, { focus: options.focus });
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
			{
				detail: { projectId, settingsTab },
			},
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
export function scrollToWhenRendered(
	anchorId: string,
	options?: { focus?: boolean },
) {
	const deadline = Date.now() + ANCHOR_WAIT_MS;
	const attempt = () => {
		const element =
			document.getElementById(anchorId) ??
			document.querySelector<HTMLElement>(
				`[data-onboarding-target="${anchorId}"]`,
			);
		if (element) {
			element.scrollIntoView({ block: "start" });
			if (options?.focus) {
				element.focus({ preventScroll: true });
			}
			return;
		}
		if (Date.now() < deadline) {
			window.requestAnimationFrame(attempt);
		}
	};
	window.requestAnimationFrame(attempt);
}
