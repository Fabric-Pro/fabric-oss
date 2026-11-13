import {
	type ContrastPreference,
	HIGH_CONTRAST_CLASS,
	isContrastPreference,
	UNSAVED_CONTRAST_PREFERENCE_STORAGE_KEY,
} from "@repo/utils/contrast-preference";

/**
 * The browser half of the high-contrast theme (Fizzy #1444): the class on
 * `<html>`, and the per-tab record of a choice the server did not save.
 *
 * Only `HIGH_CONTRAST_CLASS` is ever touched. The colour mode's `.dark` class
 * and next-themes' own storage belong to a different control, and leaving them
 * alone is what keeps high contrast a modifier rather than a mode (AC-12).
 */

export function applyContrastPreference(preference: ContrastPreference): void {
	if (typeof document === "undefined") {
		return;
	}
	document.documentElement.classList.toggle(
		HIGH_CONTRAST_CLASS,
		preference === "high",
	);
}

/**
 * The record is `{ userId, preference }`, and is honoured only for the account
 * that wrote it. Sign out and in as someone else in the same tab and the
 * previous person's unsaved choice must neither paint the page nor — through
 * the provider's retry — be saved to the new account.
 */
type UnsavedRecord = { userId: string; preference: ContrastPreference };

/** Storage can be unavailable (private windows, blocked cookies): never throw. */
export function readUnsavedContrastPreference(
	userId: string,
): ContrastPreference | null {
	try {
		const raw = window.sessionStorage.getItem(
			UNSAVED_CONTRAST_PREFERENCE_STORAGE_KEY,
		);
		if (!raw) {
			return null;
		}
		const record = JSON.parse(raw) as Partial<UnsavedRecord> | null;
		return record?.userId === userId &&
			isContrastPreference(record.preference)
			? record.preference
			: null;
	} catch {
		return null;
	}
}

export function writeUnsavedContrastPreference(
	userId: string,
	preference: ContrastPreference,
): void {
	try {
		window.sessionStorage.setItem(
			UNSAVED_CONTRAST_PREFERENCE_STORAGE_KEY,
			JSON.stringify({ userId, preference } satisfies UnsavedRecord),
		);
	} catch {
		// Nothing to fall back to: the choice still holds for this page.
	}
}

export function clearUnsavedContrastPreference(): void {
	try {
		window.sessionStorage.removeItem(
			UNSAVED_CONTRAST_PREFERENCE_STORAGE_KEY,
		);
	} catch {
		// See writeUnsavedContrastPreference.
	}
}

/**
 * The script the server layout inlines so the first paint already has the
 * right palette. React applies the same class on mount, but that happens only
 * after the bundle has loaded and hydrated — long enough on this app for
 * someone who needs high contrast to read every full page load start in the
 * palette they turned off.
 *
 * An unsaved choice from this tab wins over the account's when it belongs to
 * the same account, matching what the provider does once it mounts. Every
 * value is a module constant, a member of a two-string union, or the user's id
 * (a cuid), serialised and `<`-escaped, so nothing here can close the script
 * element early.
 */
export function contrastPreferenceBootstrapScript(
	preference: ContrastPreference,
	userId: string,
): string {
	const config = JSON.stringify({
		preference,
		userId,
		className: HIGH_CONTRAST_CLASS,
		storageKey: UNSAVED_CONTRAST_PREFERENCE_STORAGE_KEY,
	}).replace(/</g, "\\u003c");
	return `(function(c){try{var p=c.preference;try{var r=JSON.parse(window.sessionStorage.getItem(c.storageKey)||"null");if(r&&r.userId===c.userId&&(r.preference==="high"||r.preference==="standard")){p=r.preference;}}catch(e){}document.documentElement.classList.toggle(c.className,p==="high");}catch(e){}})(${config});`;
}
