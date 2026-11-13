/**
 * The high-contrast theme preference (Fizzy #1444).
 *
 * High contrast is a MODIFIER on the colour mode, not a third mode beside light
 * and dark: someone who needs stronger contrast still has a reason to prefer a
 * light or a dark page, and a third mode would make them give one up for the
 * other. So the two choices are stored and applied independently — the colour
 * mode stays where it always was (next-themes, per browser), and this one rides
 * on the account and adds a class next to `.dark` rather than replacing it.
 * Turning dark mode on or off while high contrast is on moves between the dark
 * and light high-contrast palettes; turning high contrast off returns to
 * whichever ordinary palette the colour mode selects.
 *
 * Kept free of imports so the API (validation), the server layout (first
 * paint) and the browser (the toggle) all read one list.
 */

export const CONTRAST_PREFERENCES = ["standard", "high"] as const;

export type ContrastPreference = (typeof CONTRAST_PREFERENCES)[number];

/** What renders when a person has never chosen, or chose something unreadable. */
export const DEFAULT_CONTRAST_PREFERENCE: ContrastPreference = "standard";

/** The class on `<html>` that switches the token set to the high-contrast one. */
export const HIGH_CONTRAST_CLASS = "high-contrast";

/**
 * A choice made in this tab that the server did not accept (AC-7).
 *
 * Session storage, not local storage: it has to survive a reload of the tab the
 * person is working in, but it is not the record of their preference — the
 * account is — and it must not outlive the tab and quietly override a choice
 * they later make on another device.
 */
export const UNSAVED_CONTRAST_PREFERENCE_STORAGE_KEY =
	"fabric-contrast-unsaved";

export function isContrastPreference(
	value: unknown,
): value is ContrastPreference {
	return (
		typeof value === "string" &&
		(CONTRAST_PREFERENCES as readonly string[]).includes(value)
	);
}

export type ContrastPreferenceResolution = {
	preference: ContrastPreference;
	/**
	 * Why the default was used instead of a stored value. `"missing"` is the
	 * ordinary case — almost nobody has chosen — and is not worth a log line;
	 * `"unrecognized"` means the column holds something this build cannot read,
	 * which someone should hear about (AC-6).
	 */
	fallback: "missing" | "unrecognized" | null;
};

/** Reads a stored value, never throwing: an unreadable one renders the default. */
export function resolveContrastPreference(
	stored: unknown,
): ContrastPreferenceResolution {
	if (stored === null || stored === undefined || stored === "") {
		return { preference: DEFAULT_CONTRAST_PREFERENCE, fallback: "missing" };
	}
	if (isContrastPreference(stored)) {
		return { preference: stored, fallback: null };
	}
	return {
		preference: DEFAULT_CONTRAST_PREFERENCE,
		fallback: "unrecognized",
	};
}
