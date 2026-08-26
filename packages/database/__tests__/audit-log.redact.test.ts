/**
 * Unit tests for `redactSensitiveKeys`.
 *
 * Covers the cases enumerated in spec.md §13.1 -- nested objects, arrays
 * of objects, case-insensitive matching, partial substring matches,
 * value-not-key checks, and primitives at the top level.
 *
 * Run with: pnpm --filter @repo/database test __tests__/audit-log.redact.test.ts
 */

import { describe, expect, it } from "vitest";
import { redactSensitiveKeys } from "../prisma/queries/audit-log";

describe("redactSensitiveKeys", () => {
	it("redacts a top-level password key", () => {
		expect(redactSensitiveKeys({ password: "x" })).toEqual({
			password: "[REDACTED]",
		});
	});

	it("redacts a nested password key", () => {
		expect(redactSensitiveKeys({ user: { password: "x" } })).toEqual({
			user: { password: "[REDACTED]" },
		});
	});

	it("walks arrays of objects with non-sensitive parent key", () => {
		expect(
			redactSensitiveKeys({
				entries: [{ accessToken: "a" }, { idToken: "b" }],
			}),
		).toEqual({
			entries: [{ accessToken: "[REDACTED]" }, { idToken: "[REDACTED]" }],
		});
	});

	it("redacts the WHOLE value when parent key matches the denylist (conservative)", () => {
		// `tokens` matches the "token" substring; conservative redaction
		// replaces the entire value so a stray sub-field cannot leak
		// through a mistakenly named container key.
		expect(
			redactSensitiveKeys({
				tokens: [{ accessToken: "a" }, { idToken: "b" }],
			}),
		).toEqual({ tokens: "[REDACTED]" });
	});

	it("matches keys case-insensitively", () => {
		expect(
			redactSensitiveKeys({
				Password: "x",
				ACCESSTOKEN: "y",
				CookieJar: "z",
			}),
		).toEqual({
			Password: "[REDACTED]",
			ACCESSTOKEN: "[REDACTED]",
			CookieJar: "[REDACTED]",
		});
	});

	it("matches keys by substring (e.g. user_password_hash)", () => {
		expect(
			redactSensitiveKeys({
				user_password_hash: "abc",
				api_key_id: "k_123",
			}),
		).toEqual({
			user_password_hash: "[REDACTED]",
			api_key_id: "[REDACTED]",
		});
	});

	it("preserves non-sensitive keys whose VALUE looks sensitive", () => {
		expect(
			redactSensitiveKeys({
				note: "my password is x",
				message: "Bearer abc.def.ghi",
			}),
		).toEqual({
			note: "my password is x",
			message: "Bearer abc.def.ghi",
		});
	});

	it("passes primitives at the top level through untouched", () => {
		expect(redactSensitiveKeys("hello")).toBe("hello");
		expect(redactSensitiveKeys(42)).toBe(42);
		expect(redactSensitiveKeys(true)).toBe(true);
		expect(redactSensitiveKeys(null)).toBe(null);
		expect(redactSensitiveKeys(undefined)).toBeUndefined();
	});

	it("redacts every variant in the denylist", () => {
		const sensitiveSamples: Record<string, unknown> = {
			password: "x",
			passwd: "x",
			access_token: "x",
			refreshToken: "x",
			idToken: "x",
			bearerHeader: "x",
			apiKey: "x",
			my_api_key: "x",
			clientSecret: "x",
			secretShared: "x",
			cookieJar: "x",
			Authorization: "x",
			user_pin: "x",
			ccv: "ignored",
			ssn_last4: "x",
		};
		const out = redactSensitiveKeys(sensitiveSamples) as Record<
			string,
			unknown
		>;
		expect(out.password).toBe("[REDACTED]");
		expect(out.passwd).toBe("[REDACTED]");
		expect(out.access_token).toBe("[REDACTED]");
		expect(out.refreshToken).toBe("[REDACTED]");
		expect(out.idToken).toBe("[REDACTED]");
		expect(out.bearerHeader).toBe("[REDACTED]");
		expect(out.apiKey).toBe("[REDACTED]");
		expect(out.my_api_key).toBe("[REDACTED]");
		expect(out.clientSecret).toBe("[REDACTED]");
		expect(out.secretShared).toBe("[REDACTED]");
		expect(out.cookieJar).toBe("[REDACTED]");
		expect(out.Authorization).toBe("[REDACTED]");
		expect(out.user_pin).toBe("[REDACTED]");
		expect(out.ccv).toBe("ignored");
		expect(out.ssn_last4).toBe("[REDACTED]");
	});

	it("does not mutate the input object", () => {
		const input = { password: "x", nested: { token: "y" } };
		const snapshot = JSON.stringify(input);
		redactSensitiveKeys(input);
		expect(JSON.stringify(input)).toBe(snapshot);
	});

	it("handles deeply nested mixed structures", () => {
		const input = {
			data: {
				users: [
					{ name: "alice", password: "p1" },
					{ name: "bob", apiKey: "k1" },
				],
				meta: { version: 1, accessToken: "tok" },
			},
		};
		expect(redactSensitiveKeys(input)).toEqual({
			data: {
				users: [
					{ name: "alice", password: "[REDACTED]" },
					{ name: "bob", apiKey: "[REDACTED]" },
				],
				meta: { version: 1, accessToken: "[REDACTED]" },
			},
		});
	});
});
