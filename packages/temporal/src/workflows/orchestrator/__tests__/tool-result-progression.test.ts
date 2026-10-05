import { describe, expect, it } from "vitest";
import {
	canonicalToolCallKey,
	extractContinuationFields,
	fingerprintObservation,
	fitPagedBodyReadArgs,
	formatContinuationNote,
	MAX_CONTINUATION_NOTE_CHARS,
	MAX_CONTINUATION_NOTE_HARD_CHARS,
	truncateWithinLimit,
} from "../tool-result-progression";

describe("fitPagedBodyReadArgs", () => {
	it("sets the cap when no page size was asked for", () => {
		expect(fitPagedBodyReadArgs({ document: "d" }, 8000)).toEqual({
			document: "d",
			maxLength: 8000,
		});
	});

	it("lowers a larger request and keeps a smaller one", () => {
		expect(
			fitPagedBodyReadArgs({ maxLength: 40_000 }, 8000).maxLength,
		).toBe(8000);
		expect(fitPagedBodyReadArgs({ maxLength: 2000 }, 8000).maxLength).toBe(
			2000,
		);
	});

	it("replaces a non-numeric or non-positive request with the cap", () => {
		expect(
			fitPagedBodyReadArgs({ maxLength: "40000" }, 8000).maxLength,
		).toBe(8000);
		expect(fitPagedBodyReadArgs({ maxLength: 0 }, 8000).maxLength).toBe(
			8000,
		);
	});

	it("keeps the offset the model asked for", () => {
		expect(fitPagedBodyReadArgs({ offset: 8000 }, 8000).offset).toBe(8000);
	});
});

describe("extractContinuationFields", () => {
	it("reads top-level and nested continuation keys from JSON text", () => {
		expect(
			extractContinuationFields(
				JSON.stringify({
					items: [1, 2],
					total: 40,
					pagination: { next_cursor: "c-2" },
				}),
				undefined,
			),
		).toEqual({ total: 40, "pagination.next_cursor": "c-2" });
	});

	it("falls back to the raw result when the text is not JSON", () => {
		expect(
			extractContinuationFields("plain text", {
				truncated: true,
				nextOffset: 8000,
			}),
		).toEqual({ truncated: true, nextOffset: 8000 });
	});

	it("returns null when nothing says how to continue", () => {
		expect(
			extractContinuationFields(
				JSON.stringify({ total: 3, items: [] }),
				{},
			),
		).toBeNull();
		expect(extractContinuationFields("not json", "text")).toBeNull();
	});
});

describe("canonicalToolCallKey and fingerprintObservation", () => {
	it("matches the same call whatever the key order, at every depth", () => {
		expect(
			canonicalToolCallKey("t", { a: 1, b: { c: 2, d: [1, 2] } }),
		).toBe(canonicalToolCallKey("t", { b: { d: [1, 2], c: 2 }, a: 1 }));
	});

	it("tells apart different names, args and array orders", () => {
		const base = canonicalToolCallKey("t", { a: [1, 2] });
		expect(canonicalToolCallKey("u", { a: [1, 2] })).not.toBe(base);
		expect(canonicalToolCallKey("t", { a: [2, 1] })).not.toBe(base);
	});

	it("fingerprints identical text identically and different text differently", () => {
		expect(fingerprintObservation("page one")).toBe(
			fingerprintObservation("page one"),
		);
		expect(fingerprintObservation("page one")).not.toBe(
			fingerprintObservation("page two"),
		);
		expect(fingerprintObservation("")).not.toBe(
			fingerprintObservation(" "),
		);
	});
});

describe("formatContinuationNote bounds", () => {
	it("drops position fields first and keeps continuation tokens whole", () => {
		const note = formatContinuationNote({
			nextCursor: "a".repeat(2_048),
			nextPageToken: "b".repeat(2_000),
			total: 10,
		});
		// Over the soft limit only because of the required tokens.
		expect(note.length).toBeGreaterThan(MAX_CONTINUATION_NOTE_CHARS);
		expect(note.length).toBeLessThanOrEqual(
			MAX_CONTINUATION_NOTE_HARD_CHARS,
		);
		expect(note).not.toContain('"total"');
		expect(note).toContain("a".repeat(2_048));
		expect(note).toContain("b".repeat(2_000));
	});

	it("marks the longest rendered token once the hard ceiling is reached", () => {
		const note = formatContinuationNote({
			nextCursor: "a".repeat(2_048),
			nextPageToken: "b".repeat(2_000),
			endCursor: '"'.repeat(2_000),
		});
		expect(note.length).toBeLessThanOrEqual(
			MAX_CONTINUATION_NOTE_HARD_CHARS,
		);
		// The quotes render at twice their length, so they go first.
		expect(note).toContain("too long to keep (2000 characters)");
		expect(note).toContain("a".repeat(2_048));
	});

	it("does not read objects nested deeper than one level", () => {
		expect(
			extractContinuationFields(
				JSON.stringify({ a: { b: { nextCursor: "deep" } } }),
				undefined,
			),
		).toBeNull();
	});
});

describe("truncateWithinLimit", () => {
	it("keeps text plus its marker within the limit", () => {
		for (const limit of [100, 9_999]) {
			const cut = truncateWithinLimit("x".repeat(50_000), limit);
			expect(cut.length).toBeLessThanOrEqual(limit);
			expect(cut).toContain("[TRUNCATED:");
		}
		// Too small for the marker: a plain cut, still within the limit.
		expect(truncateWithinLimit("x".repeat(50_000), 10)).toHaveLength(10);
		expect(truncateWithinLimit("short", 100)).toBe("short");
	});
});

describe("round 3 fix 3: canonicalJson and __proto__", () => {
	it("does not collide a __proto__ key with an empty object", async () => {
		const { canonicalJson } = await import("../tool-result-progression");
		const proto = JSON.parse('{"__proto__":{"x":1}}');
		expect(canonicalJson(proto)).not.toBe(canonicalJson({}));
		expect(canonicalToolCallKey("t", proto)).not.toBe(
			canonicalToolCallKey("t", {}),
		);
		expect(canonicalJson(proto)).toBe('{"__proto__":{"x":1}}');
	});
});
