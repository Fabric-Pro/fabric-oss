import { describe, expect, it } from "vitest";
import { cutAtCodeUnits } from "../lib/cut-at-code-units";
import { fnv1a, fnv1aHex64 } from "../lib/fnv1a";

describe("fnv1a", () => {
	it("is the standard 32-bit FNV-1a with the offset basis as seed", () => {
		expect(fnv1a("", 0x811c9dc5)).toBe(0x811c9dc5);
		expect(fnv1a("a", 0x811c9dc5)).toBe(0xe40c292c);
		expect(fnv1a("foobar", 0x811c9dc5)).toBe(0xbf9cf968);
	});

	it("diverges for a different seed", () => {
		expect(fnv1a("foobar", 0x9e3779b9)).not.toBe(
			fnv1a("foobar", 0x811c9dc5),
		);
	});
});

describe("fnv1aHex64", () => {
	it("returns sixteen lowercase hex characters, stable per input", () => {
		const hash = fnv1aHex64("Scope of work");
		expect(hash).toMatch(/^[0-9a-f]{16}$/);
		expect(fnv1aHex64("Scope of work")).toBe(hash);
		expect(fnv1aHex64("Scope of work.")).not.toBe(hash);
	});

	it("starts with the padded offset-basis pass", () => {
		expect(fnv1aHex64("").slice(0, 8)).toBe("811c9dc5");
	});
});

describe("cutAtCodeUnits", () => {
	it("returns text that fits unchanged", () => {
		expect(cutAtCodeUnits("short", 5)).toBe("short");
		expect(cutAtCodeUnits("", 3)).toBe("");
	});

	it("cuts to the limit in UTF-16 code units", () => {
		expect(cutAtCodeUnits("abcdef", 4)).toBe("abcd");
	});

	it("never splits a surrogate pair", () => {
		// "a😀b": the emoji is two code units at positions 1 and 2.
		expect(cutAtCodeUnits("a😀b", 2)).toBe("a");
		expect(cutAtCodeUnits("a😀b", 3)).toBe("a😀");
	});
});
