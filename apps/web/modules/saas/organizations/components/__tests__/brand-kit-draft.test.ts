/**
 * The Brand kit form's draft: how it is read from a kit, when it holds an
 * edit, which family names a save accepts, and how the server's error codes
 * are recognized.
 */

import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import {
	type BrandKit,
	checkFamily,
	draftDiffers,
	draftFrom,
	errorDataCode,
	hasFontFile,
	isRejectionCode,
	isSaveErrorCode,
} from "../brand-kit/brand-kit-draft";

function kitOf(overrides: Partial<BrandKit> = {}): BrandKit {
	return {
		accentColors: ["#1a73e8"],
		guidance: "Plain, confident language.",
		updatedAt: new Date("2026-09-01T10:00:00.000Z"),
		primaryColor: "#0a2540",
		displayFontFamily: "Example Serif",
		bodyFontFamily: null,
		hasDisplayFontFile: true,
		hasBodyFontFile: false,
		heroUrl: null,
		website: "https://example.com",
		version: 4,
		siteFetch: null,
		...overrides,
	};
}

describe("draftFrom", () => {
	it("reads every field, with empty text for what the kit leaves unset", () => {
		expect(draftFrom(kitOf())).toEqual({
			primaryColor: ["#0a2540"],
			accentColors: ["#1a73e8"],
			displayFontFamily: "Example Serif",
			bodyFontFamily: "",
			website: "https://example.com",
			guidance: "Plain, confident language.",
			assets: {
				hero: { action: "keep" },
				displayFont: { action: "keep" },
				bodyFont: { action: "keep" },
			},
		});
	});

	it("leaves the primary empty when the kit has none", () => {
		expect(draftFrom(kitOf({ primaryColor: null })).primaryColor).toEqual(
			[],
		);
	});
});

describe("draftDiffers", () => {
	const base = kitOf();

	it("is false for the draft read from the kit", () => {
		expect(draftDiffers(draftFrom(base), base)).toBe(false);
	});

	it("is false for an entry that only normalizes to the stored one", () => {
		const draft = {
			...draftFrom(kitOf({ accentColors: ["#aabbcc"] })),
			accentColors: ["#ABC"],
			guidance: "  Plain, confident language.  ",
			website: "https://example.com ",
		};

		expect(draftDiffers(draft, kitOf({ accentColors: ["#aabbcc"] }))).toBe(
			false,
		);
	});

	it.each([
		{
			name: "a new accent",
			change: { accentColors: ["#1a73e8", "#0d9488"] },
		},
		{ name: "a malformed accent", change: { accentColors: ["#12345g"] } },
		{ name: "a cleared primary", change: { primaryColor: [] } },
		{
			name: "a body font family",
			change: { bodyFontFamily: "Example Sans" },
		},
		{ name: "a cleared website", change: { website: "" } },
		{ name: "edited guidance", change: { guidance: "Short sentences." } },
	])("is true for $name", ({ change }) => {
		expect(draftDiffers({ ...draftFrom(base), ...change }, base)).toBe(
			true,
		);
	});

	it.each([
		{ name: "a removed file", asset: { action: "remove" as const } },
		{
			name: "a replaced file",
			asset: {
				action: "replace" as const,
				token: "upload-token-1",
				fileName: "cover.png",
				previewUrl: null,
			},
		},
	])("is true for $name", ({ asset }) => {
		const draft = draftFrom(base);

		expect(
			draftDiffers(
				{ ...draft, assets: { ...draft.assets, hero: asset } },
				base,
			),
		).toBe(true);
	});
});

describe("checkFamily", () => {
	it("accepts no family while there is no file to load under it", () => {
		expect(checkFamily("  ", false)).toEqual({ family: null, error: null });
	});

	it("asks for a family when a file needs one", () => {
		expect(checkFamily("", true)).toEqual({
			family: null,
			error: "fontFamilyRequired",
		});
	});

	it("collapses whitespace the way the theme writes the name", () => {
		expect(checkFamily(" Example  Display ", false)).toEqual({
			family: "Example Display",
			error: null,
		});
	});

	it("refuses a name the theme cannot write", () => {
		expect(checkFamily("Bad;Font", false)).toEqual({
			family: null,
			error: "fontFamilyInvalid",
		});
	});
});

describe("hasFontFile", () => {
	it.each([
		{ action: "keep" as const, stored: true, expected: true },
		{ action: "keep" as const, stored: false, expected: false },
		{ action: "remove" as const, stored: true, expected: false },
	])(
		"is $expected for $action with a stored file: $stored",
		({ action, stored, expected }) => {
			expect(hasFontFile({ action }, stored)).toBe(expected);
		},
	);

	it("is true for a replaced file whether or not one is stored", () => {
		expect(
			hasFontFile(
				{
					action: "replace",
					token: "upload-token-1",
					fileName: "example-sans.woff2",
					previewUrl: null,
				},
				false,
			),
		).toBe(true);
	});
});

describe("the error codes", () => {
	it("reads the code a BAD_REQUEST carries, and nothing from other errors", () => {
		expect(
			errorDataCode(
				new ORPCError("BAD_REQUEST", {
					data: { code: "invalidWebsite" },
				}),
			),
		).toBe("invalidWebsite");
		expect(errorDataCode(new ORPCError("CONFLICT"))).toBeUndefined();
		expect(
			errorDataCode(
				new DOMException("The operation timed out.", "TimeoutError"),
			),
		).toBeUndefined();
	});

	it("tells a save's codes apart from an upload's", () => {
		expect(isSaveErrorCode("invalidWebsite")).toBe(true);
		expect(isSaveErrorCode("too_large")).toBe(false);
		expect(isRejectionCode("too_large")).toBe(true);
		expect(isRejectionCode("invalidWebsite")).toBe(false);
		expect(isRejectionCode(undefined)).toBe(false);
	});
});
