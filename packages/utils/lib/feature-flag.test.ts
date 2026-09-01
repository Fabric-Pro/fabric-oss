import { afterEach, describe, expect, it } from "vitest";
import { isFunctionTagsEnabled, parseOptInFlag } from "./feature-flag";

describe("parseOptInFlag", () => {
	it("defaults to disabled when unset", () => {
		expect(parseOptInFlag(undefined)).toBe(false);
	});

	it.each(["true", "1", "on", "yes", "TRUE", "  Yes  "])(
		"enables on %j",
		(raw) => {
			expect(parseOptInFlag(raw)).toBe(true);
		},
	);

	it.each(["false", "0", "off", "no", "", "maybe", "enabled"])(
		"stays disabled on %j",
		(raw) => {
			expect(parseOptInFlag(raw)).toBe(false);
		},
	);
});

describe("isFunctionTagsEnabled", () => {
	const KEY = "FABRIC_FEATURE_FUNCTION_TAGS";
	afterEach(() => {
		delete process.env[KEY];
	});
	it("defaults to false when unset", () => {
		delete process.env[KEY];
		expect(isFunctionTagsEnabled()).toBe(false);
	});
	it("is false for arbitrary values", () => {
		process.env[KEY] = "maybe";
		expect(isFunctionTagsEnabled()).toBe(false);
	});
	it("is true only for opt-in values", () => {
		process.env[KEY] = "true";
		expect(isFunctionTagsEnabled()).toBe(true);
	});
});
