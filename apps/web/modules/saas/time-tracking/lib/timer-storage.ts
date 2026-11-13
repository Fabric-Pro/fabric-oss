/**
 * What the timer widget keeps in the browser: a stopped timer's outcome for
 * this tab session (so "Saved" survives navigation until closed), and which
 * timers the reminder already fired for, shared by the browser's tabs.
 *
 * Storage can be blocked (private windows, site-data settings); every read
 * then answers "nothing stored" and every write is skipped.
 */

import {
	addRemindedTimer,
	parseRemindedTimers,
	parseSavedTimer,
	type SavedTimer,
} from "./timer-model";

const SAVED_KEY = "fabric:time-tracking:timer-saved";
const REMINDED_KEY = "fabric:time-tracking:timer-reminded";
const REMINDER_CHECK_KEY = "fabric:time-tracking:timer-reminder-check";

/** A tab skips the reminder check when another one checked this recently. */
const REMINDER_CHECK_SPACING_MS = 50_000;

export function readSavedTimer(organizationId: string): SavedTimer | null {
	try {
		const saved = parseSavedTimer(window.sessionStorage.getItem(SAVED_KEY));
		return saved?.organizationId === organizationId ? saved : null;
	} catch {
		return null;
	}
}

export function writeSavedTimer(saved: SavedTimer | null): void {
	try {
		if (saved) {
			window.sessionStorage.setItem(SAVED_KEY, JSON.stringify(saved));
		} else {
			window.sessionStorage.removeItem(SAVED_KEY);
		}
	} catch {
		// The outcome then lasts until the page reloads.
	}
}

function readRemindedTimers(): string[] {
	try {
		return parseRemindedTimers(window.localStorage.getItem(REMINDED_KEY));
	} catch {
		return [];
	}
}

export function wasReminded(timerId: string): boolean {
	return readRemindedTimers().includes(timerId);
}

export function rememberReminded(timerId: string): void {
	try {
		window.localStorage.setItem(
			REMINDED_KEY,
			JSON.stringify(addRemindedTimer(readRemindedTimers(), timerId)),
		);
	} catch {
		// Without storage this tab may remind again after a reload.
	}
}

/**
 * Take this minute's reminder check for this tab, unless another tab took it
 * recently. With storage blocked every tab checks for itself.
 */
export function claimReminderCheck(nowMs: number): boolean {
	try {
		const last = Number(window.localStorage.getItem(REMINDER_CHECK_KEY));
		if (Number.isFinite(last) && nowMs - last < REMINDER_CHECK_SPACING_MS) {
			return false;
		}
		window.localStorage.setItem(REMINDER_CHECK_KEY, String(nowMs));
		return true;
	} catch {
		return true;
	}
}
