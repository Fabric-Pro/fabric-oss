import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { signToken, verifyToken } from "../signed-token";

describe("signed-token", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env = {
			...originalEnv,
			BETTER_AUTH_SECRET: "test-secret-32-chars-or-longer-aaaaaa",
		};
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("round-trips a payload", () => {
		const tok = signToken({ a: 1, b: "two" }, { ttlSec: 60 });
		const v = verifyToken<{ a: number; b: string }>(tok);
		expect(v.ok).toBe(true);
		if (v.ok) {
			expect(v.payload).toEqual({ a: 1, b: "two" });
		}
	});

	it("rejects tampered payload", () => {
		const tok = signToken({ a: 1 }, { ttlSec: 60 });
		const [head, sig] = tok.split(".");
		const tampered = `${head.slice(0, -1)}X.${sig}`;
		expect(verifyToken(tampered).ok).toBe(false);
	});

	it("rejects expired token", () => {
		const tok = signToken({ a: 1 }, { ttlSec: -1 });
		expect(verifyToken(tok).ok).toBe(false);
	});

	it("rejects bad signature", () => {
		const tok = signToken({ a: 1 }, { ttlSec: 60 });
		const [head] = tok.split(".");
		expect(verifyToken(`${head}.deadbeef`).ok).toBe(false);
	});
});
