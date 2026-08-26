import { afterEach, describe, expect, it } from "vitest";
import {
	isFunctionTagsEnabled,
	isLivingDocsRefreshEnabled,
	parseOptInFlag,
} from "./feature-flag";

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

describe("isLivingDocsRefreshEnabled", () => {
	const original = process.env.FABRIC_FEATURE_LIVING_DOCS_REFRESH;

	afterEach(() => {
		if (original === undefined) {
			delete process.env.FABRIC_FEATURE_LIVING_DOCS_REFRESH;
		} else {
			process.env.FABRIC_FEATURE_LIVING_DOCS_REFRESH = original;
		}
	});

	it("is off when the env var is unset", () => {
		delete process.env.FABRIC_FEATURE_LIVING_DOCS_REFRESH;
		expect(isLivingDocsRefreshEnabled()).toBe(false);
	});

	it("is off when the env var is explicitly false", () => {
		process.env.FABRIC_FEATURE_LIVING_DOCS_REFRESH = "false";
		expect(isLivingDocsRefreshEnabled()).toBe(false);
	});

	it("is on when the env var is true", () => {
		process.env.FABRIC_FEATURE_LIVING_DOCS_REFRESH = "true";
		expect(isLivingDocsRefreshEnabled()).toBe(true);
	});
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
