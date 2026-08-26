import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	validateAuthBootEnv,
	validateRateLimitBootEnv,
} from "../boot-validate";

const originalEnv = { ...process.env };

function setEnv(overrides: Record<string, string | undefined>) {
	for (const [k, v] of Object.entries(overrides)) {
		if (v === undefined) {
			delete process.env[k];
		} else {
			process.env[k] = v;
		}
	}
}

describe("validateAuthBootEnv", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		process.env = { ...originalEnv };
	});
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("throws when CAPTCHA enabled but TURNSTILE_SECRET_KEY missing", () => {
		setEnv({
			NEXT_PUBLIC_ENABLE_CAPTCHA: "true",
			TURNSTILE_SECRET_KEY: undefined,
			NODE_ENV: "production",
		});
		expect(() => validateAuthBootEnv()).toThrow(
			/CAPTCHA enabled but TURNSTILE_SECRET_KEY missing/,
		);
	});

	it("does not throw when CAPTCHA disabled", () => {
		setEnv({
			NEXT_PUBLIC_ENABLE_CAPTCHA: "false",
			TURNSTILE_SECRET_KEY: undefined,
			NODE_ENV: "production",
			BETTER_AUTH_SECRET: "x".repeat(40),
		});
		expect(() => validateAuthBootEnv()).not.toThrow();
	});

	it("does not throw when CAPTCHA enabled and key present", () => {
		setEnv({
			NEXT_PUBLIC_ENABLE_CAPTCHA: "true",
			TURNSTILE_SECRET_KEY: "0xSECRET",
			NODE_ENV: "production",
			BETTER_AUTH_SECRET: "x".repeat(40),
		});
		expect(() => validateAuthBootEnv()).not.toThrow();
	});

	it("skips validation during next build phase", () => {
		setEnv({
			NEXT_PHASE: "phase-production-build",
			NEXT_PUBLIC_ENABLE_CAPTCHA: "true",
			TURNSTILE_SECRET_KEY: undefined,
			NODE_ENV: "production",
		});
		expect(() => validateAuthBootEnv()).not.toThrow();
	});

	it("throws in production when BETTER_AUTH_SECRET is unset", () => {
		setEnv({
			NEXT_PUBLIC_ENABLE_CAPTCHA: "false",
			NODE_ENV: "production",
			BETTER_AUTH_SECRET: undefined,
			AUTH_SECRET: undefined,
		});
		expect(() => validateAuthBootEnv()).toThrow(/BETTER_AUTH_SECRET/);
	});

	it("throws in production when BETTER_AUTH_SECRET is the known default", () => {
		setEnv({
			NEXT_PUBLIC_ENABLE_CAPTCHA: "false",
			NODE_ENV: "production",
			BETTER_AUTH_SECRET: "better-auth-secret-12345678901234567890",
		});
		expect(() => validateAuthBootEnv()).toThrow(/BETTER_AUTH_SECRET/);
	});

	it("throws in production when BETTER_AUTH_SECRET is too short (<32 chars)", () => {
		setEnv({
			NEXT_PUBLIC_ENABLE_CAPTCHA: "false",
			NODE_ENV: "production",
			BETTER_AUTH_SECRET: "short-secret",
		});
		expect(() => validateAuthBootEnv()).toThrow(/BETTER_AUTH_SECRET/);
	});

	it("does not throw in production with a strong BETTER_AUTH_SECRET", () => {
		setEnv({
			NEXT_PUBLIC_ENABLE_CAPTCHA: "false",
			NODE_ENV: "production",
			BETTER_AUTH_SECRET: "x".repeat(40),
		});
		expect(() => validateAuthBootEnv()).not.toThrow();
	});

	it("accepts AUTH_SECRET as the secret source in production", () => {
		setEnv({
			NEXT_PUBLIC_ENABLE_CAPTCHA: "false",
			NODE_ENV: "production",
			BETTER_AUTH_SECRET: undefined,
			AUTH_SECRET: "y".repeat(40),
		});
		expect(() => validateAuthBootEnv()).not.toThrow();
	});

	it("does not throw in development when BETTER_AUTH_SECRET is unset", () => {
		setEnv({
			NEXT_PUBLIC_ENABLE_CAPTCHA: "false",
			NODE_ENV: "development",
			BETTER_AUTH_SECRET: undefined,
			AUTH_SECRET: undefined,
		});
		expect(() => validateAuthBootEnv()).not.toThrow();
	});
});

describe("validateRateLimitBootEnv", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		process.env = { ...originalEnv };
	});
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("throws in production when Upstash creds missing", () => {
		setEnv({
			NODE_ENV: "production",
			UPSTASH_REDIS_REST_URL: undefined,
			UPSTASH_REDIS_REST_TOKEN: undefined,
		});
		expect(() => validateRateLimitBootEnv()).toThrow(
			/UPSTASH_REDIS_REST_URL/,
		);
	});

	it("does not throw in development when Upstash creds missing", () => {
		setEnv({
			NODE_ENV: "development",
			UPSTASH_REDIS_REST_URL: undefined,
			UPSTASH_REDIS_REST_TOKEN: undefined,
		});
		expect(() => validateRateLimitBootEnv()).not.toThrow();
	});

	it("does not throw in production when both creds present", () => {
		setEnv({
			NODE_ENV: "production",
			UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
			UPSTASH_REDIS_REST_TOKEN: "tok",
		});
		expect(() => validateRateLimitBootEnv()).not.toThrow();
	});

	it("skips validation during next build phase", () => {
		setEnv({
			NEXT_PHASE: "phase-production-build",
			NODE_ENV: "production",
			UPSTASH_REDIS_REST_URL: undefined,
			UPSTASH_REDIS_REST_TOKEN: undefined,
		});
		expect(() => validateRateLimitBootEnv()).not.toThrow();
	});
});
