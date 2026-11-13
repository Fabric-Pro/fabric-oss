import { describe, expect, it } from "vitest";
import {
	CONTRAST_PREFERENCES,
	DEFAULT_CONTRAST_PREFERENCE,
	isContrastPreference,
	resolveContrastPreference,
} from "../contrast-preference";

describe("contrast preference", () => {
	it("knows exactly the two preferences, standard by default", () => {
		expect(CONTRAST_PREFERENCES).toEqual(["standard", "high"]);
		expect(DEFAULT_CONTRAST_PREFERENCE).toBe("standard");
	});

	it("recognises only the exact strings", () => {
		expect(isContrastPreference("high")).toBe(true);
		expect(isContrastPreference("standard")).toBe(true);
		for (const value of [
			"HIGH",
			" high",
			"dark",
			"",
			null,
			undefined,
			1,
			{},
		]) {
			expect(isContrastPreference(value)).toBe(false);
		}
	});

	it("resolves a stored value without ever throwing", () => {
		expect(resolveContrastPreference("high")).toEqual({
			preference: "high",
			fallback: null,
		});
		expect(resolveContrastPreference("standard")).toEqual({
			preference: "standard",
			fallback: null,
		});
		for (const missing of [null, undefined, ""]) {
			expect(resolveContrastPreference(missing)).toEqual({
				preference: "standard",
				fallback: "missing",
			});
		}
		for (const unknown of ["ultra", "HIGH", 42, { high: true }]) {
			expect(resolveContrastPreference(unknown)).toEqual({
				preference: "standard",
				fallback: "unrecognized",
			});
		}
	});
});
