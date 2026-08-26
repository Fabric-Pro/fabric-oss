/**
 * Unit tests for the Temporal payload size guard (Fizzy #1997).
 *
 * Run with:
 *   pnpm --filter @repo/temporal test src/lib/__tests__/payload-size-guard.test.ts
 */

import { describe, expect, it } from "vitest";
import {
	assertPayloadWithinLimit,
	classifyPayloadSize,
	measureSerializedBytes,
	PAYLOAD_HARD_LIMIT_BYTES,
	PAYLOAD_WARN_BYTES,
	PayloadTooLargeError,
	TEMPORAL_MAX_MESSAGE_BYTES,
} from "../payload-size-guard";

describe("constants", () => {
	it("hard budget sits under the gRPC frame with envelope headroom", () => {
		expect(TEMPORAL_MAX_MESSAGE_BYTES).toBe(4_194_304);
		expect(PAYLOAD_HARD_LIMIT_BYTES).toBeLessThan(
			TEMPORAL_MAX_MESSAGE_BYTES,
		);
		expect(PAYLOAD_WARN_BYTES).toBeLessThan(PAYLOAD_HARD_LIMIT_BYTES);
	});
});

describe("measureSerializedBytes", () => {
	it("counts ASCII at one byte per character", () => {
		const value = { title: "a".repeat(1000) };
		expect(measureSerializedBytes(value)).toBe(
			JSON.stringify(value).length,
		);
	});

	it("measures multibyte text as UTF-8, not UTF-16 units", () => {
		// {"t":"éééé"} is 12 UTF-16 units but 16 wire bytes ("é" = 2 in UTF-8).
		const value = { t: "éééé" };
		expect(JSON.stringify(value).length).toBe(12);
		expect(measureSerializedBytes(value)).toBe(16);

		// A supplementary-plane char ("😀") is 4 UTF-8 bytes per 2 UTF-16 units.
		const emoji = { t: "😀" };
		expect(measureSerializedBytes(emoji)).toBe(
			Buffer.byteLength(JSON.stringify(emoji), "utf8"),
		);
	});

	it("returns 0 for values that serialize to nothing", () => {
		expect(measureSerializedBytes(undefined)).toBe(0);
	});
});

describe("classifyPayloadSize", () => {
	it("classifies ok below the warn threshold", () => {
		expect(classifyPayloadSize(PAYLOAD_WARN_BYTES)).toBe("ok");
	});

	it("classifies warn between warn and hard limit", () => {
		expect(classifyPayloadSize(PAYLOAD_WARN_BYTES + 1)).toBe("warn");
	});

	it("classifies exceeds past the hard limit", () => {
		expect(classifyPayloadSize(PAYLOAD_HARD_LIMIT_BYTES + 1)).toBe(
			"exceeds",
		);
	});
});

describe("assertPayloadWithinLimit", () => {
	it("returns the measured byte count for an in-budget value", () => {
		const value = { items: ["x".repeat(100)] };
		expect(assertPayloadWithinLimit(value, "test boundary")).toBe(
			measureSerializedBytes(value),
		);
	});

	it("throws PayloadTooLargeError naming the boundary and sizes", () => {
		const oversized = {
			items: Array.from({ length: 200_000 }, (_, i) => ({
				id: String(i),
				description: "d".repeat(40),
			})),
		};
		expect(measureSerializedBytes(oversized)).toBeGreaterThan(
			PAYLOAD_HARD_LIMIT_BYTES,
		);

		let caught: unknown;
		try {
			assertPayloadWithinLimit(oversized, "fetchManyTickets result");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(PayloadTooLargeError);
		const tooLarge = caught as PayloadTooLargeError;
		expect(tooLarge.name).toBe("PAYLOAD_TOO_LARGE");
		expect(tooLarge.message).toContain("fetchManyTickets result");
		expect(tooLarge.message).toContain(String(tooLarge.bytes));
		expect(tooLarge.bytes).toBeGreaterThan(PAYLOAD_HARD_LIMIT_BYTES);
	});

	it("does not throw for a value just under the hard limit", () => {
		// A string whose JSON encoding lands a few KB under the budget.
		const pad = PAYLOAD_HARD_LIMIT_BYTES - 2048;
		const value = `"${"x".repeat(pad)}"`;
		expect(() =>
			assertPayloadWithinLimit(value, "under budget"),
		).not.toThrow();
	});
});
