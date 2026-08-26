import {
	DEV_VERSION,
	getAppVersion,
	isVersionCheckEnabled,
	parseVersionPayload,
} from "@shared/lib/app-version";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("getAppVersion", () => {
	it("returns the baked version when set", () => {
		vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "abc123");
		expect(getAppVersion()).toBe("abc123");
	});

	it("falls back to the dev sentinel when unset or empty", () => {
		vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "");
		expect(getAppVersion()).toBe(DEV_VERSION);
	});
});

describe("isVersionCheckEnabled", () => {
	it("is enabled only in production with a real version", () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "abc123");
		expect(isVersionCheckEnabled()).toBe(true);
	});

	it("is disabled for the dev sentinel even in production", () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("NEXT_PUBLIC_APP_VERSION", DEV_VERSION);
		expect(isVersionCheckEnabled()).toBe(false);
	});

	it("is disabled outside production", () => {
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "abc123");
		expect(isVersionCheckEnabled()).toBe(false);
	});
});

describe("parseVersionPayload", () => {
	it("parses a valid payload", () => {
		expect(parseVersionPayload({ version: "abc" })).toEqual({
			version: "abc",
		});
	});

	it("ignores unexpected extra fields", () => {
		expect(parseVersionPayload({ version: "abc", extra: 1 })).toEqual({
			version: "abc",
		});
	});

	it("rejects malformed payloads", () => {
		expect(parseVersionPayload(null)).toBeNull();
		expect(parseVersionPayload({})).toBeNull();
		expect(parseVersionPayload({ version: "" })).toBeNull();
		expect(parseVersionPayload({ version: 123 })).toBeNull();
		expect(parseVersionPayload("nope")).toBeNull();
	});
});
