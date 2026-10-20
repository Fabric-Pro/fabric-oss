import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
		vi.useRealTimers();
	});

	it("round-trips a payload", () => {
		const tok = signToken({ a: 1, b: "two" }, { ttlSec: 60 });
		const v = verifyToken<{ a: number; b: string }>(tok);
		expect(v.ok).toBe(true);
		if (v.ok) {
			expect(v.payload).toEqual({ a: 1, b: "two" });
		}
	});

	it("keeps the existing unpadded token bytes for every base64 padding length", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const encodeLegacy = (bytes: Buffer): string =>
			bytes
				.toString("base64")
				.split("+")
				.join("-")
				.split("/")
				.join("_")
				.split("=")[0];
		const paddingLengths = new Set<number>();
		for (let length = 0; length < 12; length++) {
			const payload = { text: `\u0fff${"x".repeat(length)}😀` };
			const body = Buffer.from(
				JSON.stringify({ p: payload, exp: 1767225660 }),
			);
			paddingLengths.add(body.length % 3);
			const head = encodeLegacy(body);
			const sig = createHmac(
				"sha256",
				"test-secret-32-chars-or-longer-aaaaaa",
			)
				.update(head)
				.digest();
			const legacyToken = `${head}.${encodeLegacy(sig)}`;
			expect(signToken(payload, { ttlSec: 60 })).toBe(legacyToken);
			expect(verifyToken(legacyToken)).toEqual({ ok: true, payload });
			expect(legacyToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		}
		expect(paddingLengths.size).toBe(3);
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
