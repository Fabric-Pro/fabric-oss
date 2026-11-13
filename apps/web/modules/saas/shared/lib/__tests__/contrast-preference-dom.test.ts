/**
 * The script that paints the high-contrast palette before the app hydrates
 * (Fizzy #1444), and the storage helpers it shares with the provider.
 *
 * jsdom does not run a script inserted with `dangerouslySetInnerHTML`, so the
 * script's text is evaluated directly — exactly what the browser runs while
 * parsing the page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyContrastPreference,
	clearUnsavedContrastPreference,
	contrastPreferenceBootstrapScript,
	readUnsavedContrastPreference,
	writeUnsavedContrastPreference,
} from "../contrast-preference-dom";

const UNSAVED_KEY = "fabric-contrast-unsaved";
const USER = "user_a";
const record = (preference: string, userId = USER) =>
	JSON.stringify({ userId, preference });
const html = () => document.documentElement;

/** Runs the exact text the page inlines, in global scope, as the parser does. */
function runScript(source: string) {
	new Function(source)();
}

beforeEach(() => {
	html().className = "";
	window.sessionStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
	html().className = "";
});

describe("contrastPreferenceBootstrapScript", () => {
	it("adds the class for an account that chose high contrast", () => {
		runScript(contrastPreferenceBootstrapScript("high", USER));
		expect(html()).toHaveClass("high-contrast");
	});

	it("leaves the standard palette for everyone else", () => {
		html().classList.add("high-contrast");
		runScript(contrastPreferenceBootstrapScript("standard", USER));
		expect(html()).not.toHaveClass("high-contrast");
	});

	it("prefers this tab's unsaved choice, as the provider will", () => {
		window.sessionStorage.setItem(UNSAVED_KEY, record("standard"));
		runScript(contrastPreferenceBootstrapScript("high", USER));
		expect(html()).not.toHaveClass("high-contrast");

		window.sessionStorage.setItem(UNSAVED_KEY, record("high"));
		runScript(contrastPreferenceBootstrapScript("standard", USER));
		expect(html()).toHaveClass("high-contrast");
	});

	it("ignores an unsaved choice another account left in the tab", () => {
		window.sessionStorage.setItem(UNSAVED_KEY, record("high", "user_b"));
		runScript(contrastPreferenceBootstrapScript("standard", USER));
		expect(html()).not.toHaveClass("high-contrast");
	});

	it("ignores an unsaved value it does not recognise", () => {
		for (const raw of ["<b>", "high", record("<b>"), "{"]) {
			window.sessionStorage.setItem(UNSAVED_KEY, raw);
			runScript(contrastPreferenceBootstrapScript("high", USER));
			expect(html(), raw).toHaveClass("high-contrast");
		}
	});

	it("still paints when session storage is unavailable", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new DOMException("blocked", "SecurityError");
		});
		runScript(contrastPreferenceBootstrapScript("high", USER));
		expect(html()).toHaveClass("high-contrast");
	});

	it("never touches the colour mode class (AC-12)", () => {
		html().classList.add("dark");
		runScript(contrastPreferenceBootstrapScript("high", USER));
		runScript(contrastPreferenceBootstrapScript("standard", USER));
		expect(html()).toHaveClass("dark");
	});

	it("cannot close its own script element", () => {
		for (const preference of ["high", "standard"] as const) {
			expect(
				contrastPreferenceBootstrapScript(preference, USER),
			).not.toMatch(/<\/?script/i);
			expect(
				contrastPreferenceBootstrapScript(preference, USER),
			).not.toContain("<");
		}
	});
});

describe("contrast preference DOM helpers", () => {
	it("toggles only the high-contrast class", () => {
		html().classList.add("dark", "font-sans");
		applyContrastPreference("high");
		expect(html()).toHaveClass("dark", "font-sans", "high-contrast");
		applyContrastPreference("standard");
		expect(html()).toHaveClass("dark", "font-sans");
		expect(html()).not.toHaveClass("high-contrast");
	});

	it("round-trips an unsaved choice for its own account and clears it", () => {
		expect(readUnsavedContrastPreference(USER)).toBeNull();
		writeUnsavedContrastPreference(USER, "high");
		expect(readUnsavedContrastPreference(USER)).toBe("high");
		expect(readUnsavedContrastPreference("user_b")).toBeNull();
		clearUnsavedContrastPreference();
		expect(readUnsavedContrastPreference(USER)).toBeNull();
	});

	it("reads an unrecognised stored value as nothing", () => {
		for (const raw of ["HIGH", "high", record("HIGH"), "{", "null"]) {
			window.sessionStorage.setItem(UNSAVED_KEY, raw);
			expect(readUnsavedContrastPreference(USER), raw).toBeNull();
		}
	});

	it("never throws when storage is blocked", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new DOMException("blocked", "SecurityError");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("blocked", "QuotaExceededError");
		});
		vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
			throw new DOMException("blocked", "SecurityError");
		});
		expect(readUnsavedContrastPreference(USER)).toBeNull();
		expect(() =>
			writeUnsavedContrastPreference(USER, "high"),
		).not.toThrow();
		expect(() => clearUnsavedContrastPreference()).not.toThrow();
	});
});
